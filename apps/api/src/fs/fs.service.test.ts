import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fileChunks,
  nodes,
  remoteCleanup,
  shareLinks,
  storageAccounts,
  users,
} from '../db/schema.js';
import { createTestDb } from '../testing/test-db.js';
import {
  FsService,
  InvalidMoveError,
  InvalidNameError,
  NameConflictError,
  NotFoundError,
  likePattern,
  validateName,
} from './fs.service.js';

describe('name validation', () => {
  it('trims and accepts ordinary names, including unicode and spaces', () => {
    expect(validateName('  Report 2024 – final.pdf ')).toBe('Report 2024 – final.pdf');
    expect(validateName('日本語')).toBe('日本語');
  });

  it('rejects empty, reserved, overlong and path-like names', () => {
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'tab\there', 'x'.repeat(256)]) {
      expect(() => validateName(bad), JSON.stringify(bad)).toThrow(InvalidNameError);
    }
  });

  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('FsService (Postgres)', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fs: FsService;
  let clock = new Date('2026-01-01T00:00:00Z');
  let owner: string;
  let other: string;

  const newUser = async () => {
    const [u] = await testDb.db
      .insert(users)
      .values({ email: `${randomUUID()}@t.io`, passwordHash: 'x' })
      .returning({ id: users.id });
    return u!.id;
  };
  const file = async (parentId: string | null, name: string, size = 10, who = owner) => {
    const [n] = await testDb.db
      .insert(nodes)
      .values({ ownerId: who, parentId, type: 'file', name, size })
      .returning();
    return n!;
  };

  beforeAll(async () => {
    testDb = await createTestDb(url!);
    fs = new FsService(testDb.db, () => clock);
    owner = await newUser();
    other = await newUser();
  });
  afterAll(() => testDb.drop());

  it('creates folders, lists folders first and sorts case-insensitively', async () => {
    const docs = await fs.createFolder(owner, null, 'Docs');
    await fs.createFolder(owner, null, 'archive');
    await file(null, 'b.txt');
    await file(null, 'A.txt');
    expect((await fs.list(owner, null)).map((n) => n.name)).toEqual([
      'archive',
      'Docs',
      'A.txt',
      'b.txt',
    ]);
    expect(await fs.list(owner, docs.id)).toEqual([]);
  });

  it('rejects duplicate names among live siblings but not across folders', async () => {
    const a = await fs.createFolder(owner, null, 'dup-a');
    await expect(fs.createFolder(owner, null, 'dup-a')).rejects.toBeInstanceOf(NameConflictError);
    await expect(fs.createFolder(owner, a.id, 'dup-a')).resolves.toBeDefined();
  });

  it('inherits encrypt-by-default from the parent folder', async () => {
    const secure = await fs.createFolder(owner, null, 'secure');
    await fs.setEncryptByDefault(owner, secure.id, true);
    expect((await fs.createFolder(owner, secure.id, 'child')).encryptByDefault).toBe(true);
  });

  it('renames and reports conflicts', async () => {
    const f = await file(null, 'old.txt');
    await file(null, 'taken.txt');
    expect((await fs.rename(owner, f.id, ' new.txt ')).name).toBe('new.txt');
    await expect(fs.rename(owner, f.id, 'taken.txt')).rejects.toBeInstanceOf(NameConflictError);
    await expect(fs.rename(owner, f.id, '../x')).rejects.toBeInstanceOf(InvalidNameError);
  });

  it('moves items and refuses to move a folder into itself or its descendants', async () => {
    const a = await fs.createFolder(owner, null, 'mv-a');
    const b = await fs.createFolder(owner, a.id, 'mv-b');
    const f = await file(null, 'mv.txt');
    expect((await fs.move(owner, f.id, b.id)).parentId).toBe(b.id);
    expect((await fs.move(owner, f.id, null)).parentId).toBeNull();
    await expect(fs.move(owner, a.id, a.id)).rejects.toBeInstanceOf(InvalidMoveError);
    await expect(fs.move(owner, a.id, b.id)).rejects.toBeInstanceOf(InvalidMoveError);
    await expect(fs.move(owner, f.id, f.id)).rejects.toBeInstanceOf(NotFoundError); // a file is no folder
  });

  it('gives breadcrumbs from the root down', async () => {
    const a = await fs.createFolder(owner, null, 'bc-a');
    const b = await fs.createFolder(owner, a.id, 'bc-b');
    expect((await fs.breadcrumbs(owner, b.id)).map((c) => c.name)).toEqual(['bc-a', 'bc-b']);
  });

  it('searches by name, case-insensitively, treating wildcards literally and skipping trash', async () => {
    await file(null, 'Budget 2024.xlsx');
    await file(null, '100%_done.txt');
    const gone = await file(null, 'budget-old.xlsx');
    await fs.trash(owner, gone.id);
    expect((await fs.search(owner, 'BUDGET')).map((n) => n.name)).toEqual(['Budget 2024.xlsx']);
    expect((await fs.search(owner, '%_')).map((n) => n.name)).toEqual(['100%_done.txt']);
    expect(await fs.search(owner, '   ')).toEqual([]);
  });

  it('isolates owners: another user cannot see, move or trash these nodes', async () => {
    const mine = await fs.createFolder(owner, null, 'private');
    await expect(fs.get(other, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(fs.rename(other, mine.id, 'x')).rejects.toBeInstanceOf(NotFoundError);
    await expect(fs.trash(other, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(fs.createFolder(other, mine.id, 'sneaky')).rejects.toBeInstanceOf(NotFoundError);
    expect(await fs.search(other, 'private')).toEqual([]);
  });

  describe('trash', () => {
    it('trashes a subtree, hides it, and restores it intact', async () => {
      const top = await fs.createFolder(owner, null, 'tr-top');
      const sub = await fs.createFolder(owner, top.id, 'tr-sub');
      const f = await file(sub.id, 'deep.txt');
      await fs.trash(owner, top.id);

      expect((await fs.listTrash(owner)).map((n) => n.name)).toContain('tr-top');
      expect((await fs.listTrash(owner)).map((n) => n.name)).not.toContain('deep.txt');
      await expect(fs.list(owner, top.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fs.get(owner, f.id)).resolves.toMatchObject({ trashRootId: top.id });

      const restored = await fs.restore(owner, top.id);
      expect(restored).toMatchObject({ name: 'tr-top', trashedAt: null, trashRootId: null });
      expect((await fs.list(owner, sub.id)).map((n) => n.name)).toEqual(['deep.txt']);
    });

    it('frees the name while trashed, and restores under a suffixed name on a clash', async () => {
      const f = await file(null, 'report.txt');
      await fs.trash(owner, f.id);
      await file(null, 'report.txt'); // allowed: the old one is in the trash
      const back = await fs.restore(owner, f.id);
      expect(back.name).toBe('report.txt (restored)');
    });

    it('restores to the root when the original folder is gone or trashed', async () => {
      const folder = await fs.createFolder(owner, null, 'tr-parent');
      const f = await file(folder.id, 'child.txt');
      await fs.trash(owner, f.id);
      await fs.trash(owner, folder.id);
      const back = await fs.restore(owner, f.id);
      expect(back.parentId).toBeNull();
    });

    it('only restores trash roots', async () => {
      const top = await fs.createFolder(owner, null, 'tr-root-only');
      const f = await file(top.id, 'inner.txt');
      await fs.trash(owner, top.id);
      await expect(fs.restore(owner, f.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fs.restore(other, top.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fs.trash(owner, top.id)).rejects.toBeInstanceOf(NotFoundError); // already trashed
    });
  });

  describe('purge', () => {
    async function account(who: string, usage: number) {
      const [a] = await testDb.db
        .insert(storageAccounts)
        .values({
          ownerId: who,
          googleSub: randomUUID(),
          email: 'a@t',
          refreshTokenEnc: 'x',
          quotaLimit: 1000,
          quotaUsage: usage,
        })
        .returning({ id: storageAccounts.id });
      return a!.id;
    }

    it('deletes metadata, queues every remote blob for cleanup and releases usage — atomically', async () => {
      const acct = await account(owner, 300);
      const folder = await fs.createFolder(owner, null, 'pg-folder');
      const f = await file(folder.id, 'big.bin', 250);
      await testDb.db.insert(fileChunks).values([
        { fileId: f.id, index: 0, accountId: acct, remoteId: 'r0', size: 100, sha256: 'a' },
        { fileId: f.id, index: 1, accountId: acct, remoteId: 'r1', size: 150, sha256: 'b' },
      ]);
      await testDb.db
        .insert(shareLinks)
        .values({ ownerId: owner, nodeId: f.id, tokenHash: randomUUID() });
      await fs.trash(owner, folder.id);

      expect(await fs.purge(owner, folder.id)).toEqual({ files: 1, bytes: 250 });

      expect(await testDb.db.select().from(nodes).where(eq(nodes.id, f.id))).toHaveLength(0);
      expect(await testDb.db.select().from(fileChunks).where(eq(fileChunks.fileId, f.id))).toEqual(
        [],
      );
      expect(await testDb.db.select().from(shareLinks).where(eq(shareLinks.nodeId, f.id))).toEqual(
        [],
      );
      const queued = await testDb.db
        .select()
        .from(remoteCleanup)
        .where(eq(remoteCleanup.accountId, acct));
      expect(queued.map((q) => q.remoteId).sort()).toEqual(['r0', 'r1']);
      const [a] = await testDb.db
        .select()
        .from(storageAccounts)
        .where(eq(storageAccounts.id, acct));
      expect(a!.quotaUsage).toBe(50);
    });

    it('will not purge something that is not in the trash', async () => {
      const live = await fs.createFolder(owner, null, 'pg-live');
      await expect(fs.purge(owner, live.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('empties the trash', async () => {
      const u = await newUser();
      await file(null, 'e1', 5, u);
      const e2 = await fs.createFolder(u, null, 'e2');
      for (const n of await fs.list(u, null)) await fs.trash(u, n.id);
      expect(await fs.emptyTrash(u)).toEqual({ files: 1, bytes: 5 });
      expect(await fs.listTrash(u)).toEqual([]);
      await expect(fs.get(u, e2.id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await fs.emptyTrash(u)).toEqual({ files: 0, bytes: 0 });
    });

    it('auto-purges only items trashed longer than the retention period', async () => {
      const u = await newUser();
      const old = await file(null, 'old', 7, u);
      const recent = await file(null, 'recent', 3, u);
      await fs.trash(u, old.id);
      clock = new Date(clock.getTime() + 20 * 86_400_000);
      await fs.trash(u, recent.id);
      clock = new Date(clock.getTime() + 15 * 86_400_000); // old: 35 days, recent: 15 days

      const result = await fs.purgeExpired(30);
      expect(result.files).toBeGreaterThanOrEqual(1);
      await expect(fs.get(u, old.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(fs.get(u, recent.id)).resolves.toBeDefined();
    });
  });
});
