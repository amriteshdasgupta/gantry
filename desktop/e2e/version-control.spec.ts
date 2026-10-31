import { test, expect } from '@playwright/test';

test('a workspace chooses its version control provider from its settings modal', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings for Fixture workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fixture workspace settings' });
  await expect(dialog.getByText('git@gitlab.com:grp/frontend.git')).toBeVisible();

  await dialog.getByLabel('Provider for frontend').selectOption('bitbucket');
  await expect(dialog.getByLabel('Provider for frontend')).toHaveValue('bitbucket');
  await expect(dialog.getByText('detected gitlab')).toBeHidden();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await page.getByRole('button', { name: 'Settings for Fixture workspace' }).click();
  await expect(dialog.getByLabel('Provider for frontend')).toHaveValue('bitbucket');

  await dialog.getByRole('link', { name: 'Manage access tokens' }).click();
  await expect(page.getByRole('tab', { name: 'Version control' })).toHaveAttribute('aria-selected', 'true');
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
  await expect(page.getByLabel('GitLab token')).toHaveValue('');

  await page.reload();
  await expect(gitlab.getByText('Token saved')).toBeVisible();
  await gitlab.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText('Signed in as fixture-user')).toBeVisible();
});
