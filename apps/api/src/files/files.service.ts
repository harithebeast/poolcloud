import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { fileChunks, nodes, uploads } from '../db/schema.js';
import {
  FsService,
  NameConflictError,
  NotFoundError,
  validateName,
  type NodeRow,
} from '../fs/fs.service.js';
import type { DownloadService } from '../storage/download-service.js';
import type { ByteRange } from '../storage/provider.js';
import type { StoredFile, UploadService } from '../storage/upload-service.js';
import { mimeFor } from './mime.js';

export class UploadInProgressError extends Error {
  constructor() {
    super('An upload with this idempotency key is already in progress');
  }
}
export class IdempotencyMismatchError extends Error {
  constructor() {
    super('This idempotency key was already used for a different upload');
  }
}

export interface UploadRequest {
  ownerId: string;
  idempotencyKey: string;
  parentId: string | null;
  name: string;
  size: number;
  /** Explicit choice; otherwise the parent folder's setting decides. */
  encrypt?: boolean;
  source: AsyncIterable<Buffer | string>;
}

export interface OpenedFile {
  node: NodeRow;
  stream: Readable;
  /** Set when a range was served. */
  range?: ByteRange;
  supportsRange: boolean;
}

const isUnique = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === '23505';
};

/**
 * Glue between HTTP, the metadata database and the storage core. The storage core never touches
 * Postgres tables for files; this class persists the result atomically in `commit`.
 */
export class FilesService {
  constructor(
    private readonly deps: {
      db: Db;
      fs: FsService;
      uploads: UploadService;
      downloads: DownloadService;
      /** How long an open upload blocks a retry with the same key (covers a crashed server). */
      inProgressMs?: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Store a file. Retrying with the same idempotency key never creates a duplicate. */
  async upload(req: UploadRequest): Promise<NodeRow> {
    const { fs } = this.deps;
    const name = validateName(req.name);
    let encrypt = req.encrypt;
    if (req.parentId) {
      const parent = await fs.get(req.ownerId, req.parentId);
      if (parent.type !== 'folder' || parent.trashedAt) throw new NotFoundError('Folder');
      encrypt ??= parent.encryptByDefault;
    }
    encrypt ??= false;

    // Claim first: a retry of a finished upload must return that file, not trip the name check.
    const prior = await this.claim(req, name, encrypt);
    if (prior) return prior;
    try {
      await this.assertNameFree(req.ownerId, req.parentId, name);
    } catch (err) {
      await this.finish(req, 'failed').catch(() => undefined);
      throw err;
    }

    const fileId = randomUUID();
    try {
      await this.deps.uploads.store(
        { ownerId: req.ownerId, fileId, source: req.source, size: req.size, encrypt },
        (file) => this.commit(req, name, encrypt, file),
      );
    } catch (err) {
      await this.finish(req, 'failed').catch(() => undefined);
      if (isUnique(err)) throw new NameConflictError(name);
      throw err;
    }
    return fs.get(req.ownerId, fileId);
  }

  /** Returns the finished node if this key already completed; throws if it is running or mismatched. */
  private async claim(req: UploadRequest, name: string, encrypt: boolean): Promise<NodeRow | null> {
    const { db } = this.deps;
    const expiresAt = new Date(this.now() + (this.deps.inProgressMs ?? 30 * 60_000));
    const inserted = await db
      .insert(uploads)
      .values({
        ownerId: req.ownerId,
        idempotencyKey: req.idempotencyKey,
        parentId: req.parentId,
        name,
        size: req.size,
        encrypted: encrypt,
        state: 'open',
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: uploads.id });
    if (inserted.length > 0) return null;

    const [existing] = await db
      .select()
      .from(uploads)
      .where(and(eq(uploads.ownerId, req.ownerId), eq(uploads.idempotencyKey, req.idempotencyKey)));
    if (!existing) return this.claim(req, name, encrypt); // deleted between the two statements
    if (
      existing.name !== name ||
      existing.size !== req.size ||
      (existing.parentId ?? null) !== (req.parentId ?? null)
    ) {
      throw new IdempotencyMismatchError();
    }
    const nodeId = (existing.plan as { nodeId?: string } | null)?.nodeId;
    if (existing.state === 'done' && nodeId) {
      const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
      if (node && !node.trashedAt) return node;
    }
    if (existing.state === 'open' && existing.expiresAt.getTime() > this.now()) {
      throw new UploadInProgressError();
    }
    // Failed, crashed (expired) or its file was since deleted: take over atomically.
    const taken = await db
      .update(uploads)
      .set({ state: 'open', expiresAt, encrypted: encrypt, plan: null })
      .where(
        and(
          eq(uploads.id, existing.id),
          sql`(${uploads.state} <> 'open' or ${uploads.expiresAt} <= ${new Date(this.now())})`,
        ),
      )
      .returning({ id: uploads.id });
    if (taken.length === 0) throw new UploadInProgressError();
    return null;
  }

  private async commit(req: UploadRequest, name: string, encrypt: boolean, file: StoredFile) {
    await this.deps.db.transaction(async (tx) => {
      await tx.insert(nodes).values({
        id: file.fileId,
        ownerId: req.ownerId,
        parentId: req.parentId,
        type: 'file',
        name,
        size: file.size,
        mime: mimeFor(name),
        encrypted: encrypt,
        keyId: file.encryption?.keyId ?? null,
        wrappedDek: file.encryption?.wrapped ?? null,
      });
      if (file.chunks.length > 0) {
        await tx.insert(fileChunks).values(file.chunks.map((c) => ({ ...c, fileId: file.fileId })));
      }
      await tx
        .update(uploads)
        .set({ state: 'done', plan: { nodeId: file.fileId } })
        .where(
          and(eq(uploads.ownerId, req.ownerId), eq(uploads.idempotencyKey, req.idempotencyKey)),
        );
    });
  }

  private finish(req: UploadRequest, state: 'failed') {
    return this.deps.db
      .update(uploads)
      .set({ state })
      .where(
        and(
          eq(uploads.ownerId, req.ownerId),
          eq(uploads.idempotencyKey, req.idempotencyKey),
          eq(uploads.state, 'open'),
        ),
      );
  }

  private async assertNameFree(ownerId: string, parentId: string | null, name: string) {
    const [clash] = await this.deps.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.name, name),
          isNull(nodes.trashedAt),
          parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
        ),
      );
    if (clash) throw new NameConflictError(name);
  }

  /** Open a file for reading. Range support is limited to whole, unencrypted files. */
  async open(ownerId: string, nodeId: string, range?: ByteRange): Promise<OpenedFile> {
    const node = await this.deps.fs.get(ownerId, nodeId);
    if (node.type !== 'file' || node.trashedAt) throw new NotFoundError();
    const stored = await this.stored(node);
    const supportsRange = this.deps.downloads.supportsRange(stored);
    const useRange = supportsRange ? range : undefined;
    const stream = await this.deps.downloads.open(ownerId, stored, useRange);
    return { node, stream, range: useRange, supportsRange };
  }

  private async stored(node: NodeRow): Promise<StoredFile> {
    const chunks = await this.deps.db
      .select()
      .from(fileChunks)
      .where(eq(fileChunks.fileId, node.id))
      .orderBy(asc(fileChunks.index));
    return {
      fileId: node.id,
      size: node.size,
      chunks,
      encryption:
        node.encrypted && node.keyId && node.wrappedDek
          ? { keyId: node.keyId, wrapped: node.wrappedDek }
          : null,
    };
  }
}
