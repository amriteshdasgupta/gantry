import { test, expect } from '@playwright/test';

test('Settings picks a version control provider and saves its token', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Version control' })).toBeVisible();
  await expect(page.getByText('git@gitlab.com:grp/frontend.git')).toBeVisible();

  await page.getByLabel('Provider for frontend').selectOption('bitbucket');
  await expect(page.getByText('frontend uses bitbucket')).toBeVisible();
  await page.getByLabel('Provider for frontend').selectOption('gitlab');

  const gitlab = page.locator('div.rounded-lg', { has: page.getByLabel('GitLab token') });
  await page.getByLabel('GitLab token').fill('glpat-test');
  await gitlab.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('GitLab saved')).toBeVisible();
  await expect(gitlab.getByText('Token saved')).toBeVisible();
  await expect(page.getByLabel('GitLab token')).toHaveValue('');

  await page.reload();
  await expect(page.getByLabel('Provider for frontend')).toHaveValue('gitlab');
  await expect(gitlab.getByText('Token saved')).toBeVisible();
  await gitlab.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText('Signed in as fixture-user')).toBeVisible();
});
