import { createHmac, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { hashToken, safeEqual } from '../auth/tokens.js';
import type { Db } from '../db/db.module.js';
import { nodes, shareLinks } from '../db/schema.js';
import { NotFoundError, type FsService } from '../fs/fs.service.js';

export class ShareUnavailableError extends Error {
  constructor() {
    super('This link is invalid, expired or has been revoked');
  }
}
export class SharePasswordError extends Error {
  constructor() {
    super('A valid password is required');
  }
}

export type ShareRow = typeof shareLinks.$inferSelect;

export interface ResolvedShare {
  share: ShareRow;
  node: typeof nodes.$inferSelect;
}

const ACCESS_TTL_MS = 10 * 60_000;

export class SharesService {
  constructor(
    private readonly deps: {
      db: Db;
      fs: FsService;
      secret: string;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Create a link to a file. The raw token is returned once; only its hash is stored. */
  async create(
    ownerId: string,
    input: { nodeId: string; expiresAt?: Date | null; password?: string | null },
  ) {
    const node = await this.deps.fs.get(ownerId, input.nodeId);
    if (node.trashedAt) throw new NotFoundError();
    if (node.type !== 'file') throw new NotFoundError('File'); // v1 shares single files
    if (input.expiresAt && input.expiresAt.getTime() <= this.now()) {
      throw new RangeError('Expiry must be in the future');
    }
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.deps.db
      .insert(shareLinks)
      .values({
        ownerId,
        nodeId: node.id,
        tokenHash: hashToken(token),
        passwordHash: input.password ? await hashPassword(input.password) : null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return { token, share: row! };
  }

  async list(ownerId: string, nodeId?: string): Promise<ShareRow[]> {
    return this.deps.db
      .select()
      .from(shareLinks)
      .where(
        and(eq(shareLinks.ownerId, ownerId), nodeId ? eq(shareLinks.nodeId, nodeId) : undefined),
      )
      .orderBy(desc(shareLinks.createdAt));
  }

  async revoke(ownerId: string, shareId: string): Promise<void> {
    const rows = await this.deps.db
      .update(shareLinks)
      .set({ revokedAt: new Date(this.now()) })
      .where(
        and(
          eq(shareLinks.id, shareId),
          eq(shareLinks.ownerId, ownerId),
          isNull(shareLinks.revokedAt),
        ),
      )
      .returning({ id: shareLinks.id });
    if (rows.length === 0) throw new NotFoundError('Share link');
  }

  /** Look a token up. Revoked, expired and deleted targets all look the same to the caller. */
  async resolve(token: string): Promise<ResolvedShare> {
    const [share] = await this.deps.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.tokenHash, hashToken(token)));
    if (!share || share.revokedAt) throw new ShareUnavailableError();
    if (share.expiresAt && share.expiresAt.getTime() <= this.now())
      throw new ShareUnavailableError();
    const [node] = await this.deps.db.select().from(nodes).where(eq(nodes.id, share.nodeId));
    if (!node || node.trashedAt || node.type !== 'file') throw new ShareUnavailableError();
    return { share, node };
  }

  /** Verify the password (if any) and mint a short-lived access token for this share. */
  async unlock(token: string, password: string | undefined): Promise<string> {
    const { share } = await this.resolve(token);
    if (share.passwordHash) {
      if (!password || !(await verifyPassword(share.passwordHash, password))) {
        throw new SharePasswordError();
      }
    }
    return this.accessToken(share.id);
  }

  /** Throws unless the share is open, or `access` proves the password was entered recently. */
  assertAccess(resolved: ResolvedShare, access: string | undefined): void {
    if (!resolved.share.passwordHash) return;
    if (!access || !this.validAccess(resolved.share.id, access)) throw new SharePasswordError();
  }

  /** Count a download; refuses if the link was revoked in the meantime. */
  async recordDownload(shareId: string): Promise<void> {
    await this.deps.db
      .update(shareLinks)
      .set({ downloadCount: sql`${shareLinks.downloadCount} + 1` })
      .where(eq(shareLinks.id, shareId));
  }

  private sign(shareId: string, exp: number): string {
    return createHmac('sha256', this.deps.secret)
      .update(`share-access|${shareId}|${exp}`)
      .digest('base64url');
  }

  private accessToken(shareId: string): string {
    const exp = this.now() + ACCESS_TTL_MS;
    return `${exp}.${this.sign(shareId, exp)}`;
  }

  private validAccess(shareId: string, access: string): boolean {
    const [expRaw, sig, extra] = access.split('.');
    const exp = Number(expRaw);
    if (!sig || extra !== undefined || !Number.isSafeInteger(exp) || exp <= this.now())
      return false;
    return safeEqual(sig, this.sign(shareId, exp));
  }
}
