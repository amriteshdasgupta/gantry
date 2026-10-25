import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
async function add(page: Page, name: string) {
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await page.getByLabel('Node name').fill(name);
  await page.getByLabel('Node instructions').fill(`Instructions for ${name}`);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}
async function drag(page: Page, label: string, dx: number, dy: number) {
  const b = (await page.getByRole('button', { name: `Edit node ${label}`, exact: true }).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}
async function link(page: Page, from: string, to: string, label: string) {
  const a = (await page.getByRole('button', { name: `Connect from ${from}`, exact: true }).boundingBox())!,
    b = (await page.getByRole('button', { name: `Connect into ${to}`, exact: true }).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: 'Name this connection' })).toBeVisible();
  await page.getByLabel('Connection condition').fill(label);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}
test('full-page canvas supports dragging, connecting, model selection and saved layouts', async ({ page, request }) => {
  await request.post('/api/gantry/api/projects/fixture/workflow', { data: { nodes: [], edges: [], autoStart: false } });
  await page.goto('/?workspace=fixture&view=workflow');
  await expect(page.getByRole('heading', { name: 'Workspace graph', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await add(page, 'Plan');
  await drag(page, 'Plan', 0, -60);
  await add(page, 'Implement');
  await drag(page, 'Implement', 360, 80);
  await link(page, 'Plan', 'Implement', 'When the plan is ready to implement');
  await page.getByRole('button', { name: 'Edit node Plan', exact: true }).click();
  await expect(page.getByLabel('Node model')).toHaveJSProperty('tagName', 'SELECT');
  await page.getByLabel('Node model').selectOption('sonnet');
  await page.getByLabel('Node reasoning effort').selectOption('high');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('Owner', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Start after', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  const graph = await (await request.get('/api/gantry/api/projects/fixture/workflow')).json();
  expect(graph.nodes[0].model).toBe('sonnet');
  expect(graph.nodes[0].reasoningEffort).toBe('high');
  expect(graph.nodes[1].position.x).toBeGreaterThan(400);
  expect(graph.edges[0].label).toBe('When the plan is ready to implement');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit connection Plan to Implement' })).toContainText('When the plan is ready');
  await page.screenshot({ path: 'e2e/.tmp/workflow-canvas-wide.png' });
  await page.setViewportSize({ width: 900, height: 650 });
  await page.getByRole('button', { name: 'Fit graph' }).click();
  await page.screenshot({ path: 'e2e/.tmp/workflow-canvas-compact.png' });
  await page.getByRole('button', { name: 'Edit connection Plan to Implement' }).click();
  await page.getByRole('button', { name: 'Delete connection' }).click();
  await expect(page.getByRole('button', { name: 'Edit connection Plan to Implement' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit node Plan', exact: true }).click();
  await page.screenshot({ path: 'e2e/.tmp/workflow-node-settings.png' });
  await page.getByRole('button', { name: 'Close editor' }).click();
});
test('coordinator follows named edges and preserves its separate chat through a correction loop', async ({ page, request }) => {
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), { force: true });
  const graph = {
    autoStart: true,
    entryNodeId: 'plan',
    nodes: ['plan', 'build', 'review', 'merge'].map((id, i) => ({
      id,
      label: id[0].toUpperCase() + id.slice(1),
      instructions: `Run ${id}`,
      kind: 'agent',
      dependsOn: [],
      position: { x: 60 + i * 290, y: 100 },
    })),
    edges: [
      { id: 'edge-plan', source: 'plan', target: 'build', label: 'When completed successfully' },
      { id: 'edge-build', source: 'build', target: 'review', label: 'When ready for review' },
      { id: 'edge-fix', source: 'review', target: 'build', label: 'If review finds issues to fix' },
      { id: 'edge-merge', source: 'review', target: 'merge', label: 'When review passes' },
    ],
  };
  await request.post('/api/gantry/api/projects/fixture/workflow', { data: graph });
  await request.post('/api/gantry/api/projects/fixture/tickets', { data: { title: 'Named edge routing' } });
  await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'in_progress' } });
  await expect.poll(async () => (await (await request.get('/api/workflow-execution?ticketId=ticket-1')).json())?.state, { timeout: 40000 }).toBe('complete');
  const run = await (await request.get('/api/workflow-execution?ticketId=ticket-1')).json();
  expect(run.attempts.map((a: { nodeId: string }) => a.nodeId)).toEqual(['plan', 'build', 'review', 'build', 'review', 'merge']);
  expect(run.routes.map((r: { edgeId: string | null }) => r.edgeId)).toEqual(['edge-plan', 'edge-build', 'edge-fix', 'edge-build', 'edge-merge', null]);
  expect(run.coordinatorSessionId).toBe('coordinator-fixture');
  await page.goto('/');
  await page.locator('article').filter({ hasText: 'Named edge routing' }).getByRole('button').first().click();
  await expect(page.getByText('Automation · complete', { exact: true })).toBeVisible();
  await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'done' } });
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), { force: true });
});

test('exports and imports a workspace draft without saving until requested', async ({ page, request }) => {
  await request.post('/api/gantry/api/projects/fixture/workflow', { data: { nodes: [], edges: [], autoStart: false } });
  await page.goto('/?workspace=fixture&view=workflow');
  await add(page, 'Portable node');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export graph', exact: true }).click();
  const download = await downloadPromise;
  const exported = fs.readFileSync((await download.path())!, 'utf8');
  expect(JSON.parse(exported).graph.nodes[0].label).toBe('Portable node');

  await page.getByLabel('Import graph file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(page.getByRole('alert').filter({ hasText: 'Unable to import' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit node Portable node', exact: true })).toBeVisible();

  await add(page, 'Discarded node');
  const file = { name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(exported) };
  await page.getByLabel('Import graph file').setInputFiles(file);
  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page.getByRole('button', { name: 'Edit node Discarded node', exact: true })).toBeVisible();
  await page.getByLabel('Import graph file').setInputFiles(file);
  await page.getByRole('button', { name: 'Replace draft' }).click();
  await expect(page.getByRole('button', { name: 'Edit node Discarded node', exact: true })).toHaveCount(0);
  expect((await (await request.get('/api/gantry/api/projects/fixture/workflow')).json()).nodes).toEqual([]);
  await page.getByRole('button', { name: 'Save graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit node Portable node', exact: true })).toBeVisible();
});
