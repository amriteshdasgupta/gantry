import { test, expect } from '@playwright/test';

test('moving tickets keeps other chats and reviews available without automatic launch', async ({ page }, testInfo) => {
  const label = 'TEST_f84f8f57';
  const tickets = [
    { id: 'move', title: `${label}_move`, status: 'backlog' },
    { id: 'other', title: `${label}_other`, status: 'in_progress' },
  ].map(t => ({ ...t, projectId: 'test', description: '', scope: 'both', branch: `test/${t.id}`, run: null, pullRequests: [], artifacts: [], reviewSpaceId: `space-${t.id}` }));
  const project = { id: 'test', name: `${label}_workspace`, scopes: [{ id: 'both', label: 'Both' }], agents: [], repositories: [], services: [] };
  let releaseMove!: () => void;
  let pending = false;
  let failMove = false;
  const opens: string[] = [];
  const unexpected: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname === '/api/gantry/api/status') return json({ projects: [project], tickets, previews: [], pulls: [], jobs: [] });
    if (url.pathname === '/api/agents') return json({ agents: [], current: null });
    if (url.pathname === '/api/spaces') return json({ current: 'space-other', spaces: [{ id: 'space-other', name: `${label}_review`, targets: [], files: {} }] });
    if (url.pathname === '/api/ticket-chat') {
      const body = request.postDataJSON();
      if (body.action === 'open') opens.push(body.ticketId);
      return json({ conversation: body.action === 'open' ? { provider: 'codex', providerName: 'TEST_f84f8f57_provider', sessionId: 'test' } : null });
    }
    if (url.pathname === '/api/gantry/api/tickets/move/update') {
      pending = true;
      await new Promise<void>(resolve => { releaseMove = resolve; });
      pending = false;
      if (failMove) return json({ error: 'TEST_f84f8f57 move failed' }, 500);
      Object.assign(tickets[0], request.postDataJSON());
      return json(tickets[0]);
    }
    // The setup banner checks for herdr and a coding CLI; these fixtures have both.
    if (url.pathname === '/api/setup') return json({ ok: true, herdr: { ok: true, detail: '' }, agent: { ok: true, detail: '' } });
    unexpected.push(`${request.method()} ${url.pathname}`);
    return json({ error: 'Unmocked request blocked' }, 400);
  });
  await page.goto('/');
  const card = page.locator('[data-ticket-id="move"]');
  await expect(card).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ticket board' })).toHaveCSS('display', 'grid');
  await card.dragTo(page.getByRole('region', { name: 'In progress', exact: true }));
  await expect.poll(() => pending).toBe(true);
  await expect(card).toHaveAttribute('draggable', 'false');
  expect(opens).toEqual([]);
  await page.getByRole('button', { name: `Open chat for ${label}_other`, exact: true }).click();
  await expect.poll(() => opens).toEqual(['other']);
  await page.getByRole('button', { name: `Open review space for ${label}_other`, exact: true }).click();
  await expect(page.getByText(`${label}_review is empty`, { exact: true })).toBeVisible();
  releaseMove();
  await expect(page.getByText('Moved to In progress', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/review=space-other/);
  expect(opens).toEqual(['other']);
  await page.getByRole('navigation', { name: 'Gantry workspace' }).getByRole('button', { name: /Tickets/ }).click();
  await expect(page.getByRole('region', { name: 'In progress', exact: true }).locator('[data-ticket-id="move"]')).toBeVisible();
  await card.getByRole('button').first().click();
  const stage = page.getByRole('combobox', { name: 'Stage', exact: true });
  failMove = true;
  await stage.selectOption('backlog');
  await expect(stage).toBeDisabled();
  await expect.poll(() => pending).toBe(true);
  releaseMove();
  await expect(page.getByText('TEST_f84f8f57 move failed', { exact: true })).toBeVisible();
  await expect(stage).toBeEnabled();
  await expect(stage).toHaveValue('in_progress');
  failMove = false;
  await stage.selectOption('backlog');
  await expect.poll(() => pending).toBe(true);
  releaseMove();
  await expect(stage).toHaveValue('backlog');
  await expect(stage).toBeEnabled();
  await stage.selectOption('in_progress');
  await expect.poll(() => pending).toBe(true);
  releaseMove();
  await expect(stage).toHaveValue('in_progress');
  await expect(stage).toBeEnabled();
  expect(opens).toEqual(['other']);
  expect(unexpected).toEqual([]);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  const evidenceDir = process.env.GANTRY_EVIDENCE_DIR;
  const screenshot = evidenceDir && evidenceDir !== 'undefined' ? `${evidenceDir}/final.png` : testInfo.outputPath('final.png');
  await page.screenshot({ path: screenshot, fullPage: true });
});
