import { expect, test } from '@playwright/test';

test('Add workspace opens as a modal that dims and blocks the rest of the app', async ({ page }) => {
  const posts: unknown[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/gantry/api/status') return route.fulfill({ json: {
      projects: [{ id: 'test', name: 'TEST_add_workspace', workspace: '/fixture/TEST_add_workspace', scopes: [], agents: [], repositories: [], services: [] }],
      tickets: [], previews: [], pulls: [], jobs: [],
    } });
    // The connect request is answered here so no real workspace is ever added.
    if (pathname === '/api/gantry/api/projects' && request.method() === 'POST') { posts.push(request.postDataJSON()); return route.fulfill({ json: { ok: true, projectId: 'test' } }); }
    if (pathname === '/api/setup') return route.fulfill({ json: { ok: true, herdr: { ok: true }, agent: { ok: true } } });
    if (pathname === '/api/agents') return route.fulfill({ json: { agents: [], current: null } });
    return route.fulfill({ status: 400, json: { error: `Unexpected request: ${pathname}` } });
  });

  await page.goto('/');
  const open = page.getByRole('button', { name: 'Add workspace', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Add workspace' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Workspace folder')).toBeFocused();
  expect(await dialog.evaluate(d => getComputedStyle(d, '::backdrop').backgroundColor)).toBe('oklab(0 0 0 / 0.4)');

  // The rest of the app sits behind the backdrop and cannot be reached.
  const refresh = page.getByRole('button', { name: 'Refresh Gantry' });
  const box = (await refresh.boundingBox())!;
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[aria-label="Refresh Gantry"]') ?? null, [box.x + box.width / 2, box.y + box.height / 2])).toBeNull();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  await page.screenshot({ path: test.info().outputPath('add-workspace-dialog.png') });

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();

  await open.click();
  await expect(dialog.getByRole('button', { name: 'Connect workspace' })).toBeDisabled();
  await dialog.getByLabel('Workspace folder').fill('  /fixture/TEST_add_workspace_new  ');
  await dialog.getByRole('button', { name: 'Connect workspace' }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toEqual([{ workspace: '/fixture/TEST_add_workspace_new', initialize: true }]);
});
