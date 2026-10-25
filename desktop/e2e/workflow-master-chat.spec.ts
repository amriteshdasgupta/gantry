import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const home = path.resolve('e2e/.tmp/home');
const runFile = path.join(home, 'workflow-runs/ticket-1.json');
const masterFile = path.join(home, 'ticket-conversations/master/ticket-1.json');
test.beforeEach(() => {
  fs.rmSync(runFile, { force: true });
  fs.rmSync(masterFile, { force: true });
});

test('graph tickets open one master chat that sees the graph and can drive it', async ({ request }) => {
  const graph = { nodes: [{ id: 'plan', label: 'Plan', kind: 'agent', instructions: 'Plan', dependsOn: [] }, { id: 'build', label: 'Build', kind: 'agent', instructions: 'Build', dependsOn: ['plan'] }] };
  expect((await request.post('/api/gantry/api/projects/fixture/workflow', { data: graph })).ok()).toBe(true);
  await request.post('/api/gantry/api/projects/fixture/tickets', { data: { title: 'Master chat fixture' } });
  expect((await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'in_progress' } })).ok()).toBe(true);
  const previous = await (await request.get('/api/agents')).json();
  await request.patch('/api/agents', { data: { id: 'claude', current: true } });
  const plainChat = path.join(home, 'ticket-conversations/ticket-1.json');
  const plainBefore = fs.existsSync(plainChat) ? fs.readFileSync(plainChat, 'utf8') : null;
  // A paused run with one finished stage; the master chat must not start or change it.
  const run = {
    ticketId: 'ticket-1', projectId: 'fixture', graph, state: 'paused', message: 'Paused by you.',
    steps: { plan: 'done', build: 'pending' }, defaultProviderId: 'claude', updatedAt: 1,
    attempts: [{ id: 'a1', nodeId: 'plan', startedAt: 1, endedAt: 2, state: 'done', summary: 'Planned the master chat fixture', output: 'x'.repeat(5000), providerId: 'codex', providerKind: 'codex', sessionId: 'stage-plan-fixture', model: '', commits: {} }],
  };
  fs.mkdirSync(path.dirname(runFile), { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify(run));

  const opened = await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'open' } });
  const body = await opened.json();
  expect(opened.ok(), body.error).toBe(true);
  expect(body.master).toBe(true);
  expect(body.conversation.provider).toBe('claude');
  const record = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
  expect(record.sessionId).toBe(body.conversation.sessionId);
  // The plain ticket chat would block automation; the master chat leaves it alone.
  expect(fs.existsSync(plainChat) ? fs.readFileSync(plainChat, 'utf8') : null).toBe(plainBefore);

  const launch = JSON.stringify(fs.readFileSync(path.join(home, 'external-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.command === 'herdr' && c.args[1] === 'run').at(-1));
  expect(launch).toContain('master chat');
  expect(launch).toContain('Planned the master chat fixture');
  expect(launch).toContain('/api/workflow-execution');
  expect(launch).toContain(body.conversation.sessionId);
  expect(launch).not.toContain('--allowedTools');
  expect(launch).not.toContain('x'.repeat(200));

  const summary = await (await request.post('/api/workflow-execution', { data: { ticketId: 'ticket-1', action: 'summary' } })).json();
  expect(summary.state).toBe('paused');
  expect(summary.stages.map((s: { id: string; state: string }) => [s.id, s.state])).toEqual([['plan', 'done'], ['build', 'pending']]);
  expect(summary.stages[0].lastSummary).toBe('Planned the master chat fixture');
  expect(JSON.stringify(summary)).not.toContain('x'.repeat(200));
  expect(JSON.parse(fs.readFileSync(runFile, 'utf8')).state).toBe('paused');

  const again = await (await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'open' } })).json();
  expect(again.conversation.sessionId).toBe(body.conversation.sessionId);
  const layout = () => JSON.parse(fs.readFileSync(path.join(home, 'terminal-launcher-state.json'), 'utf8')).herdr.tickets['ticket-1'];
  const beforeStage = layout();
  expect(beforeStage.layout).toBe('ticket-space');
  const openStage = () => request.post('/api/workflow-execution', { data: { ticketId: 'ticket-1', action: 'open', nodeId: 'plan' } });
  expect((await openStage()).ok()).toBe(true);
  const afterStage = layout();
  expect(afterStage.workspaceId).toBe(beforeStage.workspaceId);
  const fake = JSON.parse(fs.readFileSync(path.join(home, 'fake-herdr.json'), 'utf8'));
  const masterPane = fake.panes[afterStage.panes[body.conversation.sessionId]];
  const stagePane = fake.panes[afterStage.panes['stage-plan-fixture']];
  expect(masterPane.tab_id).toBe(afterStage.tabId);
  expect(stagePane.tab_id).not.toBe(masterPane.tab_id);
  expect(fake.tabs[masterPane.tab_id].label).toBe('Master');
  expect(fake.tabs[stagePane.tab_id]).toMatchObject({ label: 'Plan', workspace_id: afterStage.workspaceId });
  expect((await openStage()).ok()).toBe(true);
  expect(layout().panes['stage-plan-fixture']).toBe(stagePane.pane_id);
  await request.patch('/api/agents', { data: { id: previous.current, current: true } });
});

test('stages and the master chat run with the workspace stage settings file', async ({ request }) => {
  const settings = path.join(home, 'claude-stage-settings.json');
  fs.writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Bash(git push --force:*)'] } }));
  const calls = path.join(home, 'claude-calls.jsonl');
  const seen = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0;
  try {
    const graph = { nodes: [{ id: 'plan', label: 'Plan', kind: 'agent', instructions: 'Plan the settings fixture', dependsOn: [] }] };
    expect((await request.post('/api/gantry/api/projects/fixture/workflow', { data: graph })).ok()).toBe(true);
    await request.post('/api/gantry/api/projects/fixture/tickets', { data: { title: 'Settings fixture' } });
    await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'in_progress' } });
    const previous = await (await request.get('/api/agents')).json();
    await request.patch('/api/agents', { data: { id: 'claude', current: true } });
    expect((await request.post('/api/workflow-execution', { data: { ticketId: 'ticket-1', action: 'start' } })).ok()).toBe(true);
    const stageCall = () =>
      (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').slice(seen) : [])
        .map((l) => JSON.parse(l) as { args: string[]; prompt: string })
        .find((c) => c.prompt.includes('Plan the settings fixture'));
    await expect.poll(() => !!stageCall(), { timeout: 30000 }).toBe(true);
    const args = stageCall()!.args;
    expect(args[args.indexOf('--settings') + 1]).toBe(settings);
    await request.post('/api/workflow-execution', { data: { ticketId: 'ticket-1', action: 'pause' } });

    expect((await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'open' } })).ok()).toBe(true);
    const launch = JSON.stringify(fs.readFileSync(path.join(home, 'external-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.command === 'herdr' && c.args[1] === 'run').at(-1));
    expect(launch).toContain('--settings');
    expect(launch).toContain(settings);
    await request.patch('/api/agents', { data: { id: previous.current, current: true } });
  } finally {
    fs.rmSync(settings, { force: true });
  }
});
