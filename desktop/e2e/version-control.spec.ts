import { test, expect } from '@playwright/test';

test('a workspace chooses its version control provider from its settings modal', async ({ page }) => {
  const actions = page.getByRole('button', { name: 'Actions for Fixture workspace' });
  await page.goto('/');
  await actions.click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fixture workspace settings' });
  await expect(dialog.getByText('git@gitlab.com:grp/frontend.git')).toBeVisible();
  await expect(dialog.getByText('detected GitLab')).toBeVisible();
  await expect(dialog.getByRole('option', { name: 'Auto-detect (GitLab)' })).toBeAttached();

  await dialog.getByLabel('Provider for frontend').selectOption('bitbucket');
  await expect(dialog.getByLabel('Provider for frontend')).toHaveValue('bitbucket');
  await expect(dialog.getByText('detected GitLab')).toBeHidden();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(actions).toBeFocused();

  await page.reload();
  await actions.click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(dialog.getByLabel('Provider for frontend')).toHaveValue('bitbucket');

  await dialog.getByRole('link', { name: 'Manage access tokens' }).click();
  await expect(page.getByRole('tab', { name: 'Version control' })).toHaveAttribute('aria-selected', 'true');
});

test('the modal covers only its workspace and opens from a Reviews listing error', async ({ page }) => {
  const repo = { projectId: 'fixture', projectName: 'Fixture workspace', repositoryId: 'frontend', remoteUrl: 'git@gitlab.com:grp/frontend.git', detected: 'gitlab', provider: 'gitlab', chosen: false, error: 'gitlab.com rejected the token' };
  const saved: unknown[] = [];
  await page.route('**/api/vcs', async (route) => {
    if (route.request().method() === 'POST') { saved.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    await route.fulfill({ json: { providers: {}, gitlabUrl: '', repositories: [repo, { ...repo, projectId: 'other', projectName: 'Other workspace', repositoryId: 'backend', error: null }] } });
  });
  await page.route('**/api/status', async (route) => {
    const json = await (await route.fetch()).json();
    await route.fulfill({ json: { ...json, remote: [{ projectId: 'fixture', repositories: { 'fixture:frontend': { pullError: repo.error } } }] } });
  });

  await page.goto('/');
  await page.getByRole('navigation', { name: 'Gantry workspace' }).getByRole('button', { name: /Reviews/ }).click();
  await page.getByRole('button', { name: 'Open version control settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Fixture workspace settings' });
  await expect(dialog.getByText('gitlab.com rejected the token')).toBeVisible();
  await expect(dialog.getByLabel('Provider for backend')).toHaveCount(0);
  await dialog.getByLabel('Provider for frontend').selectOption('bitbucket');
  await expect.poll(() => saved).toEqual([{ repository: { projectId: 'fixture', repositoryId: 'frontend', provider: 'bitbucket' } }]);
});

test('a missing herdr links to the Chats settings tab', async ({ page }) => {
  await page.route('**/api/setup', (route) => route.fulfill({ json: { ok: false, herdr: { ok: false, detail: 'herdr is missing' }, agent: { ok: true, detail: '' } } }));
  await page.goto('/');
  await page.getByRole('alert').getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Chats open in herdr' })).toBeVisible();
});

test('Settings tabs separate agents, global version control tokens and chats', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await expect(page.getByLabel('GitLab token')).toBeHidden();

  await page.getByRole('tab', { name: 'Chats' }).click();
  await expect(page.getByRole('heading', { name: 'Chats open in herdr' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeHidden();

  await page.getByRole('tab', { name: 'Version control' }).click();
  await expect(page).toHaveURL(/tab=version-control/);
  await expect(page.getByLabel('Provider for frontend')).toBeHidden();

  const gitlab = page.locator('div.rounded-lg', { has: page.getByLabel('GitLab token') });
  await page.getByLabel('GitLab token').fill('glpat-test');
  await gitlab.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('GitLab saved')).toBeVisible();
  await expect(gitlab.getByText('Token saved')).toBeVisible();
  await expect(page.getByLabel('GitLab token')).toHaveValue('glpat-test');
  await expect(gitlab.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await page.reload();
  await expect(gitlab.getByText('Token saved')).toBeVisible();
  await expect(page.getByLabel('GitLab token')).toHaveValue('');
  await expect(page.getByLabel('GitLab token')).toHaveAttribute('placeholder', '••••••••••••••••');
  await gitlab.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText('Signed in as fixture-user')).toBeVisible();

  await page.getByLabel('GitLab token').fill('glpat-test');
  await gitlab.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('GitLab token')).toHaveValue('glpat-test');
  await gitlab.getByRole('button', { name: 'Remove' }).click();
  await expect(gitlab.getByText('No token saved')).toBeVisible();
  await expect(page.getByLabel('GitLab token')).toHaveValue('');
  await expect(page.getByLabel('GitLab token')).toHaveAttribute('placeholder', 'Paste token');
});
