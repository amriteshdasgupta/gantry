import { expect, test } from 'vitest';
import { workflowSchema } from '../packages/shared/src/workflow';
import { canvasWorkflow } from '../desktop/src/lib/client/workflow-graph';
import { allowMoreAttempts, restoreAttemptLimitDecision, applyRoute, finishAttempt, nextNode, type Attempt, type Execution } from '../desktop/src/lib/server/workflow-state';
const graph = () => ({
  entryNodeId: 'plan',
  edges: [
    { id: 'plan-build', source: 'plan', target: 'build', label: 'When the plan is ready' },
    { id: 'build-review', source: 'build', target: 'review', label: 'When implementation is ready' },
    { id: 'review-build', source: 'review', target: 'build', label: 'If review identifies missing requirements' },
  ],
  nodes: ['plan', 'build', 'review'].map((id) => ({ id, label: id, instructions: '', kind: 'agent' as const, dependsOn: [] })),
});
function run(): Execution {
  return {
    ticketId: 'test',
    projectId: 'project',
    graph: graph(),
    steps: { plan: 'pending', build: 'pending', review: 'pending' },
    attempts: [],
    state: 'running',
    message: '',
    defaultProviderId: 'codex',
    updatedAt: 0,
    activeNodeId: 'plan',
  };
}
function finish(r: Execution, id: string, outcome: 'done' | 'changes_requested' = 'done') {
  const a: Attempt = {
    id: String(r.attempts.length),
    nodeId: id,
    startedAt: 0,
    state: 'running',
    summary: '',
    output: '',
    providerId: 'codex',
    providerKind: 'codex',
    model: 'fixture',
    commits: {},
  };
  r.attempts.push(a);
  finishAttempt(r, a, outcome, 'Evidence');
}
const choose = (edgeId: string | null) => 'GANTRY_ROUTE ' + JSON.stringify({ edgeId, reason: 'Condition supported by the stage evidence' });
test('named edges route forward and backwards, invalidating stale downstream results', () => {
  const r = run();
  finish(r, 'plan');
  expect(r.routing?.nodeId).toBe('plan');
  applyRoute(r, choose('plan-build'));
  expect(nextNode(r)?.id).toBe('build');
  finish(r, 'build');
  applyRoute(r, choose('build-review'));
  finish(r, 'review', 'changes_requested');
  applyRoute(r, choose('review-build'));
  expect(r.steps).toEqual({ plan: 'done', build: 'pending', review: 'pending' });
  expect(r.attempts).toHaveLength(3);
  expect(r.routes).toHaveLength(3);
});
test('unconfigured paths and edges from unvisited nodes never execute', () => {
  const r = run();
  finish(r, 'plan');
  expect(() => applyRoute(r, choose('not-an-edge'))).toThrow('unavailable');
  expect(() => applyRoute(r, choose('build-review'))).toThrow('unavailable');
  expect(() => applyRoute(r, choose(null))).toThrow('terminal');
});
test('terminal completion and explicit waiting retain a reason', () => {
  const r = run();
  r.graph.edges = [];
  finish(r, 'plan');
  applyRoute(r, choose(null));
  expect(r.state).toBe('complete');
  const waiting = run();
  finish(waiting, 'plan');
  applyRoute(waiting, 'GANTRY_ROUTE {"wait":true,"reason":"No condition fits"}');
  expect(waiting.state).toBe('waiting');
  expect(waiting.routing).toBeDefined();
});
test('cycles have bounded visits rather than infinite model calls', () => {
  const r = run();
  r.graph.nodes[1] = { ...r.graph.nodes[1], maxAttempts: 1 } as (typeof r.graph.nodes)[number];
  finish(r, 'build');
  finish(r, 'review', 'changes_requested');
  applyRoute(r, choose('review-build'));
  expect(r.state).toBe('waiting');
  expect(r.message).toContain('Visit limit');
  expect(r.decision?.source).toBe('attempt-limit');
});
test.each([1, 3, 5])('explicit approval adds %i visits and follows the blocked correction route', (extra) => {
  const r = run();
  r.graph.nodes[1].maxAttempts = 1;
  finish(r, 'build');
  finish(r, 'review', 'changes_requested');
  applyRoute(r, choose('review-build'));
  const saved: Execution = JSON.parse(JSON.stringify(r));
  allowMoreAttempts(saved, `limit-${extra}`, 'Fix the two review findings');
  expect(saved.graph.nodes[1].maxAttempts).toBe(1 + extra);
  expect(saved.state).toBe('running');
  expect(nextNode(saved)?.id).toBe('build');
  expect(saved.steps.review).toBe('pending');
  expect(saved.routing).toBeUndefined();
  expect(saved.decision).toBeUndefined();
  expect(saved.attempts.at(-1)?.summary).toBe('Evidence');
  expect(saved.routes?.at(-1)).toMatchObject({ edgeId: 'review-build', reason: 'Fix the two review findings' });
  expect(() => allowMoreAttempts(saved, `limit-${extra}`, 'Again')).toThrow('no longer available');
  for (let i = 0; i < extra; i++) {
    finish(saved, 'build');
    finish(saved, 'review', 'changes_requested');
    applyRoute(saved, choose('review-build'));
  }
  expect(saved.state).toBe('waiting');
  expect(saved.decision?.source).toBe('attempt-limit');
});
test('old visit-limit runs gain actionable controls without rerunning the coordinator', () => {
  const r = run();
  r.graph.nodes[1].maxAttempts = 1;
  finish(r, 'build');
  finish(r, 'review', 'changes_requested');
  applyRoute(r, choose('review-build'));
  delete r.decision;
  restoreAttemptLimitDecision(r);
  expect(r.decision?.options.map((o) => o.additionalAttempts)).toEqual([1, 3, 5]);
  expect(r.state).toBe('waiting');
  expect(() => allowMoreAttempts(r, 'limit-999', 'Invalid')).toThrow();
  expect(r.graph.nodes[1].maxAttempts).toBe(1);
});
test('legacy retry-limit runs also allow extra attempts explicitly', () => {
  const r = run();
  delete r.graph.edges;
  r.graph.nodes[1].maxAttempts = 1;
  r.graph.nodes[2].dependsOn = ['build'];
  r.graph.nodes[2].retryTarget = 'build';
  finish(r, 'build');
  finish(r, 'review', 'changes_requested');
  expect(r.decision?.source).toBe('attempt-limit');
  delete r.decision;
  restoreAttemptLimitDecision(r);
  allowMoreAttempts(r, 'limit-3', 'Continue');
  expect(r.graph.nodes[1].maxAttempts).toBe(4);
  expect(r.steps.build).toBe('pending');
  expect(r.steps.review).toBe('pending');
  expect(r.state).toBe('running');
});
test('canvas migration preserves instructions and expresses previous joins and corrections as edges', () => {
  const legacy = {
    nodes: [
      { id: 'plan', label: 'Plan', instructions: 'Keep this', kind: 'agent' as const, dependsOn: [] },
      { id: 'test', label: 'Test', instructions: 'Check', kind: 'agent' as const, dependsOn: ['plan'], retryTarget: 'plan' },
      { id: 'join', label: 'Join', instructions: 'Deliver', kind: 'agent' as const, dependsOn: ['plan', 'test'] },
    ],
  };
  const canvas = canvasWorkflow(legacy);
  expect(canvas.nodes[0].instructions).toBe('Keep this');
  expect(canvas.edges).toContainEqual({ id: 'edge-1', source: 'test', target: 'plan', label: 'When changes are requested' });
  expect(canvas.edges?.some((e) => e.label.includes('Test also completed'))).toBe(true);
  expect(legacy).not.toHaveProperty('edges');
  expect(workflowSchema.safeParse(canvas).success).toBe(true);
});
test('stores empty boards and positions; rejects invalid edges and starting nodes', () => {
  expect(workflowSchema.safeParse({ nodes: [], edges: [] }).success).toBe(true);
  expect(workflowSchema.safeParse({ nodes: [], edges: [], autoStart: true }).success).toBe(false);
  const g = graph();
  expect(workflowSchema.safeParse({ ...g, entryNodeId: 'missing' }).success).toBe(false);
  expect(workflowSchema.safeParse({ ...g, edges: [{ id: 'wrong', source: 'plan', target: 'missing', label: 'x' }] }).success).toBe(false);
  expect(workflowSchema.safeParse({ ...g, nodes: g.nodes.map((n) => ({ ...n, position: { x: 32, y: 64 } })) }).success).toBe(true);
});
