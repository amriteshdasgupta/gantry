import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('a saved visit-limit wait offers direct approval and resumes its correction route', async ({ page, request }) => {
  const graph = {
    entryNodeId: 'build',
    nodes: [
      { id: 'build', label: 'Implement', kind: 'agent', instructions: 'Implement the fixture', dependsOn: [], maxAttempts: 1 },
      { id: 'review', label: 'Review', kind: 'agent', instructions: 'Review the fixture', dependsOn: [] },
    ],
    edges: [{ id: 'review-build', source: 'review', target: 'build', label: 'Fix requested changes' }],
  };
  await request.post('/api/gantry/api/projects/fixture/tickets', { data: { title: 'Attempt limit fixture' } });
  await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'in_progress' } });
  const file = path.join(path.resolve('e2e/.tmp/home'), 'workflow-runs', 'ticket-1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    ticketId: 'ticket-1', projectId: 'fixture', graph, state: 'waiting', defaultProviderId: 'codex', updatedAt: 1,
    message: 'Visit limit reached for Implement. Fix the two workspace-context defects.',
    steps: { build: 'done', review: 'failed' }, activeNodeId: 'review',
    routing: { nodeId: 'review', outcome: 'changes_requested', summary: 'Fix the two workspace-context defects.' },
    attempts: [{ id: 'a1', nodeId: 'build', startedAt: 1, endedAt: 2, state: 'done', summary: 'Implemented', output: '', providerId: 'codex', providerKind: 'codex', model: '', commits: {} }],
  }));
  await page.goto('/');
  await page.locator('article').filter({ hasText: 'Attempt limit fixture' }).getByRole('button').first().click();
  await expect(page.getByText('Implement · attempt limit reached', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Choose how to continue' }).getByText(/has used 1 attempt.*\(limit: 1\)/)).toBeVisible();
  for (const count of [1, 3, 5]) await expect(page.getByRole('button', { name: `Allow ${count} more attempt${count === 1 ? '' : 's'}`, exact: true })).toBeEnabled();
  await page.getByLabel('Workflow reply').fill('Address both defects and validate workspace isolation.');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/workflow-execution') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Allow 3 more attempts', exact: true }).click();
  const result = await (await response).json();
  expect(result.error).toBeUndefined();
  expect(result.state).toBe('running');
  expect(result.activeNodeId).toBe('build');
  expect(result.graph.nodes[0].maxAttempts).toBe(4);
  expect(result.decision).toBeUndefined();
  expect(result.replies.at(-1).message).toContain('Address both defects');
  expect(result.routes.at(-1).edgeId).toBe('review-build');
  await request.post('/api/workflow-execution', { data: { ticketId: 'ticket-1', action: 'pause' } });
});
