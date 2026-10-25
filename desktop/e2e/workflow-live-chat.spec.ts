import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
test.beforeEach(() => {
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'workflow-runs/ticket-1.json'), { force: true });
});

test('a running stage chat opens only after pausing, since herdr resumes the same session', async ({ page, request }) => {
  const graph = {
    entryNodeId: 'plan',
    nodes: [{ id: 'plan', label: 'Plan', kind: 'agent', instructions: 'Plan', dependsOn: [] }],
    edges: [],
  };
  await request.post('/api/gantry/api/projects/fixture/workflow', { data: graph });
  await request.post('/api/gantry/api/projects/fixture/tickets', { data: { title: 'Live chat fixture' } });
  const actions: string[] = [];
  await page.route('**/api/workflow-execution*', async (route) => {
    if (route.request().method() === 'POST') actions.push(route.request().postDataJSON().action);
    await route.fulfill({
      json: {
        graph,
        state: 'running',
        message: 'Plan is running.',
        steps: { plan: 'running' },
        attempts: [{
          id: 'attempt',
          nodeId: 'plan',
          sessionId: 'live-codex',
          providerKind: 'codex',
          state: 'running',
          output: 'Working…',
          summary: '',
          startedAt: Date.now(),
        }],
      },
    });
  });
  await page.goto('/');
  await page.locator('article').filter({ hasText: 'Live chat fixture' }).getByRole('button').first().click();
  await page.getByText('Advanced: individual stage chat', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open stage chat' })).toBeDisabled();
  expect(actions).toEqual([]);
  await expect(page.getByText('Automation · running')).toBeVisible();
});

test('Codex conversation creation and reopening still preserve the native session', async ({ request }) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const association = path.resolve('e2e/.tmp', 'home', 'ticket-conversations/ticket-1.json');
  fs.rmSync(association, {force:true});
  const created = await request.post('/api/agents', {data:{kind:'codex',name:'Live Codex fixture'}});
  const agent = await created.json();
  await request.patch('/api/agents', {data:{id:agent.id,current:true}});
  await request.post('/api/gantry/api/tickets/ticket-1/update', {data:{status:'in_progress'}});
  try {
    const first = await request.post('/api/ticket-chat', {data:{ticketId:'ticket-1',action:'open'}});
    expect(first.ok(), await first.text()).toBe(true);
    const opened = await first.json();
    const again = await request.post('/api/ticket-chat', {data:{ticketId:'ticket-1',action:'open'}});
    expect(again.ok(), await again.text()).toBe(true);
    expect((await again.json()).conversation.sessionId).toBe(opened.conversation.sessionId);
  } finally {
    await request.patch('/api/agents', {data:{id:'claude',current:true}});
    fs.rmSync(association, {force:true});
  }
});
