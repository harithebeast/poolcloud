import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * One long user journey on a fresh, fake-Google stack. Tests run in order and share one browser
 * session, exactly like a person using the app.
 */
test.describe.configure({ mode: 'serial' });

const EMAIL = 'owner@example.com';
const PASSWORD = 'correct-horse-battery-staple';

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
});
test.afterAll(async () => {
  await context.close();
});

const row = (name: string | RegExp) => page.getByRole('option', { name });
const upload = (name: string, body: string | Buffer, mimeType = 'text/plain') =>
  page
    .getByLabel('Choose files to upload')
    .setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
const moreActions = async (name: string, action: string) => {
  await page.getByRole('button', { name: `More actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
};

test('first run: create the admin, then sign out and back in', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill('something-else-entirely');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText('The passwords do not match.');

  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByText('This folder is empty')).toBeVisible();

  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.');

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/files$/);
});

test('protected pages send signed-out visitors to the login page', async ({ browser }) => {
  const anon = await browser.newPage();
  await anon.goto('/files');
  await expect(anon).toHaveURL(/\/login$/);
  await anon.goto('/storage');
  await expect(anon).toHaveURL(/\/login$/);
  await anon.close();
});

test('uploads are refused politely while no storage is linked', async () => {
  await upload('too-early.txt', 'nope');
  await expect(page.getByRole('region', { name: 'Uploads' })).toContainText(
    'Not enough free space',
  );
  await page.getByRole('button', { name: 'Dismiss uploads' }).click();
});

test('link three Google accounts and see one pooled bar', async () => {
  await page.getByRole('link', { name: 'Storage' }).click();
  await expect(page.getByText('No accounts linked yet')).toBeVisible();
  for (let i = 1; i <= 3; i++) {
    await page.getByRole('button', { name: 'Link a Google account' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `Linked fake-${i}@pool.local` }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/storage$/); // the result query string is cleaned up
  }
  await expect(page.getByText('0 B of 45.0 GB used').first()).toBeVisible();
  for (let i = 1; i <= 3; i++) await expect(page.getByText(`fake-${i}@pool.local`)).toBeVisible();
  await expect(
    page.getByText(/unavailable while any account holding part of it is offline/),
  ).toBeVisible();
});

test('upload a file: progress panel, listing, preview', async () => {
  await page.getByRole('link', { name: 'My files' }).click();
  await upload('hello.txt', 'hello pool\nsecond line');
  await expect(page.getByRole('region', { name: 'Uploads' })).toContainText('Uploads complete');
  await expect(row(/hello\.txt/)).toBeVisible();

  await row(/hello\.txt/).dblclick();
  const dialog = page.getByRole('dialog', { name: 'hello.txt' });
  await expect(dialog.getByText('hello pool')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('download returns the exact bytes', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    moreActions('hello.txt', 'Download'),
  ]);
  expect(download.suggestedFilename()).toBe('hello.txt');
  expect((await readFile((await download.path())!)).toString()).toBe('hello pool\nsecond line');
});

test('image preview', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await upload('dot.png', png, 'image/png');
  await expect(row(/dot\.png/)).toBeVisible();
  await row(/dot\.png/).dblclick();
  const img = page.getByRole('dialog', { name: 'dot.png' }).getByRole('img', { name: 'dot.png' });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  await page.keyboard.press('Escape');
});

test('create a folder, rename, and move files into it', async () => {
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('Docs');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(row(/Docs/)).toBeVisible();

  await row(/hello\.txt/).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Name').fill('greeting.txt');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(row(/greeting\.txt/)).toBeVisible();
  await expect(row(/hello\.txt/)).toHaveCount(0);

  await moreActions('greeting.txt', 'Move to…');
  const dialog = page.getByRole('dialog', { name: /Move/ });
  await dialog.getByRole('button', { name: 'Docs' }).click();
  await dialog.getByRole('button', { name: 'Move here' }).click();
  await expect(row(/greeting\.txt/)).toHaveCount(0);

  await row(/Docs/).dblclick();
  await expect(page).toHaveURL(/\/files\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Docs');
  await expect(row(/greeting\.txt/)).toBeVisible();
});

test('name clashes are reported', async () => {
  await upload('greeting.txt', 'duplicate');
  await expect(page.getByRole('region', { name: 'Uploads' })).toContainText('already exists');
  await page
    .getByRole('button', { name: 'Dismiss uploads' })
    .click()
    .catch(() => undefined);
});

test('drag a file onto a folder to move it', async () => {
  await page.getByRole('button', { name: 'My files' }).click();
  await expect(row(/dot\.png/)).toBeVisible();
  await row(/dot\.png/).dragTo(row(/Docs/));
  await expect(row(/dot\.png/)).toHaveCount(0);
  await row(/Docs/).dblclick();
  await expect(row(/dot\.png/)).toBeVisible();
});

test('drag files from the desktop onto the page uploads them', async () => {
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['dropped bytes'], 'dropped.txt', { type: 'text/plain' }));
    return dt;
  });
  await page.getByRole('listbox').dispatchEvent('dragover', { dataTransfer: data });
  await page.getByRole('listbox').dispatchEvent('drop', { dataTransfer: data });
  await expect(row(/dropped\.txt/)).toBeVisible();
});

test('multi-select with keyboard, then trash and restore', async () => {
  await row(/greeting\.txt/).click();
  await page.keyboard.press('Control+a');
  await expect(page.getByRole('toolbar', { name: 'Selection actions' })).toContainText('selected');
  await page.keyboard.press('Delete');
  await expect(row(/greeting\.txt/)).toHaveCount(0);

  await page.getByRole('link', { name: 'Trash' }).click();
  await expect(page.getByText('greeting.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Restore greeting.txt' }).click();
  await expect(page.getByText('greeting.txt')).toHaveCount(0);
  await page.getByRole('link', { name: 'My files' }).click();
  await row(/Docs/).dblclick();
  await expect(row(/greeting\.txt/)).toBeVisible();
});

test('delete forever asks for confirmation', async () => {
  await row(/dropped\.txt/).click();
  await page.keyboard.press('Delete');
  await page.getByRole('link', { name: 'Trash' }).click();
  await page.getByRole('button', { name: 'Delete dropped.txt forever' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete forever?' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete forever', exact: true }).click();
  await expect(page.getByText('Trash is empty.')).toBeVisible();
});

test('search finds files by name', async () => {
  await page.getByRole('searchbox', { name: 'Search files by name' }).fill('greet');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=greet/);
  await expect(row(/greeting\.txt/)).toBeVisible();
  await expect(row(/dot\.png/)).toHaveCount(0);
});

test('details panel shows facts but never which account stores the file', async () => {
  await page.getByRole('link', { name: 'My files' }).click();
  await row(/Docs/).dblclick();
  await row(/greeting\.txt/).click();
  await page.getByRole('button', { name: 'Toggle details' }).click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('greeting.txt');
  await expect(details).toContainText('Not encrypted');
  await expect(details).not.toContainText(/pool\.local|fake-|account/i);
});

test('encrypted uploads are marked as such', async () => {
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Encrypt new uploads' }).click();
  await page.keyboard.press('Escape');
  await upload('secret.txt', 'top secret words');
  await expect(row(/secret\.txt/)).toBeVisible();
  await row(/secret\.txt/).click();
  await expect(page.getByRole('complementary', { name: 'Details' })).toContainText(
    'Encrypted (AES-256-GCM)',
  );
  await row(/secret\.txt/).dblclick();
  await expect(
    page.getByRole('dialog', { name: 'secret.txt' }).getByText('top secret words'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Encrypt new uploads' }).click();
  await page.keyboard.press('Escape');
});

test('a large file uploads with visible progress and downloads intact', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
  await upload('big.bin', big, 'application/octet-stream');
  await expect(page.getByRole('region', { name: 'Uploads' })).toContainText('Uploads complete', {
    timeout: 30_000,
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    moreActions('big.bin', 'Download'),
  ]);
  expect(Buffer.compare(await readFile((await download.path())!), big)).toBe(0);
});

test('share links: public download, password, revoke', async ({ browser }) => {
  // Open link
  await moreActions('greeting.txt', 'Share');
  const dialog = page.getByRole('dialog', { name: /Share/ });
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const link = await dialog.getByLabel('Share link').inputValue();
  expect(link).toMatch(/\/s\/[\w-]{43}$/);
  await expect(dialog.getByText('Open link · 0 downloads')).toBeVisible();

  const visitor = await browser.newContext({ acceptDownloads: true });
  const shared = await visitor.newPage();
  await shared.goto(link);
  await expect(shared.getByRole('heading', { name: 'greeting.txt' })).toBeVisible();
  const [download] = await Promise.all([
    shared.waitForEvent('download'),
    shared.getByRole('link', { name: 'Download' }).click(),
  ]);
  expect((await readFile((await download.path())!)).toString()).toBe('hello pool\nsecond line');

  // The owner sees the download counted, then revokes.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await moreActions('greeting.txt', 'Share');
  await expect(
    page.getByRole('dialog', { name: /Share/ }).getByText('Open link · 1 download'),
  ).toBeVisible();
  await page.getByRole('button', { name: /Revoke link/ }).click();
  await expect(page.getByText('No active links.')).toBeVisible();
  await shared.reload();
  await expect(shared.getByText('invalid, has expired, or was revoked')).toBeVisible();

  // Password protected
  await page.getByLabel('Password (optional)').fill('open-sesame');
  await page.getByRole('button', { name: 'Create link' }).click();
  const protectedLink = await page.getByLabel('Share link').inputValue();
  const second = await visitor.newPage();
  await second.goto(protectedLink);
  await second.getByLabel('Password').fill('wrong-password');
  await second.getByRole('button', { name: 'Unlock' }).click();
  await expect(second.getByText('Incorrect password.')).toBeVisible();
  await second.getByLabel('Password').fill('open-sesame');
  await second.getByRole('button', { name: 'Unlock' }).click();
  const [pwDownload] = await Promise.all([
    second.waitForEvent('download'),
    second.getByRole('link', { name: 'Download' }).click(),
  ]);
  expect((await readFile((await pwDownload.path())!)).toString()).toBe('hello pool\nsecond line');
  await visitor.close();
  await page.keyboard.press('Escape');
});

test('dark mode switches and is remembered', async () => {
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('the pooled bar reflects what was stored', async () => {
  await page.getByRole('link', { name: 'Storage' }).click();
  await expect(page.getByText(/MB of 45\.0 GB used|KB of 45\.0 GB used/).first()).toBeVisible();
});
