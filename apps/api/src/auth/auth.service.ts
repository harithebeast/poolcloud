import { eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { sessions, users } from '../db/schema.js';
import { dummyHash, hashPassword, verifyPassword } from './password.js';
import { csrfTokenFor, hashToken, newSessionToken } from './tokens.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export interface SessionInfo {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
}

export class SetupClosedError extends Error {
  constructor() {
    super('Setup is already complete');
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super('Email already registered');
  }
}

export interface AuthSettings {
  sessionSecret: string;
  sessionTtlMs: number;
}

/** Drizzle wraps driver errors, so the Postgres code may sit on `cause`. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === '23505';
}

export const SETUP_LOCK = 724_001;

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly settings: AuthSettings,
    private readonly now: () => number = Date.now,
  ) {}

  async setupRequired(): Promise<boolean> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(users);
    return (row?.n ?? 0) === 0;
  }

  /** Creates the first (admin) user. Serialised so two concurrent first-run requests cannot both win. */
  async setup(email: string, password: string): Promise<AuthUser> {
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
      if ((row?.n ?? 0) > 0) throw new SetupClosedError();
      const [u] = await tx
        .insert(users)
        .values({ email: email.toLowerCase(), passwordHash, role: 'admin' })
        .returning({ id: users.id, email: users.email, role: users.role });
      return u!;
    });
  }

  /** Admin-created accounts after setup. */
  async createUser(email: string, password: string): Promise<AuthUser> {
    const passwordHash = await hashPassword(password);
    try {
      const [u] = await this.db
        .insert(users)
        .values({ email: email.toLowerCase(), passwordHash, role: 'user' })
        .returning({ id: users.id, email: users.email, role: users.role });
      return u!;
    } catch (e) {
      if (isUniqueViolation(e)) throw new EmailTakenError();
      throw e;
    }
  }

  /** Returns the session token (for the cookie) or null for bad credentials. Same cost either way. */
  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; info: SessionInfo } | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash()), password);
    if (!user || !ok) return null;

    const token = newSessionToken();
    const sessionId = hashToken(token);
    await this.db.insert(sessions).values({
      id: sessionId,
      ownerId: user.id,
      expiresAt: new Date(this.now() + this.settings.sessionTtlMs),
    });
    return {
      token,
      info: {
        user: { id: user.id, email: user.email, role: user.role },
        sessionId,
        csrfToken: csrfTokenFor(this.settings.sessionSecret, sessionId),
      },
    };
  }

  async resolve(token: string): Promise<SessionInfo | null> {
    const sessionId = hashToken(token);
    const [row] = await this.db
      .select({
        expiresAt: sessions.expiresAt,
        id: users.id,
        email: users.email,
        role: users.role,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt.getTime() <= this.now()) {
      await this.db.delete(sessions).where(eq(sessions.id, sessionId));
      return null;
    }
    return {
      user: { id: row.id, email: row.email, role: row.role },
      sessionId,
      csrfToken: csrfTokenFor(this.settings.sessionSecret, sessionId),
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date(this.now())));
  }
}
