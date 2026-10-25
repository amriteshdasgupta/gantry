import { test, expect, type Page } from '@playwright/test';

async function mockApi(page: Page) {
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/gantry/api/status') return route.fulfill({ json: { projects: [], tickets: [], previews: [], pulls: [], jobs: [] } });
    if (pathname === '/api/agents') return route.fulfill({ json: { agents: [], current: null } });
    if (pathname === '/api/spaces') return route.fulfill({ json: { spaces: [], current: null } });
    if (pathname === '/api/gantry/api/projects' && request.method() === 'POST') {
      writes.push(request.postDataJSON());
      return route.fulfill({ json: { ok: true, projectId: 'TEST_folder_picker' } });
    }
    return route.fulfill({ status: 400, json: { error: 'Unmocked request blocked' } });
  });
  return writes;
}

async function openForm(page: Page) {
  await page.goto('/');
  await page.getByRole('main').getByRole('button', { name: 'Add workspace', exact: true }).click();
  const input = page.getByLabel('Workspace folder', { exact: true });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  return input;
}

test('browser without the desktop bridge hides Browse and keeps Cancel and blank paths inert', async ({ page }) => {
  const writes = await mockApi(page);
  const input = await openForm(page);
  await expect(page.getByRole('button', { name: 'Browse…' })).toHaveCount(0);

  await input.fill('   ');
  await expect(page.getByRole('button', { name: 'Connect workspace', exact: true })).toBeDisabled();

  // Chromium drops the submit when React unmounts the form on click, so pin the button type directly.
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toHaveAttribute('type', 'button');
  await cancel.click();
  await expect(input).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('desktop Browse fills the folder and Connect adds the workspace', async ({ page }, testInfo) => {
  const writes = await mockApi(page);
  // Stands in for electron/preload.cjs; each call returns the next queued pick.
  await page.addInitScript(() => {
    const picks: (string | null)[] = [null, '/path/to/TEST_folder_picker'];
    (window as unknown as { gantryDesktop: unknown }).gantryDesktop = { pickFolder: async () => picks.shift() ?? null };
  });
  const input = await openForm(page);
  const browse = page.getByRole('button', { name: 'Browse…', exact: true });

  // A cancelled dialog leaves the typed value alone.
  await input.fill('/typed/path');
  await browse.click();
  await expect(input).toHaveValue('/typed/path');

  await browse.click();
  await expect(input).toHaveValue('/path/to/TEST_folder_picker');
  await page.screenshot({ path: testInfo.outputPath('folder-picked.png') });

  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ workspace: '/path/to/TEST_folder_picker', initialize: true });
  await expect(input).toHaveCount(0);
});
