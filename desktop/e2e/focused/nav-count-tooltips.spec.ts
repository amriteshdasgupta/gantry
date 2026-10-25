import { expect, test } from '@playwright/test';

test('Tickets and Reviews nav counts explain what they count', async ({ page }) => {
  const ticket = (id: string, status: string) => ({ id, projectId: 'test', title: `TEST_nav_tooltip_${id}`, description: '', status, scope: 'both', branch: `ticket/${id}`, position: 0, run: null, artifacts: [], pullRequests: [] });
  const pull = { number: 7, draft: false, ready: true, blockers: [], title: 'Fixture', url: 'https://github.com/local/app/pull/7', branch: 'feature/x', head: 'fixture' };
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/gantry/api/status') return route.fulfill({ json: {
      projects: [{ id: 'test', name: 'TEST_nav_tooltip', workspace: '/fixture/TEST_nav_tooltip', scopes: [], agents: [], repositories: [], services: [] }],
      tickets: [ticket('a', 'in_progress'), ticket('b', 'in_progress'), ticket('c', 'backlog')],
      pulls: [{ id: 'g1', projectId: 'test', branch: 'feature/x', ready: true, blockers: [], previewId: null, previewUrl: null, pulls: { app: pull } }],
      previews: [], jobs: [],
    } });
    if (pathname === '/api/setup') return route.fulfill({ json: { ok: true, herdr: { ok: true, detail: '' }, agent: { ok: true, detail: '' } } });
    if (pathname === '/api/agents') return route.fulfill({ json: { agents: [], current: null } });
    return route.fulfill({ status: 400, json: { error: `Unexpected request: ${pathname}` } });
  });

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Gantry workspace' });
  const ticketsCount = nav.getByLabel('2 tickets in progress', { exact: true });
  const reviewsCount = nav.getByLabel('1 open pull request group awaiting review', { exact: true });
  await expect(ticketsCount).toHaveText('2');
  await expect(reviewsCount).toHaveText('1');

  await ticketsCount.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('2 tickets in progress');
  await reviewsCount.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('1 open pull request group awaiting review');
  await page.screenshot({ path: test.info().outputPath('nav-count-tooltip.png') });

  // The count sits inside the nav button, so clicking it still navigates.
  await reviewsCount.click();
  await expect(page.getByRole('heading', { name: 'Ready for review' })).toBeVisible();
  await expect(nav.getByRole('button', { name: /Reviews/ })).toHaveAttribute('aria-current', 'page');
});
