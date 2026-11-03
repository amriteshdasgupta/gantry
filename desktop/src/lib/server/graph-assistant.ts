import 'server-only';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drivers, findAgent, getAgent } from './agents';
import { httpError } from './http';
import { graphAssistantRequestSchema, graphAssistantResponseSchema, parseGraphAssistantResponse } from '../graph-assistant';

const SYSTEM = `You design and edit Gantry workflow graphs. Return ONLY a JSON object with message (a concise explanation) and graph (the complete replacement graph). Do not use tools or access files. The supplied graph is the authoritative current draft; earlier conversation is context only. Preserve IDs, positions, settings and instructions of unchanged nodes. Make only the requested changes. Never invent provider IDs or model IDs. Use provider defaults for new nodes unless asked otherwise.
Graph format: {autoStart?: boolean, entryNodeId?: string, nodes: [{id, label, kind: "agent", instructions, dependsOn: [], position?: {x,y}, providerId?: string, model?: string, reasoningEffort?: "low"|"medium"|"high"|"xhigh"|"max"|"ultra", maxAttempts?: 1..10, workspaceExclusive?: boolean, freshSession?: boolean}], edges: [{id, source, target, label}]}.
Limits: 50 nodes, 250 edges; node IDs /^[a-z][a-z0-9-]{0,63}$/, edge IDs /^[a-z][a-z0-9-]{0,100}$/; unique IDs, node labels 1..100 characters, instructions at most 10000 characters, nonempty edge labels at most 2000 characters. Connections must reference existing, distinct nodes. Select a valid entryNodeId for nonempty graphs. Coordinates must be between 0 and 10000; space new nodes about 300 horizontally and 190 vertically. Routes may loop for corrections. If autoStart is true, all nodes must be reachable from entryNodeId. Preserve autoStart; do not enable it unless explicitly asked. Empty graphs require edges: [], no entryNodeId, and autoStart false.
Write complete, actionable stage prompts with goals, relevant verification, expected handoff and completion criteria. Give edges clear routing conditions, including correction loops when requested. Do not execute stages, save files or start workflows. Automatic-run changes must be made using the editor switch; always preserve the current autoStart setting. If clarification is needed, explain the question in message and return the current graph unchanged.`;

const state = globalThis as typeof globalThis & { graphAssistantActive?: number };

export async function assistGraph(body: unknown, requestSignal: AbortSignal) {
  const parsed = graphAssistantRequestSchema.safeParse(body);
  if (!parsed.success) throw httpError(400, `Invalid graph request: ${parsed.error.issues.map((issue) => issue.message).join(' ')}`);
  if ((state.graphAssistantActive ?? 0) >= 3) throw httpError(429, 'Graph assistants are busy. Try again shortly.');

  const input = parsed.data;
  const agent = input.providerId ? findAgent(input.providerId) : getAgent();
  if (!agent) throw httpError(400, 'That provider no longer exists. Choose another provider.');

  state.graphAssistantActive = (state.graphAssistantActive ?? 0) + 1;
  const timeout = AbortSignal.timeout(120000);
  const stopped = new AbortController();
  const signal = AbortSignal.any([requestSignal, timeout, stopped.signal]);
  let cwd: string | undefined;

  try {
    signal.throwIfAborted();
    cwd = await mkdtemp(path.join(os.tmpdir(), 'gantry-graph-assistant-'));
    let text = '';
    let failure = '';

    await drivers[agent.kind]({
      agent,
      coordinator: true,
      cwd,
      system: SYSTEM,
      prompt: JSON.stringify({ request: input.prompt, currentGraph: input.graph, conversation: input.history }),
      history: [],
      sessionId: null,
      signal,
      hooks: {
        text(chunk) {
          if (text.length + chunk.length > 800000) {
            failure = 'The provider response was too large. Request a smaller graph.';
            stopped.abort();
          } else text += chunk;
        },
        tool() {
          failure = 'The graph assistant attempted to use tools.';
          stopped.abort();
        },
        session() {},
        cost() {},
        error(message) {
          failure ||= message;
        },
      },
    });

    if (timeout.aborted) throw httpError(504, 'The graph assistant timed out. Try a smaller request.');
    if (requestSignal.aborted) throw httpError(499, 'Graph request cancelled.');
    if (failure) throw httpError(502, failure);

    try {
      const response = parseGraphAssistantResponse(text);

      return graphAssistantResponseSchema.parse({
        ...response,
        graph: { ...response.graph, autoStart: input.graph.autoStart },
      });
    } catch {
      throw httpError(502, 'The provider returned an invalid graph. Your draft is unchanged. Try rephrasing the request.');
    }
  } catch (error) {
    if (timeout.aborted) throw httpError(504, 'The graph assistant timed out. Try a smaller request.');
    if (requestSignal.aborted) throw httpError(499, 'Graph request cancelled.');

    throw error;
  } finally {
    state.graphAssistantActive = Math.max(0, (state.graphAssistantActive ?? 1) - 1);
    if (cwd) await rm(cwd, { recursive: true, force: true });
  }
}
