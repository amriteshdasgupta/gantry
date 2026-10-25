import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('edits the creation graph, preserves failed drafts, and returns to the board', async ({ page, request }) => {
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), { force: true });
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'ticket-conversations/ticket-1.json'), { force: true });
  const before = await (await request.get('/api/gantry/api/projects/fixture/workflow-templates')).json();
  const graph = {
    autoStart: false,
    entryNodeId: 'build',
    nodes: [{ id: 'build', label: 'Build draft', kind: 'agent', instructions: 'Original instructions', dependsOn: [] }],
    edges: [],
  };
  const response = await request.post('/api/gantry/api/projects/fixture/workflow-templates', {
    data: { name: 'Creation draft graph', graph },
  });
  const template = await response.json();
  await page.goto('/?workspace=fixture');
  await page.getByRole('button', { name: 'New ticket', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New ticket', exact: true });
  await dialog.getByLabel('Title', { exact: true }).fill('Complete creation draft');
  await dialog.getByLabel('Notes', { exact: true }).fill('All context supplied before creation.');
  await dialog.getByLabel('Workspace graph template', { exact: true }).selectOption(template.id);
  await dialog.getByRole('button', { name: 'Edit node Build draft', exact: true }).click();
  await page.getByLabel('Node name').fill('Build with context');
  await page.getByLabel('Node instructions').fill('Implement and validate this ticket.');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.getByRole('switch', { name: 'Run automatically' }).check();
  page.once('dialog', prompt => prompt.dismiss());
  await dialog.getByLabel('Workspace graph template', { exact: true }).selectOption('default');
  await expect(dialog.getByLabel('Workspace graph template', { exact: true })).toHaveValue(template.id);
  page.once('dialog', prompt => prompt.dismiss());
  await dialog.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(dialog).toBeVisible();

  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/gantry/api/projects/fixture/tickets', async route => {
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) return route.fulfill({ status: 400, json: { error: 'Retry creation' } });
    return route.continue();
  });
  await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click();
  await expect(page.getByText('Retry creation', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Edit node Build with context', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Complete creation draft');
  await page.screenshot({ path: 'e2e/.tmp/new-ticket-creation-wide.png' });
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(dialog.getByRole('button', { name: 'Edit node Build with context', exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByLabel('Workflow canvas', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e/.tmp/new-ticket-creation-narrow.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole('button', { name: 'Create ticket', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  const run = await (await request.get('/api/gantry/api/tickets/ticket-1/workflow')).json();
  expect(run.graph.autoStart).toBe(true);
  expect(run.graph.nodes[0].instructions).toBe('Implement and validate this ticket.');
  const templates = await (await request.get('/api/gantry/api/projects/fixture/workflow-templates')).json();
  expect(templates.find((item: { id: string }) => item.id === template.id).graph).toEqual(graph);
  expect(templates[0]).toEqual(before[0]);
  await page.locator('article').filter({ hasText: 'Complete creation draft' }).getByRole('button').first().click();
  await expect(page.getByLabel('Selected workflow stage')).toHaveValue('build');
  await expect(page.getByText('All context supplied before creation.', { exact: true })).toBeVisible();
});

test('selects named graphs and saves an unsaved ticket draft as a separate template', async ({ page, request }) => {
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), { force: true });
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'ticket-conversations/ticket-1.json'), { force: true });
  const graph = {
    autoStart: false,
    nodes: [{ id: 'fix', label: 'Quick fix', kind: 'agent', instructions: 'Implement and verify.', dependsOn: [] }],
  };
  const added = await request.post('/api/gantry/api/projects/fixture/workflow-templates', {
    data: { name: 'Quick fixes', graph },
  });
  expect(added.status()).toBe(201);
  const template = await added.json();
  const defaultBefore = await (await request.get('/api/gantry/api/projects/fixture/workflow')).json();

  await page.goto('/?workspace=fixture');
  await page.getByRole('button', { name: 'New ticket', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Use a named graph');
  await page.getByLabel('Workspace graph template', { exact: true }).selectOption(template.id);
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('article').filter({ hasText: 'Use a named graph' }).getByRole('button').first().click();
  await expect(page.getByLabel('Selected workflow stage')).toHaveValue('fix');
  await page.getByRole('button', { name: 'Edit graph', exact: true }).click();
  await page.getByRole('button', { name: 'Edit node Quick fix', exact: true }).click();
  await page.getByLabel('Node name').fill('Ticket draft fix');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Add as workspace graph template', exact: true }).click();
  await page.getByLabel('Template name', { exact: true }).fill('Quick fixes');
  await page.getByRole('button', { name: 'Add template', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Duplicate' })).toBeVisible();
  await page.getByLabel('Template name', { exact: true }).fill('Ticket draft template');
  await page.getByRole('button', { name: 'Add template', exact: true }).click();
  await expect(page.getByText('Workspace graph template added.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save graph', exact: true })).toBeEnabled();

  const ticketRun = await (await request.get('/api/gantry/api/tickets/ticket-1/workflow')).json();
  expect(ticketRun.graph.nodes[0].label).toBe('Quick fix');
  expect(ticketRun.revision).toBe(0);
  const templates = await (await request.get('/api/gantry/api/projects/fixture/workflow-templates')).json();
  const saved = templates.find((item: { name: string }) => item.name === 'Ticket draft template');
  expect(saved.graph.nodes[0].label).toBe('Ticket draft fix');
  expect(saved.graph.autoStart).toBe(false);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.goto('/?workspace=fixture&view=workflow');
  await page.getByLabel('Workspace graph template', { exact: true }).selectOption(saved.id);
  await expect(page.getByRole('button', { name: 'Edit node Ticket draft fix', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit node Ticket draft fix', exact: true }).click();
  await page.getByLabel('Node name').fill('Updated template');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByLabel('Workspace graph template', { exact: true }).selectOption('default');
  await expect(page.getByLabel('Workspace graph template', { exact: true })).toHaveValue(saved.id);
  await expect(page.getByRole('button', { name: 'Edit node Updated template', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByLabel('Workspace graph template', { exact: true }).selectOption(saved.id);
  await expect(page.getByRole('button', { name: 'Edit node Updated template', exact: true })).toBeVisible();
  expect(await (await request.get('/api/gantry/api/projects/fixture/workflow')).json()).toEqual(defaultBefore);
  expect((await (await request.get('/api/gantry/api/tickets/ticket-1/workflow')).json()).graph.nodes[0].label).toBe('Quick fix');
});
