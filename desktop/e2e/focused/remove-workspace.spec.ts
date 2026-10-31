import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** Everything here acts only on a throwaway TEST_ workspace this test creates. */
const NAME = 'TEST_remove_workspace';
const TICKET = 'TEST_remove_workspace_ticket';

test('Remove workspace keeps data for re-adding, or deletes it', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-remove-'));
  const folder = path.join(root, NAME);
  fs.mkdirSync(folder);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: folder });
  git('init', '-b', 'main');
  git('commit', '--allow-empty', '-m', 'init');

  const status = async () => (await page.request.get('/api/gantry/api/status')).json() as Promise<{ projects: { id: string; name: string }[]; tickets: { title: string; projectId: string }[] }>;
  const connect = async () => {
    const response = await page.request.post('/api/gantry/api/projects', { data: { workspace: folder, initialize: true } });
    expect(response.ok()).toBe(true);
    return (await response.json() as { projectId: string }).projectId;
  };
  const openDialog = async (p: Page) => {
    await p.getByRole('button', { name: `Actions for ${NAME}` }).click();
    await p.getByRole('menuitem', { name: 'Remove workspace' }).click();
    return p.getByRole('dialog', { name: `Remove ${NAME}?` });
  };
  let projectId = '';
  try {
    projectId = await connect();
    expect((await page.request.post(`/api/gantry/api/projects/${projectId}/tickets`, { data: { title: TICKET } })).ok()).toBe(true);
    await page.goto(`/?workspace=${projectId}`);
    const entry = page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: NAME, exact: true });
    await expect(entry).toBeVisible();

    const dialog = await openDialog(page);
    const keep = dialog.getByRole('button', { name: 'Remove and keep data' });
    const erase = dialog.getByRole('button', { name: 'Remove and delete data' });
    await expect(keep).toBeVisible();
    await expect(erase).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(entry).toBeVisible();

    await (await openDialog(page)).getByRole('button', { name: 'Remove and keep data' }).click();
    await expect(entry).toHaveCount(0);
    expect((await status()).projects.some(p => p.id === projectId)).toBe(false);

    await connect();
    await expect(entry).toBeVisible({ timeout: 15_000 });
    expect((await status()).tickets.filter(t => t.projectId === projectId).map(t => t.title)).toEqual([TICKET]);

    const second = await openDialog(page);
    await page.screenshot({ path: test.info().outputPath('remove-workspace-dialog.png') });
    await second.getByRole('button', { name: 'Remove and delete data' }).click();
    await expect(entry).toHaveCount(0);

    await connect();
    await expect(entry).toBeVisible({ timeout: 15_000 });
    expect((await status()).tickets.filter(t => t.projectId === projectId)).toEqual([]);
    expect(fs.existsSync(path.join(folder, 'gantry.yaml'))).toBe(true);
  } finally {
    if (projectId) await page.request.delete(`/api/gantry/api/projects/${projectId}`, { data: { confirm: true, deleteData: true } });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
