import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../auth/auth.controller.js';
import { Public, type AuthedRequest } from '../auth/auth.guard.js';
import { LoginThrottle } from '../auth/throttle.js';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { sendFile } from '../files/files.controller.js';
import { FilesService } from '../files/files.service.js';
import { parseRange } from '../files/mime.js';
import {
  SharePasswordError,
  ShareUnavailableError,
  SharesService,
  type ShareRow,
} from './shares.service.js';

const createBody = z.object({
  nodeId: z.uuid(),
  expiresAt: z.coerce.date().nullable().optional(),
  password: z.string().min(4).max(256).nullable().optional(),
});

const view = (s: ShareRow) => ({
  id: s.id,
  nodeId: s.nodeId,
  expiresAt: s.expiresAt,
  passwordProtected: Boolean(s.passwordHash),
  downloadCount: s.downloadCount,
  revokedAt: s.revokedAt,
  createdAt: s.createdAt,
});

/** Owner-side management of share links. */
@ApiTags('shares')
@Controller('shares')
export class SharesController {
  constructor(
    private readonly shares: SharesService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = parseBody(createBody, body);
    try {
      const { token, share } = await this.shares.create(req.auth!.user.id, b);
      // The only time the raw token is ever returned.
      return { ...view(share), url: new URL(`/s/${token}`, this.cfg.WEB_ORIGIN).toString() };
    } catch (e) {
      if (e instanceof RangeError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Get()
  async list(@Req() req: AuthedRequest, @Query('nodeId') nodeId?: string) {
    return { items: (await this.shares.list(req.auth!.user.id, nodeId)).map(view) };
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException('Invalid id');
    await this.shares.revoke(req.auth!.user.id, id);
  }
}

const unlockBody = z.object({ password: z.string().max(256).optional() });

/** Unauthenticated access to a shared file. Every response for a bad token is the same 404. */
@ApiTags('public')
@Public()
@Controller('public/shares')
export class PublicSharesController {
  constructor(
    private readonly shares: SharesService,
    private readonly files: FilesService,
    private readonly throttle: LoginThrottle,
  ) {}

  private async resolve(token: string) {
    try {
      return await this.shares.resolve(token);
    } catch (e) {
      if (e instanceof ShareUnavailableError) throw new NotFoundException(e.message);
      throw e;
    }
  }

  @Get(':token')
  async info(@Param('token') token: string) {
    const { share, node } = await this.resolve(token);
    return {
      name: node.name,
      size: node.size,
      mime: node.mime,
      passwordProtected: Boolean(share.passwordHash),
      expiresAt: share.expiresAt,
    };
  }

  @Post(':token/unlock')
  @HttpCode(200)
  async unlock(@Param('token') token: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const { password } = parseBody(unlockBody, body ?? {});
    if (!(await this.throttle.allow(req.ip, `share:${token.slice(0, 12)}`))) {
      throw new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      return { access: await this.shares.unlock(token, password) };
    } catch (e) {
      if (e instanceof ShareUnavailableError) throw new NotFoundException(e.message);
      if (e instanceof SharePasswordError) throw new UnauthorizedException(e.message);
      throw e;
    }
  }

  /** Streams through the API: the visitor never learns which Google accounts hold the data. */
  @Get(':token/content')
  async content(
    @Param('token') token: string,
    @Req() req: AuthedRequest,
    @Res() reply: FastifyReply,
    @Query('access') access?: string,
    @Query('download') download?: string,
  ) {
    const resolved = await this.resolve(token);
    try {
      this.shares.assertAccess(resolved, access);
    } catch (e) {
      if (e instanceof SharePasswordError) throw new UnauthorizedException(e.message);
      throw e;
    }
    const range = parseRange(req.headers.range, resolved.node.size);
    if (range === 'invalid') {
      return reply.status(416).header('content-range', `bytes */${resolved.node.size}`).send();
    }
    const opened = await this.files.open(
      resolved.share.ownerId,
      resolved.node.id,
      range ?? undefined,
    );
    // Count a download once per full fetch (not for each range request of a media player).
    if (!range || range.start === 0) await this.shares.recordDownload(resolved.share.id);
    return sendFile(reply, opened.node, opened.stream, {
      range: opened.range,
      acceptRanges: opened.supportsRange,
      attachment: download === '1' || download === 'true',
    });
  }
}
