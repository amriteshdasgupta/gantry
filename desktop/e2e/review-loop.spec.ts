import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const savedFiles = new Map<string, Buffer | null>();

test.beforeEach(() => {
  for (const file of ['claude-calls.jsonl', 'chats/local_fixture_pull_1.json']) {
    const location = path.resolve('e2e/.tmp/home', file);
    savedFiles.set(location, fs.existsSync(location) ? fs.readFileSync(location) : null);
  }
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), { force: true });
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'ticket-conversations/ticket-1.json'), { force: true });
});

test.afterEach(async ({ request }) => {
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'fail-comments'), { force: true });
  await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'done' } });
  await request.get('/api/gantry/api/status');
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), { force: true });
  for (const [file, contents] of savedFiles) {
    if (contents) fs.writeFileSync(file, contents);
    else fs.rmSync(file, { force: true });
  }
  savedFiles.clear();
});

test('review graph restarts implementation with durable PR and local discussion context', async ({ page, request }, testInfo) => {
  const graph = {
    autoStart: false,
    nodes: [
      { id: 'plan', kind: 'agent', label: 'Plan', instructions: 'Plan the fixture', dependsOn: [] },
      { id: 'build', kind: 'agent', label: 'Implement', instructions: 'Build the fixture', dependsOn: ['plan'] },
      { id: 'verify', kind: 'agent', label: 'Verify', instructions: 'Verify the fixture', dependsOn: ['build'] },
    ],
  };
  expect((await request.post('/api/gantry/api/projects/fixture/workflow', { data: graph })).ok()).toBe(true);
  await request.post('/api/gantry/api/projects/fixture/tickets', { data: { title: 'Review correction fixture' } });
  await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'in_progress' } });
  expect((await request.post('/api/workflow-execution', { data: { ticketId: 'ticket-1', action: 'start' } })).ok()).toBe(true);
  const execution = async () => (await request.get('/api/workflow-execution?ticketId=ticket-1')).json();
  await expect.poll(async () => (await execution())?.state).toBe('complete');
  const before = await execution();
  const status = await (await request.get('/api/gantry/api/status')).json();
  const spaceId = status.tickets[0].reviewSpaceId;
  const targetId = 'local/fixture/pull/1';
  const payload = { targetId, spaceId, nodeId: 'build', expectedUpdatedAt: before.updatedAt, confirm: true };
  expect((await request.post('/api/review-loop', { data: payload, headers: { Origin: 'https://example.com' } })).status()).toBe(403);
  expect((await request.post('/api/review-loop', { data: { ...payload, confirm: false } })).ok()).toBe(false);
  const invalid = await request.post('/api/review-loop', { data: { ...payload, nodeId: 'missing' } });
  expect((await invalid.json()).error).toContain('Choose a stage');
  fs.writeFileSync(path.resolve('e2e/.tmp', 'home', 'fail-comments'), 'offline');
  const failedRefresh = await request.post('/api/review-loop', { data: payload });
  expect((await failedRefresh.json()).error).toContain('Could not refresh PR feedback');
  expect(await execution()).toEqual(before);
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'fail-comments'));

  // The dialog resolves the exact embedded space instead of guessing a ticket from the PR.
  await page.goto(`/space/${spaceId}?pr=${encodeURIComponent(targetId)}`);
  await page.getByRole('button', { name: 'Questions about the whole change' }).click();
  const composer = page.getByPlaceholder('Ask about the whole change…');
  await composer.fill('Keep the public API stable during this correction.');
  await composer.press('Enter');
  await expect(page.getByText('Looks fine.', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Review loop', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Restart graph from review' });
  await expect(dialog.getByLabel('Workflow graph')).toBeVisible();
  await expect(dialog.getByLabel('Selected workflow stage')).toHaveValue('build');
  await dialog.locator('[data-step-id="verify"]').click();
  await expect(dialog.getByLabel('Selected workflow stage')).toHaveValue('verify');
  await dialog.getByLabel('Selected workflow stage').selectOption('build');
  await dialog.getByLabel('Review loop instructions').fill('Add regression coverage for the reviewer’s empty input case.');
  await page.screenshot({ path: testInfo.outputPath('review-loop.png') });
  await dialog.getByRole('button', { name: 'Restart with review feedback' }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await execution())?.attempts.length).toBe(before.attempts.length + 2);
  await expect.poll(async () => (await execution())?.state).toBe('complete');
  const after = await execution();
  expect(after.attempts.map((a: { nodeId: string }) => a.nodeId)).toEqual(['plan', 'build', 'verify', 'build', 'verify']);
  expect(after.reviewFeedback).toHaveLength(1);
  const feedback = JSON.stringify(after.reviewFeedback);
  for (const text of ['src/util.py:1-2', 'empty **name**', 'Ready for review!', 'Keep the public API stable', 'Add regression coverage'])
    expect(feedback).toContain(text);

  const calls = fs
    .readFileSync(path.resolve('e2e/.tmp', 'home', 'claude-calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const call of calls.filter((c: { prompt: string }) => c.prompt.includes('PR review feedback') && c.prompt.includes('Add regression coverage'))) {
    expect(call.prompt).toContain('discussion_r11');
    expect(call.prompt).toContain('Keep the public API stable');
  }
  expect(calls.filter((c: { prompt: string }) => c.prompt.includes('PR review feedback') && c.prompt.includes('Add regression coverage'))).toHaveLength(2);
  const saved = JSON.parse(fs.readFileSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), 'utf8'));
  expect(saved.reviewFeedback).toEqual(after.reviewFeedback);

  const stale = await request.post('/api/review-loop', { data: { targetId, spaceId, nodeId: 'build', expectedUpdatedAt: before.updatedAt, confirm: true } });
  expect(stale.ok()).toBe(false);
  expect((await stale.json()).error).toContain('workflow changed');
  expect((await execution()).attempts).toHaveLength(5);
});
