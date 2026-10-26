import { afterAll, beforeEach, expect, test, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const previous = process.env.PR_LENS_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cleanup-bridge-'));
  process.env.PR_LENS_HOME = home;
  return { home, previous, active: vi.fn(), master: vi.fn(), pending: vi.fn(), queued: vi.fn(), checkoutAgents: vi.fn(), reserve: vi.fn() };
});

vi.mock('server-only', () => ({}));
vi.mock('../desktop/src/lib/server/workflow-executor', () => ({ executionHasWork: mocks.active }));
vi.mock('../desktop/src/lib/server/ticket-conversations', () => ({ masterBusy: mocks.master }));
vi.mock('../desktop/src/lib/server/chats', () => ({
  pendingFor: mocks.pending,
  queuedFor: mocks.queued,
  checkoutsHaveAgents: mocks.checkoutAgents,
  withIdleCheckouts: mocks.reserve,
}));

import fs from 'node:fs';
import { withLock } from '../desktop/src/lib/server/exec';
import { ticketWorktreeCleanup } from '../desktop/src/lib/server/worktree-cleanup';

const upstream = new URL('http://127.0.0.1:4500');
const assessment = {
  ticketId: 'TEST_a', ticketIds: ['TEST_a', 'TEST_b'], blockers: [],
  checkouts: [{ repositoryId: 'repo', path: '/fixture/worktree', head: 'a'.repeat(40), eligible: true, reason: 'Clean and merged' }],
};
const body = JSON.stringify({ confirm: true, checkouts: assessment.checkouts });
let posts = 0;

beforeEach(() => {
  vi.resetAllMocks();
  posts = 0;
  mocks.active.mockReturnValue(false);
  mocks.master.mockReturnValue(false);
  mocks.pending.mockReturnValue(null);
  mocks.queued.mockReturnValue([]);
  mocks.checkoutAgents.mockReturnValue(false);
  mocks.reserve.mockImplementation((_paths, action) => action());
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (options.method === 'POST') {
      posts++;
      return Response.json({ results: [{ status: 'removed' }], assessment });
    }
    return Response.json(assessment);
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (mocks.previous === undefined) delete process.env.PR_LENS_HOME;
  else process.env.PR_LENS_HOME = mocks.previous;
  fs.rmSync(mocks.home, { recursive: true, force: true });
});

test.each(['workflow', 'master', 'pending', 'queued'] as const)('shared-branch %s activity blocks assessment and removal', async activity => {
  if (activity === 'workflow') mocks.active.mockImplementation(id => id === 'TEST_b');
  if (activity === 'master') mocks.master.mockImplementation(id => id === 'TEST_b');
  if (activity === 'pending') mocks.pending.mockImplementation(id => id === 'ticket/TEST_b' ? {} : null);
  if (activity === 'queued') mocks.queued.mockImplementation(id => id === 'ticket/TEST_b' ? ['turn'] : []);

  const read = await ticketWorktreeCleanup(upstream, 'TEST_a', 'GET');
  expect((await read.json()).blockers.length).toBeGreaterThan(0);
  const write = await ticketWorktreeCleanup(upstream, 'TEST_a', 'POST', body);
  expect(write.status).toBe(409);
  expect(posts).toBe(0);
});

test('idle workflow history permits confirmed removal under both tickets locks', async () => {
  const response = await ticketWorktreeCleanup(upstream, 'TEST_a', 'POST', body);
  expect(response.status).toBe(200);
  expect(posts).toBe(1);
  expect(mocks.active).toHaveBeenCalledWith('TEST_a');
  expect(mocks.active).toHaveBeenCalledWith('TEST_b');
  expect(mocks.reserve).toHaveBeenCalledWith(['/fixture/worktree'], expect.any(Function));
  const forwarded = vi.mocked(fetch).mock.calls.find(([, options]) => options?.method === 'POST');
  expect(JSON.parse(String(forwarded?.[1]?.body))).toEqual({ confirm: true, checkouts: assessment.checkouts, ticketIds: assessment.ticketIds });
});

test('peer workflow controls are serialized with cleanup and activity is rechecked after acquiring locks', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const peer = withLock('workflow:TEST_b', async () => {
    entered = true;
    await gate;
    mocks.active.mockImplementation(id => id === 'TEST_b');
  });
  await vi.waitFor(() => expect(entered).toBe(true));
  const cleanup = ticketWorktreeCleanup(upstream, 'TEST_a', 'POST', body);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(posts).toBe(0);
  release();
  await peer;
  expect((await cleanup).status).toBe(409);
  expect(posts).toBe(0);
});

test('shared-ticket controls wait until removal finishes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.reserve.mockImplementation(async (_paths, action) => { await gate; return action(); });
  const cleanup = ticketWorktreeCleanup(upstream, 'TEST_a', 'POST', body);
  await vi.waitFor(() => expect(mocks.reserve).toHaveBeenCalledOnce());
  let controlled = false;
  const control = withLock('workflow:TEST_b', async () => { controlled = true; });
  await Promise.resolve();
  expect(controlled).toBe(false);
  release();
  expect((await cleanup).status).toBe(200);
  await control;
  expect(controlled).toBe(true);
});

test('a changed shared-branch scope fails closed before removal', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(assessment))
    .mockResolvedValueOnce(Response.json({ ...assessment, ticketIds: ['TEST_a', 'TEST_b', 'TEST_c'] }));
  const response = await ticketWorktreeCleanup(upstream, 'TEST_a', 'POST', body);
  expect(response.status).toBe(409);
  expect(posts).toBe(0);
});
