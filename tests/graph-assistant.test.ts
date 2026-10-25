import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { graphAssistantRequestSchema, parseGraphAssistantResponse } from '../desktop/src/lib/graph-assistant';
import type { RunInput } from '../desktop/src/lib/server/agents/driver';

const mocks = vi.hoisted(() => ({ driver: vi.fn(), find: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../desktop/src/lib/server/agents', () => ({
  drivers: { codex: mocks.driver },
  findAgent: mocks.find,
  getAgent: () => ({ id: 'default', kind: 'codex', name: 'Default', model: '' }),
}));

import { assistGraph } from '../desktop/src/lib/server/graph-assistant';

const graph = {
  entryNodeId: 'plan',
  autoStart: false,
  edges: [],
  nodes: [{ id: 'plan', label: 'Plan', instructions: 'Plan the change', kind: 'agent' as const, dependsOn: [] }],
};
const response = { message: 'Updated the instructions.', graph };
const input = { graph, prompt: 'Improve the instructions' };

beforeEach(() => {
  mocks.driver.mockReset();
  mocks.find.mockReset();
  mocks.driver.mockImplementation(async ({ hooks }: RunInput) => hooks.text(JSON.stringify(response)));
});

afterEach(() => vi.useRealTimers());

describe('graph assistant contract', () => {
  test('accepts plain or fenced JSON, validates graph references and preserves settings', () => {
    expect(parseGraphAssistantResponse(JSON.stringify(response))).toEqual(response);
    expect(parseGraphAssistantResponse('```json\n' + JSON.stringify(response) + '\n```')).toEqual(response);
    const invalid = { ...graph, edges: [{ id: 'bad', source: 'plan', target: 'missing', label: 'Success' }] };
    expect(() => parseGraphAssistantResponse(JSON.stringify({ ...response, graph: invalid }))).toThrow();
    expect(() => parseGraphAssistantResponse('Here is your graph: ' + JSON.stringify(response))).toThrow();
    expect(graphAssistantRequestSchema.safeParse({ ...input, prompt: ' ' }).success).toBe(false);
    expect(graphAssistantRequestSchema.safeParse({ ...input, history: Array(13).fill({ role: 'user', text: 'x' }) }).success).toBe(false);
  });

  test('runs a fresh bounded planning turn in an isolated directory and cleans up', async () => {
    const original = structuredClone(graph);
    expect(await assistGraph(input, new AbortController().signal)).toEqual(response);
    const run: RunInput = mocks.driver.mock.calls[0][0];
    expect(run.coordinator).toBe(true);
    expect(run.workflow).toBeUndefined();
    expect(run.sessionId).toBeNull();
    expect(JSON.parse(run.prompt).currentGraph).toEqual(graph);
    expect(fs.existsSync(run.cwd)).toBe(false);
    expect(graph).toEqual(original);
  });

  test('rejects missing providers and invalid input before running a driver', async () => {
    await expect(assistGraph({ ...input, providerId: 'deleted' }, new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    await expect(assistGraph({ ...input, graph: { ...graph, entryNodeId: 'missing' } }, new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    expect(mocks.driver).not.toHaveBeenCalled();
  });

  test('uses the explicitly chosen provider and preserves the manual automatic-run switch', async () => {
    const agent = { id: 'chosen', kind: 'codex', name: 'Chosen', model: 'configured-model' };
    mocks.find.mockReturnValue(agent);
    mocks.driver.mockImplementation(async ({ hooks }: RunInput) => hooks.text(JSON.stringify({ ...response, graph: { ...graph, autoStart: true } })));
    const result = await assistGraph({ ...input, providerId: 'chosen' }, new AbortController().signal);
    expect(result.graph.autoStart).toBe(false);
    expect(mocks.driver.mock.calls[0][0].agent).toEqual(agent);
  });

  test('provider errors, tool attempts, oversized and malformed responses do not become proposals', async () => {
    for (const emit of [
      (run: RunInput) => run.hooks.error('Provider offline'),
      (run: RunInput) => run.hooks.tool({ name: 'shell', detail: 'ignored' }),
      (run: RunInput) => run.hooks.text('x'.repeat(800001)),
      (run: RunInput) => run.hooks.text('{"message":"Missing graph"}'),
    ]) {
      mocks.driver.mockImplementation(async (run: RunInput) => emit(run));
      await expect(assistGraph(input, new AbortController().signal)).rejects.toMatchObject({ status: 502 });
      const run: RunInput = mocks.driver.mock.calls.at(-1)![0];
      expect(fs.existsSync(run.cwd)).toBe(false);
    }
  });

  test('propagates cancellation and releases concurrency capacity', async () => {
    const started: RunInput[] = [];
    mocks.driver.mockImplementation(
      (run: RunInput) =>
        new Promise<void>((resolve) => {
          started.push(run);
          run.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const abort = new AbortController();
    const pending = Array.from({ length: 3 }, () => assistGraph(input, abort.signal).catch((error) => error));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    await expect(assistGraph(input, abort.signal)).rejects.toMatchObject({ status: 429 });
    abort.abort();
    const errors = await Promise.all(pending);
    expect(errors.every((error) => error.status === 499)).toBe(true);
    expect(started.every((run) => !fs.existsSync(run.cwd))).toBe(true);
    mocks.driver.mockImplementation(async ({ hooks }: RunInput) => hooks.text(JSON.stringify(response)));
    await expect(assistGraph(input, new AbortController().signal)).resolves.toEqual(response);
  });
});
