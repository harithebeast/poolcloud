import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../auth/auth.controller.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { FsService, type NodeRow } from '../fs/fs.service.js';
import { FilesService } from './files.service.js';
import { contentDisposition, isPreviewable, mimeFor, parseRange } from './mime.js';

/** What clients see of a node. Key material and storage placement never leave the server. */
export function toDto(n: NodeRow, unavailable = false) {
  return {
    unavailable,
    id: n.id,
    parentId: n.parentId,
    type: n.type,
    name: n.name,
    size: n.size,
    mime: n.mime,
    encrypted: n.encrypted,
    encryptByDefault: n.encryptByDefault,
    trashedAt: n.trashedAt,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

const uuid = z.uuid();
const folderBody = z.object({
  parentId: uuid.nullable().default(null),
  name: z.string().max(1000),
});
const patchBody = z
  .object({
    name: z.string().max(1000).optional(),
    parentId: uuid.nullable().optional(),
    encryptByDefault: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

function id(raw: string): string {
  const r = uuid.safeParse(raw);
  if (!r.success) throw new BadRequestException('Invalid id');
  return r.data;
}

@ApiTags('files')
@Controller()
export class FilesController {
  constructor(
    private readonly fs: FsService,
    private readonly files: FilesService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Get('files')
  async list(@Req() req: AuthedRequest, @Query('parentId') parentId?: string) {
    const items = await this.fs.list(req.auth!.user.id, parentId ? id(parentId) : null);
    return { items: await this.withAvailability(items) };
  }

  @Get('files/search')
  async search(@Req() req: AuthedRequest, @Query('q') q = '') {
    const found = await this.fs.search(req.auth!.user.id, q.slice(0, 200));
    return { items: await this.withAvailability(found) };
  }

  @Get('files/:id')
  async get(@Req() req: AuthedRequest, @Param('id') raw: string) {
    const owner = req.auth!.user.id;
    const node = await this.fs.get(owner, id(raw));
    const [dto] = await this.withAvailability([node]);
    // Which Gmail holds a file is shown to the admin only; other users just see their files.
    const storedIn =
      req.auth!.user.role === 'admin' && node.type === 'file'
        ? await this.files.locations(node.id)
        : undefined;
    return { node: dto, path: await this.fs.breadcrumbs(owner, node.id), storedIn };
  }

  @Post('folders')
  async createFolder(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = parseBody(folderBody, body);
    return toDto(await this.fs.createFolder(req.auth!.user.id, b.parentId, b.name));
  }

  @Patch('files/:id')
  async update(@Req() req: AuthedRequest, @Param('id') raw: string, @Body() body: unknown) {
    const owner = req.auth!.user.id;
    const nodeId = id(raw);
    const b = parseBody(patchBody, body);
    let node = await this.fs.get(owner, nodeId);
    if (b.name !== undefined) node = await this.fs.rename(owner, nodeId, b.name);
    if (b.parentId !== undefined) node = await this.fs.move(owner, nodeId, b.parentId);
    if (b.encryptByDefault !== undefined)
      node = await this.fs.setEncryptByDefault(owner, nodeId, b.encryptByDefault);
    return toDto(node);
  }

  /** Delete = move to the trash. Nothing is destroyed until the trash is purged. */
  @Delete('files/:id')
  @HttpCode(204)
  async trash(@Req() req: AuthedRequest, @Param('id') raw: string) {
    await this.fs.trash(req.auth!.user.id, id(raw));
  }

  /**
   * Streaming upload: the request body IS the file (`Content-Type: application/octet-stream`).
   * Retrying with the same `Idempotency-Key` never creates a duplicate.
   */
  @Post('files/upload')
  async upload(
    @Req() req: AuthedRequest,
    @Query('name') name?: string,
    @Query('parentId') parentId?: string,
    @Query('encrypt') encrypt?: string,
  ) {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new BadRequestException('Idempotency-Key header (8-128 characters) is required');
    }
    const length = req.headers['content-length'];
    const size = length === undefined ? NaN : Number(length);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new BadRequestException('Content-Length is required');
    }
    if (!name) throw new BadRequestException('name is required');
    const node = await this.files.upload({
      ownerId: req.auth!.user.id,
      idempotencyKey: key,
      parentId: parentId ? id(parentId) : null,
      name,
      size,
      encrypt: encrypt === undefined ? undefined : encrypt === 'true' || encrypt === '1',
      source: req.body as Readable,
    });
    return toDto(node);
  }

  /** Download or preview. Supports `Range` for whole, unencrypted files. */
  @Get('files/:id/content')
  async content(
    @Req() req: AuthedRequest,
    @Res() reply: FastifyReply,
    @Param('id') raw: string,
    @Query('download') download?: string,
  ) {
    const owner = req.auth!.user.id;
    const nodeId = id(raw);
    const node = await this.fs.get(owner, nodeId);
    const rangeHeader = req.headers.range;
    const range = parseRange(rangeHeader, node.size);
    if (range === 'invalid') {
      return reply
        .status(416)
        .header('content-range', `bytes */${node.size}`)
        .send({ statusCode: 416, code: 'range_not_satisfiable', message: 'Invalid range' });
    }

    const opened = await this.files.open(owner, nodeId, range ?? undefined);
    return sendFile(reply, opened.node, opened.stream, {
      range: opened.range,
      acceptRanges: opened.supportsRange,
      attachment: download === '1' || download === 'true',
      embedOrigin: this.cfg.WEB_ORIGIN,
    });
  }

  private async withAvailability(nodes: NodeRow[]) {
    const bad = await this.files.unavailable(
      nodes.filter((n) => n.type === 'file').map((n) => n.id),
    );
    return nodes.map((n) => toDto(n, bad.has(n.id)));
  }

  // ── Trash ────────────────────────────────────────────────────────────────────────────────────

  @Get('trash')
  async listTrash(@Req() req: AuthedRequest) {
    return { items: (await this.fs.listTrash(req.auth!.user.id)).map((n) => toDto(n)) };
  }

  @Post('trash/:id/restore')
  async restore(@Req() req: AuthedRequest, @Param('id') raw: string) {
    return toDto(await this.fs.restore(req.auth!.user.id, id(raw)));
  }

  @Delete('trash/:id')
  async purge(@Req() req: AuthedRequest, @Param('id') raw: string) {
    return this.fs.purge(req.auth!.user.id, id(raw));
  }

  @Delete('trash')
  async emptyTrash(@Req() req: AuthedRequest) {
    return this.fs.emptyTrash(req.auth!.user.id);
  }
}

/** Shared by owner downloads and public share links. */
export async function sendFile(
  reply: FastifyReply,
  node: NodeRow,
  stream: Readable,
  opts: {
    range?: { start: number; end: number };
    acceptRanges: boolean;
    attachment: boolean;
    /** The web app's origin: the only page allowed to embed this response (previews). */
    embedOrigin: string;
  },
): Promise<void> {
  const mime = node.mime ?? mimeFor(node.name);
  const inline = !opts.attachment && isPreviewable(mime);
  const length = opts.range ? opts.range.end - opts.range.start + 1 : node.size;

  reply
    .status(opts.range ? 206 : 200)
    .header('content-type', inline ? mime : 'application/octet-stream')
    .header('content-length', length)
    .header('content-disposition', contentDisposition(node.name, inline))
    .header('accept-ranges', opts.acceptRanges ? 'bytes' : 'none')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', contentSecurityPolicy(mime, inline, opts.embedOrigin))
    // The web app (another origin on the same site) shows these in <img>/<iframe>/<video>.
    .header('cross-origin-resource-policy', 'same-site')
    .header('cache-control', 'private, no-store');
  reply.removeHeader('x-frame-options'); // superseded by frame-ancestors below
  if (opts.range) {
    reply.header('content-range', `bytes ${opts.range.start}-${opts.range.end}/${node.size}`);
  }

  // Hijack so a mid-stream integrity failure aborts the connection instead of sending a 500 body
  // after bytes have already gone out.
  reply.hijack();
  const res = reply.raw;
  res.writeHead(reply.statusCode, reply.getHeaders() as Record<string, string>);
  try {
    await pipeline(stream, res);
  } catch {
    res.destroy();
  }
}

/**
 * Locked-down policy for served files: no script, no network. Everything renders in a sandbox except
 * PDFs, whose built-in viewer does not run under `sandbox`; a PDF is still script-free here and can
 * only be framed by the web app.
 */
export function contentSecurityPolicy(mime: string, inline: boolean, embedOrigin: string): string {
  const base = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; frame-ancestors ${embedOrigin}`;
  return inline && mime === 'application/pdf' ? base : `sandbox; ${base}`;
}
