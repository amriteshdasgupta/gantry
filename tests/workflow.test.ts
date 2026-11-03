import { describe, test, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_WORKFLOW, exportWorkflow, importWorkflow, newWorkflow, readySteps, workflowSchema, workflowSummary } from '../packages/shared/src/workflow.js';
import { changeStep, replaceGraph, saveTicketWorkflow, ticketWorkflow } from '../packages/server/src/tickets/workflow.js';
import { TicketStore } from '../packages/server/src/tickets/store.js';
import { openDatabase } from '../packages/server/src/db/db.js';
import { saveWorkspaceWorkflow, workspaceWorkflow, starterWorkflowYaml, saveWorkspaceWorkflowTemplate, workspaceWorkflowTemplates } from '../packages/server/src/projects/workflow.js';
import { loadProject } from '../packages/server/src/projects/registry.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-workflow-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const fork = {
  nodes: [
    { id: 'plan', label: 'Plan', kind: 'agent' as const, instructions: '', dependsOn: [] },
    { id: 'frontend', label: 'Frontend', kind: 'agent' as const, instructions: '', dependsOn: ['plan'] },
    { id: 'backend', label: 'Backend', kind: 'agent' as const, instructions: '', dependsOn: ['plan'] },
    { id: 'review', label: 'Review', kind: 'human' as const, instructions: 'Approve both changes', dependsOn: ['frontend', 'backend'] },
  ],
};
describe('workflow graph', () => {
  test('starter graph and setup example share executable stages and review routes', () => {
    const graph = workflowSchema.parse(DEFAULT_WORKFLOW);
    expect(graph.autoStart).toBe(true);
    expect(graph.nodes.map(node => node.id)).toEqual(['plan', 'implement', 'review', 'create-pr']);
    expect(graph.edges?.filter(edge => edge.source === 'review').map(edge => edge.target)).toEqual(['implement', 'create-pr']);
    expect(graph.nodes.every(node => node.instructions.length > 300 && !node.providerId && !node.model)).toBe(true);
    expect(parse(fs.readFileSync(new URL('../examples/starter-workflow.yaml', import.meta.url), 'utf8')).workflow).toEqual(graph);
    expect(parse(starterWorkflowYaml()).workflow).toEqual(graph);
  });
  test('rejects cycles, unknown dependencies, duplicate ids and empty graphs', () => {
    expect(workflowSchema.safeParse({ nodes: [] }).success).toBe(false);
    expect(workflowSchema.safeParse({ nodes: [fork.nodes[0], fork.nodes[0]] }).success).toBe(false);
    expect(workflowSchema.safeParse({ nodes: [{ ...fork.nodes[0], dependsOn: ['missing'] }] }).success).toBe(false);
    expect(workflowSchema.safeParse({ nodes: [{ ...fork.nodes[0], dependsOn: ['frontend'] }, fork.nodes[1]] }).success).toBe(false);
  });
  test('forks only when ready, joins after both branches, exposes user decisions', () => {
    let run = newWorkflow(fork);
    expect(() => changeStep(run, { nodeId: 'frontend', state: 'running' })).toThrow(/dependencies/);
    run = changeStep(run, { nodeId: 'plan', state: 'done' });
    expect(readySteps(run).map((n) => n.id)).toEqual(['frontend', 'backend']);
    run = changeStep(run, { nodeId: 'frontend', state: 'running' });
    run = changeStep(run, { nodeId: 'backend', state: 'running' });
    expect(workflowSummary(run).current).toEqual(['Frontend', 'Backend']);
    run = changeStep(run, { nodeId: 'frontend', state: 'done' });
    expect(() => changeStep(run, { nodeId: 'review', state: 'done' })).toThrow(/dependencies/);
    run = changeStep(run, { nodeId: 'backend', state: 'done' });
    expect(workflowSummary(run).waiting).toBe(true);
    run = changeStep(run, { nodeId: 'review', state: 'done', message: 'Approved' });
    expect(workflowSummary(run).complete).toBe(true);
  });
  test('requires a waiting reason, supports failure/retry, prevents reopening completed work', () => {
    let run = newWorkflow();
    expect(() => changeStep(run, { nodeId: 'plan', state: 'waiting' })).toThrow(/Describe/);
    run = changeStep(run, { nodeId: 'plan', state: 'waiting', message: 'Which target?' });
    expect(workflowSummary(run).waiting).toBe(true);
    run = changeStep(run, { nodeId: 'plan', state: 'failed' });
    run = changeStep(run, { nodeId: 'plan', state: 'running' });
    run = changeStep(run, { nodeId: 'plan', state: 'done' });
    expect(() => changeStep(run, { nodeId: 'plan', state: 'running' })).toThrow(/cannot be restarted/);
  });
  test('allows pending edits while preserving started work and progress', () => {
    const run = changeStep(newWorkflow(), { nodeId: 'plan', state: 'running' });
    const graph = structuredClone(DEFAULT_WORKFLOW);
    graph.nodes[1]!.label = 'Build';
    expect(replaceGraph(run, graph).states.plan.state).toBe('running');
    graph.nodes[0]!.label = 'Changed';
    expect(() => replaceGraph(run, graph)).toThrow(/not started/);
  });
  test('persists independent ticket snapshots and detects lost updates', () => {
    const db = openDatabase(path.join(dir, 'tickets.db'));
    try {
      db.prepare('INSERT INTO projects (id, name, workspace, config_path, default_agent, default_prompt_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'test',
        'TEST_workspace_graph',
        dir,
        'gantry.yaml',
        'codex',
        'builtin:default',
        '',
        '',
      );
      const store = new TicketStore(db);
      const a = store.create('test', { title: 'TEST_workspace_graph_a' }, [], 'ticket', fork);
      const b = store.create('test', { title: 'TEST_workspace_graph_b' }, [], 'ticket', fork);
      const run = changeStep(ticketWorkflow(a)!, { nodeId: 'plan', state: 'done' });
      saveTicketWorkflow(db, a, run);
      expect(() => saveTicketWorkflow(db, a, run)).toThrow(/changed/);
      expect(ticketWorkflow(store.get(a.id)!)!.states.plan.state).toBe('done');
      expect(ticketWorkflow(store.get(b.id)!)!.states.plan.state).toBe('pending');
      expect(fork.nodes[0]!.label).toBe('Plan');
    } finally {
      db.close();
    }
  });
  test('workspace graph saves preserve shared instructions and YAML comments', async () => {
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(
      path.join(workspace, 'gantry.yaml'),
      '# Keep this comment\napiVersion: gantry.dev/v1\nproject:\n  id: test\n  name: TEST_workspace_graph\nrepositories:\n  - id: app\n    path: .\npromptTemplates:\n  - id: custom\n    label: Custom\n    body: Keep my instructions\n',
    );
    const project = await loadProject(workspace);
    // Existing configs receive the layout without silently enabling automation.
    expect(workspaceWorkflow(project)).toEqual({ ...DEFAULT_WORKFLOW, autoStart: false });
    saveWorkspaceWorkflow(project, fork);
    const reloaded = await loadProject(workspace);
    expect(reloaded.config.workflow).toEqual(fork);
    expect(workspaceWorkflow(reloaded)).toEqual(fork);
    expect(reloaded.config.promptTemplates[0]!.body).toBe('Keep my instructions');
    expect(fs.readFileSync(project.configPath, 'utf8')).toContain('# Keep this comment');
  });

  test('named templates persist without replacing the default or other templates', async () => {
    const project = await loadProject(path.join(dir, 'workspace'));
    const first = saveWorkspaceWorkflowTemplate(project, { name: 'Frontend work', graph: fork });
    const second = saveWorkspaceWorkflowTemplate(project, { name: 'Full delivery', graph: DEFAULT_WORKFLOW });
    const reloaded = await loadProject(project.workspace);

    expect(workspaceWorkflowTemplates(reloaded).map(template => template.name)).toEqual(['Default', 'Frontend work', 'Full delivery']);
    expect(workspaceWorkflow(reloaded, first.id)).toEqual(fork);
    expect(workspaceWorkflow(reloaded)).toEqual(fork);
    expect(() => workspaceWorkflow(reloaded, 'unknown')).toThrow(/not found/);
    expect(() => workspaceWorkflow(reloaded, 7)).toThrow(/not found/);
    expect(() => saveWorkspaceWorkflowTemplate(reloaded, { name: ' frontend WORK ', graph: fork })).toThrow(/Duplicate/);
    expect(() => saveWorkspaceWorkflowTemplate(reloaded, { name: 'Default', graph: fork })).toThrow(/Duplicate/);
    expect(() => saveWorkspaceWorkflowTemplate(reloaded, { name: ' ', graph: fork })).toThrow();
    expect(() => saveWorkspaceWorkflowTemplate(reloaded, { name: 'Broken', graph: { nodes: [] } })).toThrow();
    expect(() => saveWorkspaceWorkflowTemplate(reloaded, { name: 'Missing', graph: fork }, 'unknown')).toThrow(/not found/);

    saveWorkspaceWorkflowTemplate(reloaded, { name: 'Frontend work', graph: DEFAULT_WORKFLOW }, first.id);
    const updated = await loadProject(project.workspace);
    expect(workspaceWorkflow(updated, first.id)).toEqual(DEFAULT_WORKFLOW);
    expect(workspaceWorkflow(updated, second.id)).toEqual(DEFAULT_WORKFLOW);
    expect(workspaceWorkflow(updated)).toEqual(fork);
    expect(updated.config.promptTemplates[0]!.body).toBe('Keep my instructions');
    expect(fs.readFileSync(project.configPath, 'utf8')).toContain('# Keep this comment');
  });
});

test('HTTP graph contract copies templates, rejects stale updates and preserves ticket overrides', async () => {
  const { GantryApp } = await import('../packages/server/src/app.js');
  const { createAppContext } = await import('../packages/server/src/config/app.js');
  const { createHttpServer } = await import('../packages/server/src/http/server.js');
  const { registerProjectRow } = await import('../packages/server/src/projects/registry.js');
  const original = process.env.GANTRY_DATA_DIR;
  process.env.GANTRY_DATA_DIR = path.join(dir, 'api-data');
  const ctx = createAppContext();
  if (original === undefined) delete process.env.GANTRY_DATA_DIR;
  else process.env.GANTRY_DATA_DIR = original;
  const app = new GantryApp(ctx);
  const server = await createHttpServer(app);
  try {
    const project = await loadProject(path.join(dir, 'workspace'));
    registerProjectRow(app.db, project);
    const headers = { host: '127.0.0.1:4500' };
    const create = await server.inject({ method: 'POST', url: '/api/projects/test/tickets', headers, payload: { title: 'TEST_workspace_graph_http' } });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    const get = () => server.inject({ method: 'GET', url: `/api/tickets/${id}/workflow`, headers });
    expect((await get()).json().graph).toEqual(fork);
    const templates = await server.inject({ method: 'GET', url: '/api/projects/test/workflow-templates', headers });
    expect(templates.statusCode).toBe(200);
    expect(templates.json()[0].id).toBe('default');
    const added = await server.inject({ method: 'POST', url: '/api/projects/test/workflow-templates', headers, payload: { name: 'API template', graph: fork } });
    expect(added.statusCode).toBe(201);
    const templateId = added.json().id;
    const selected = await server.inject({ method: 'POST', url: '/api/projects/test/tickets', headers, payload: { title: 'Selected template', workflowTemplateId: templateId } });
    expect(selected.statusCode).toBe(201);
    const selectedGraph = () => server.inject({ method: 'GET', url: `/api/tickets/${selected.json().id}/workflow`, headers });
    expect((await selectedGraph()).json().graph).toEqual(fork);
    const updated = await server.inject({ method: 'POST', url: `/api/projects/test/workflow-templates/${templateId}`, headers, payload: { name: 'API template', graph: DEFAULT_WORKFLOW } });
    expect(updated.statusCode).toBe(200);
    expect((await selectedGraph()).json().graph).toEqual(fork);
    const invalidSelection = await server.inject({ method: 'POST', url: '/api/projects/test/tickets', headers, payload: { title: 'Invalid template', workflowTemplateId: 'missing' } });
    expect(invalidSelection.statusCode).toBe(400);
    const draft = workflowSchema.parse({
      ...DEFAULT_WORKFLOW,
      autoStart: false,
      nodes: DEFAULT_WORKFLOW.nodes.map((node, index) => index ? node : {
        ...node,
        instructions: 'Ticket-local instructions',
        providerId: 'example-provider',
        model: 'example-model',
        reasoningEffort: 'high',
        position: { x: 120, y: 240 },
      }),
    });
    const custom = await server.inject({ method: 'POST', url: '/api/projects/test/tickets', headers, payload: { title: 'Ticket-local draft', workflowTemplateId: templateId, graph: draft } });
    expect(custom.statusCode).toBe(201);
    const customRun = await server.inject({ method: 'GET', url: `/api/tickets/${custom.json().id}/workflow`, headers });
    expect(customRun.json().graph).toEqual(draft);
    expect(customRun.json().revision).toBe(0);
    expect(Object.values(customRun.json().states)).toEqual(draft.nodes.map(() => ({ state: 'pending', message: '' })));
    expect(workspaceWorkflow(await loadProject(project.workspace), templateId)).toEqual(DEFAULT_WORKFLOW);
    const countBefore = app.tickets.all('test').length;
    for (const graph of [null, { nodes: [] }, { ...draft, entryNodeId: 'missing' }]) {
      const invalidDraft = await server.inject({ method: 'POST', url: '/api/projects/test/tickets', headers, payload: { title: 'Invalid draft', graph } });
      expect(invalidDraft.statusCode).toBe(400);
    }
    expect(app.tickets.all('test')).toHaveLength(countBefore);
    const saved = await server.inject({ method: 'POST', url: '/api/projects/test/workflow', headers, payload: DEFAULT_WORKFLOW });
    expect(saved.statusCode).toBe(200);
    expect((await get()).json().graph).toEqual(fork);
    const body = { revision: 0, nodeId: 'plan', state: 'running' };
    expect((await server.inject({ method: 'POST', url: `/api/tickets/${id}/workflow-progress`, headers, payload: body })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: `/api/tickets/${id}/workflow-progress`, headers, payload: body })).statusCode).toBe(409);
    const invalid = await server.inject({ method: 'POST', url: `/api/tickets/${id}/workflow`, headers, payload: { revision: 1, graph: { nodes: [] } } });
    expect(invalid.statusCode).toBe(400);
    expect((await get()).json().revision).toBe(1);
  } finally {
    await server.close();
    await app.shutdown();
  }
});

describe('portable workspace graphs', () => {
  test('round trips settings while requiring automatic runs to be enabled again', () => {
    const graph = workflowSchema.parse({
      autoStart: true,
      entryNodeId: 'plan',
      nodes: [
        { ...fork.nodes[0], model: 'example-model', providerId: 'example-provider', position: { x: 100, y: 200 } },
        { ...fork.nodes[1], reasoningEffort: 'high', workspaceExclusive: true },
      ],
      edges: [
        { id: 'forward', source: 'plan', target: 'frontend', label: 'Ready to build' },
        { id: 'retry', source: 'frontend', target: 'plan', label: 'Revise the plan' },
      ],
    });

    expect(importWorkflow(exportWorkflow(graph))).toEqual({ ...graph, autoStart: false });
    expect(graph.autoStart).toBe(true);
    expect(importWorkflow(exportWorkflow(fork))).toEqual({ ...fork, autoStart: false });
  });

  test('rejects malformed, unsupported and invalid graphs', () => {
    expect(() => importWorkflow('not json')).toThrow();
    expect(() => importWorkflow(JSON.stringify({ format: 'gantry-workspace-graph', version: 2, graph: fork }))).toThrow();
    expect(() => importWorkflow(JSON.stringify({ format: 'gantry-workspace-graph', version: 1, graph: { nodes: [fork.nodes[1]] } }))).toThrow();
    expect(() => importWorkflow(JSON.stringify({ nodes: [] }))).toThrow();
  });
});
