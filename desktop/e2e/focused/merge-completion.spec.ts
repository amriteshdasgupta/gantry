import { test, expect } from '@playwright/test';

test('merge completion moves the linked ticket without reload or waiting for polling', async ({ page }, testInfo) => {
  const label = 'TEST_d193df13';
  const id = `${label}/repo/pull/1`;
  const ticket = { id: 'merge', title: `${label}_ticket`, projectId: 'test', status: 'in_progress', description: '', scope: 'both', branch: 'test/merge', run: null, pullRequests: [], artifacts: [], reviewSpaceId: 'space-merge' };
  const space = { id: 'space-merge', name: `${label}_review`, targets: [id], active: id, files: {} };
  const unexpected: string[] = [];
  let merges = 0;
  let statusReads = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === '/api/gantry/api/status') {
      statusReads++;
      return json({ projects: [{ id: 'test', name: `${label}_workspace`, scopes: [], agents: [], repositories: [], services: [] }], tickets: [ticket], previews: [], pulls: [], jobs: [] });
    }
    if (path === '/api/agents') return json({ agents: [], current: null });
    if (path === '/api/spaces') return json(request.method() === 'GET' ? { current: space.id, spaces: [space] } : space);
    if (path === '/api/target') return json({ target: { id, kind: 'pull', title: `${label}_PR`, owner: label, repo: 'repo', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), prState: merges ? 'merged' : 'open', url: `https://github.com/${id}` }, files: [], messages: [], pending: null, queued: [] });
    if (path === '/api/local-changes') return json({ files: [], commits: 0, head: 'a'.repeat(40), tree: 'c'.repeat(40) });
    if (path === '/api/comments') return json({ comments: [], reviews: [], threads: [] });
    if (path === '/api/chat/events') return route.fulfill({ contentType: 'text/event-stream', body: ': test\n\n' });
    if (path === '/api/merge') { merges++; ticket.status = 'done'; return json({ merged: true, warning: null }); }
    // The setup banner checks for herdr and a coding CLI; these fixtures have both.
    if (path === '/api/setup') return json({ ok: true, herdr: { ok: true, detail: '' }, agent: { ok: true, detail: '' } });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 400, json: { error: 'Unmocked request blocked' } });
  });
  await page.clock.install({ time: new Date("2026-10-18T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-18T00:00:01Z"));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Ticket board' })).toHaveCSS('display', 'grid');
  await expect(page.getByRole('region', { name: 'In progress', exact: true }).locator('[data-ticket-id="merge"]')).toBeVisible();
  // Timers remain paused: completion must use the merge notification.
  await page.getByRole('button', { name: `Open review space for ${label}_ticket` }).click();
  await page.getByRole('button', { name: 'Merge PR', exact: true }).click();
  const readsBeforeMerge = statusReads;
  await page.getByRole('button', { name: 'Confirm merge' }).click();
  await expect.poll(() => merges).toBe(1);
  await expect.poll(() => statusReads).toBeGreaterThan(readsBeforeMerge);
  await page.getByRole('navigation', { name: 'Gantry workspace' }).getByRole('button', { name: /Tickets/ }).click();
  await expect(page.getByRole('region', { name: 'Done', exact: true }).locator('[data-ticket-id="merge"]')).toBeVisible();
  expect(unexpected).toEqual([]);
  const evidenceDir = process.env.GANTRY_EVIDENCE_DIR;
  const screenshot = evidenceDir && evidenceDir !== 'undefined' ? `${evidenceDir}/final.png` : testInfo.outputPath('final.png');
  await page.screenshot({ path: screenshot, fullPage: true });
});
