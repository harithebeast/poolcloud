import { and, asc, eq, ilike, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { fileChunks, nodes, remoteCleanup, shareLinks, storageAccounts } from '../db/schema.js';

export class NotFoundError extends Error {
  constructor(what = 'Item') {
    super(`${what} not found`);
  }
}
export class NameConflictError extends Error {
  constructor(name: string) {
    super(`An item named "${name}" already exists here`);
  }
}
export class InvalidNameError extends Error {}
export class InvalidMoveError extends Error {}

export type NodeRow = typeof nodes.$inferSelect;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_NAME = 255;

export function validateName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new InvalidNameError('Name cannot be empty');
  if (name.length > MAX_NAME)
    throw new InvalidNameError(`Name is longer than ${MAX_NAME} characters`);
  if (name === '.' || name === '..') throw new InvalidNameError('Name is reserved');
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f]/.test(name))
    throw new InvalidNameError('Name contains invalid characters');
  return name;
}

const isUnique = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === '23505';
};

/** Escape LIKE wildcards so user input is matched literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The virtual filesystem lives only in Postgres. Every query is scoped by owner so one user can
 * never address another user's nodes, even with a guessed id.
 */
export class FsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(ownerId: string, id: string): Promise<NodeRow> {
    const [n] = await this.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)));
    if (!n) throw new NotFoundError();
    return n;
  }

  /** Folder contents, folders first. `parentId` null is the root. */
  async list(ownerId: string, parentId: string | null): Promise<NodeRow[]> {
    if (parentId) await this.requireLiveFolder(ownerId, parentId);
    return this.db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
          isNull(nodes.trashedAt),
        ),
      )
      .orderBy(sql`${nodes.type} = 'file'`, sql`lower(${nodes.name})`);
  }

  async createFolder(ownerId: string, parentId: string | null, rawName: string): Promise<NodeRow> {
    const name = validateName(rawName);
    let encryptByDefault = false;
    if (parentId)
      encryptByDefault = (await this.requireLiveFolder(ownerId, parentId)).encryptByDefault;
    try {
      const [n] = await this.db
        .insert(nodes)
        .values({ ownerId, parentId, type: 'folder', name, encryptByDefault })
        .returning();
      return n!;
    } catch (e) {
      if (isUnique(e)) throw new NameConflictError(name);
      throw e;
    }
  }

  async rename(ownerId: string, id: string, rawName: string): Promise<NodeRow> {
    const name = validateName(rawName);
    await this.requireLive(ownerId, id);
    return this.update(ownerId, id, { name }, name);
  }

  async setEncryptByDefault(ownerId: string, folderId: string, value: boolean): Promise<NodeRow> {
    const f = await this.requireLiveFolder(ownerId, folderId);
    return this.update(ownerId, f.id, { encryptByDefault: value }, f.name);
  }

  /** Move into another folder (null = root). A folder cannot move into itself or its own subtree. */
  async move(ownerId: string, id: string, newParentId: string | null): Promise<NodeRow> {
    const node = await this.requireLive(ownerId, id);
    if (newParentId) {
      await this.requireLiveFolder(ownerId, newParentId);
      const inside = await this.db.execute(sql`
        with recursive sub as (
          select id from nodes where id = ${id} and owner_id = ${ownerId}
          union all
          select n.id from nodes n join sub on n.parent_id = sub.id
        )
        select 1 from sub where id = ${newParentId} limit 1`);
      if (inside.rows.length > 0) throw new InvalidMoveError('Cannot move a folder into itself');
    }
    return this.update(ownerId, id, { parentId: newParentId }, node.name);
  }

  private async update(
    ownerId: string,
    id: string,
    patch: Partial<typeof nodes.$inferInsert>,
    name: string,
  ): Promise<NodeRow> {
    try {
      const [n] = await this.db
        .update(nodes)
        .set({ ...patch, updatedAt: this.now() })
        .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId)))
        .returning();
      if (!n) throw new NotFoundError();
      return n;
    } catch (e) {
      if (isUnique(e)) throw new NameConflictError(name);
      throw e;
    }
  }

  /** Path from the root to the node, for breadcrumbs. */
  async breadcrumbs(ownerId: string, id: string): Promise<Array<{ id: string; name: string }>> {
    await this.get(ownerId, id);
    const res = await this.db.execute<{ id: string; name: string; depth: number }>(sql`
      with recursive up as (
        select id, name, parent_id, 0 as depth from nodes where id = ${id} and owner_id = ${ownerId}
        union all
        select n.id, n.name, n.parent_id, up.depth + 1 from nodes n join up on n.id = up.parent_id
        where n.owner_id = ${ownerId}
      )
      select id, name, depth from up order by depth desc`);
    return res.rows.map(({ id, name }) => ({ id, name }));
  }

  async search(ownerId: string, query: string, limit = 50): Promise<NodeRow[]> {
    const q = query.trim();
    if (!q) return [];
    return this.db
      .select()
      .from(nodes)
      .where(
        and(eq(nodes.ownerId, ownerId), isNull(nodes.trashedAt), ilike(nodes.name, likePattern(q))),
      )
      .orderBy(asc(nodes.name))
      .limit(Math.min(limit, 200));
  }

  // ── Trash ────────────────────────────────────────────────────────────────────────────────────

  /** Soft-delete a node and everything under it. Descendants remember which node was trashed. */
  async trash(ownerId: string, id: string): Promise<void> {
    await this.requireLive(ownerId, id);
    const at = this.now();
    await this.db.execute(sql`
      with recursive sub as (
        select id from nodes where id = ${id} and owner_id = ${ownerId}
        union all
        select n.id from nodes n join sub on n.parent_id = sub.id where n.trashed_at is null
      )
      update nodes set trashed_at = ${at}, trash_root_id = ${id}, updated_at = ${at}
      where id in (select id from sub)`);
  }

  /** Top-level trashed items (not their descendants). */
  async listTrash(ownerId: string): Promise<NodeRow[]> {
    return this.db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          isNotNull(nodes.trashedAt),
          eq(nodes.trashRootId, nodes.id),
        ),
      )
      .orderBy(sql`${nodes.trashedAt} desc`);
  }

  /**
   * Restore a trashed item with its subtree. Goes back to its old folder, or to the root if that
   * folder is gone/trashed. A name clash gets a " (restored)" suffix instead of failing.
   */
  async restore(ownerId: string, id: string): Promise<NodeRow> {
    const [root] = await this.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.trashRootId, id)));
    if (!root?.trashedAt) throw new NotFoundError('Trashed item');

    let parentId = root.parentId;
    if (parentId) {
      const [p] = await this.db
        .select({ trashedAt: nodes.trashedAt })
        .from(nodes)
        .where(and(eq(nodes.id, parentId), eq(nodes.ownerId, ownerId)));
      if (!p || p.trashedAt) parentId = null;
    }

    let name = root.name;
    for (let attempt = 0; attempt < 20; attempt++) {
      const [clash] = await this.db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            isNull(nodes.trashedAt),
            eq(nodes.name, name),
            sql`coalesce(${nodes.parentId}, ${ZERO_UUID}::uuid) = coalesce(${parentId}::uuid, ${ZERO_UUID}::uuid)`,
          ),
        );
      if (!clash) break;
      name = `${root.name} (restored${attempt ? ` ${attempt + 1}` : ''})`;
    }

    const at = this.now();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        update nodes set trashed_at = null, trash_root_id = null, updated_at = ${at}
        where owner_id = ${ownerId} and trash_root_id = ${id} and id <> ${id}`);
      try {
        const [n] = await tx
          .update(nodes)
          .set({ trashedAt: null, trashRootId: null, parentId, name, updatedAt: at })
          .where(eq(nodes.id, id))
          .returning();
        return n!;
      } catch (e) {
        if (isUnique(e)) throw new NameConflictError(name);
        throw e;
      }
    });
  }

  /**
   * Permanently delete a trashed item and its subtree. Metadata and the remote-cleanup rows are
   * written in ONE transaction, so a crash cannot orphan blobs in Drive without a record.
   */
  async purge(ownerId: string, id: string): Promise<{ files: number; bytes: number }> {
    const [root] = await this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.trashRootId, id)));
    if (!root) throw new NotFoundError('Trashed item');
    return this.purgeRoots(ownerId, [id]);
  }

  async emptyTrash(ownerId: string): Promise<{ files: number; bytes: number }> {
    const roots = await this.listTrash(ownerId);
    return this.purgeRoots(
      ownerId,
      roots.map((r) => r.id),
    );
  }

  /** Auto-purge: everything trashed more than `retentionDays` ago, across all owners. */
  async purgeExpired(retentionDays: number): Promise<{ files: number; bytes: number }> {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000);
    const expired = await this.db
      .select({ id: nodes.id, ownerId: nodes.ownerId })
      .from(nodes)
      .where(
        and(
          isNotNull(nodes.trashedAt),
          eq(nodes.trashRootId, nodes.id),
          sql`${nodes.trashedAt} < ${cutoff}`,
        ),
      );
    const byOwner = new Map<string, string[]>();
    for (const e of expired) byOwner.set(e.ownerId, [...(byOwner.get(e.ownerId) ?? []), e.id]);
    let files = 0;
    let bytes = 0;
    for (const [owner, ids] of byOwner) {
      const r = await this.purgeRoots(owner, ids);
      files += r.files;
      bytes += r.bytes;
    }
    return { files, bytes };
  }

  private async purgeRoots(
    ownerId: string,
    rootIds: string[],
  ): Promise<{ files: number; bytes: number }> {
    if (rootIds.length === 0) return { files: 0, bytes: 0 };
    return this.db.transaction(async (tx) => {
      const sub = await tx.execute<{ id: string; type: string; size: number }>(sql`
        with recursive sub as (
          select id, type, size from nodes
          where owner_id = ${ownerId} and id in (${sql.join(
            rootIds.map((r) => sql`${r}::uuid`),
            sql`, `,
          )})
          union all
          select n.id, n.type, n.size from nodes n join sub on n.parent_id = sub.id
        )
        select id, type, size from sub`);
      const ids = sub.rows.map((r) => r.id);
      const fileIds = sub.rows.filter((r) => r.type === 'file').map((r) => r.id);

      const chunks = fileIds.length
        ? await tx.select().from(fileChunks).where(inArray(fileChunks.fileId, fileIds))
        : [];
      if (chunks.length > 0) {
        await tx.insert(remoteCleanup).values(
          chunks.map((c) => ({
            ownerId,
            accountId: c.accountId,
            remoteId: c.remoteId,
            reason: 'purge',
          })),
        );
        const perAccount = new Map<string, number>();
        for (const c of chunks)
          perAccount.set(c.accountId, (perAccount.get(c.accountId) ?? 0) + c.size);
        for (const [accountId, size] of perAccount) {
          await tx
            .update(storageAccounts)
            .set({ quotaUsage: sql`greatest(0, ${storageAccounts.quotaUsage} - ${size})` })
            .where(eq(storageAccounts.id, accountId));
        }
        await tx.delete(fileChunks).where(inArray(fileChunks.fileId, fileIds));
      }
      await tx.delete(shareLinks).where(inArray(shareLinks.nodeId, ids));
      await tx.delete(nodes).where(inArray(nodes.id, ids));
      return {
        files: fileIds.length,
        bytes: sub.rows.filter((r) => r.type === 'file').reduce((s, r) => s + Number(r.size), 0),
      };
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────

  private async requireLive(ownerId: string, id: string): Promise<NodeRow> {
    const n = await this.get(ownerId, id);
    if (n.trashedAt) throw new NotFoundError();
    return n;
  }

  private async requireLiveFolder(ownerId: string, id: string): Promise<NodeRow> {
    const n = await this.requireLive(ownerId, id);
    if (n.type !== 'folder') throw new NotFoundError('Folder');
    return n;
  }
}
