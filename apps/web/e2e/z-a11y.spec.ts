import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Automated WCAG 2 A/AA checks on every screen, in light and dark mode. Runs after app.spec.ts
 * (alphabetical order) and signs in as the owner that journey created.
 */
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct-horse-battery-staple';

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
  expect(summary, `${label} has accessibility violations`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('login page', async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      await audit(page, 'login');
    });

    test('signed-in screens', async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto('/login');
      await page.getByLabel('Email').fill(EMAIL);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/files$/);
      await expect(page.getByRole('list', { name: 'Files and folders' })).toBeVisible();

      await audit(page, 'files (grid)');
      await page.getByRole('button', { name: 'Switch to list view' }).click();
      await audit(page, 'files (list)');
      await page.getByRole('button', { name: 'Toggle details' }).click();
      await audit(page, 'files with details panel');

      await page.getByRole('button', { name: 'New' }).click();
      await audit(page, 'New menu');
      await page.keyboard.press('Escape');

      await page.locator('[data-id]').filter({ hasText: 'Docs' }).dblclick(); // a folder first
      await expect(page).toHaveURL(/\/files\/[0-9a-f-]{36}$/);
      await page.locator('[data-id]').filter({ hasText: 'greeting.txt' }).dblclick();
      await expect(page.getByRole('dialog')).toBeVisible();
      await audit(page, 'preview dialog');
      await page.keyboard.press('Escape');

      await page.getByRole('link', { name: 'Trash' }).click();
      await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
      await audit(page, 'trash');

      await page.getByRole('link', { name: 'Storage' }).click();
      await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
      await expect(page.getByText('fake-1@pool.local')).toBeVisible();
      await audit(page, 'storage');
    });

    test('public share page', async ({ page }) => {
      await page.goto('/s/not-a-real-token');
      await expect(page.getByRole('heading', { name: 'Link unavailable' })).toBeVisible();
      await audit(page, 'share (invalid link)');
    });
  });
}
