import type { Workflow } from '../../../../packages/shared/src/workflow';
import type { ReviewFeedback } from './workflow-review';

export type Outcome = 'done' | 'changes_requested' | 'waiting' | 'failed';
export interface Attempt {
  id: string;
  nodeId: string;
  startedAt: number;
  endedAt?: number;
  state: 'running' | Outcome | 'interrupted';
  summary: string;
  output: string;
  sessionId?: string;
  sessionDirectory?: string;
  chatOpened?: boolean;
  chatVersion?: string;
  /** Latest stage-chat message (ms) already copied into the run's replies. */
  chatAbsorbedAt?: number;
  /** When the stage chat was last opened from Gantry. */
  chatOpenedAt?: number;
  /** Tool calls the provider refused during this attempt, with the allow rule that would cover each. */
  denials?: { rule: string; tool: string; detail: string }[];
  providerId: string;
  providerKind: 'codex' | 'claude' | 'opencode' | 'openai';
  model: string;
  commits: Record<string, string>;
}
/** A choice the user can make with one click instead of free text. */
export interface DecisionOption {
  id: string;
  label: string;
  /** Configured connection to follow when chosen (coordinator choices). Stage choices rerun the stage with the answer. */
  edgeId?: string;
  /** Extra stage visits explicitly authorized by a limit decision. */
  additionalAttempts?: number;
}
export interface Decision {
  nodeId: string;
  question: string;
  options: DecisionOption[];
  source: 'coordinator' | 'stage' | 'attempt-limit';
  at: number;
}
/** A pull request a stage reported back to Gantry (shown as `<repo>:<url> <title>`). */
export interface Deliverable {
  repo: string;
  url: string;
  title: string;
  nodeId: string;
  at: number;
}
export interface Execution {
  ticketId: string;
  projectId: string;
  graph: Workflow;
  state: 'running' | 'paused' | 'waiting' | 'complete';
  message: string;
  steps: Record<string, 'pending' | 'running' | 'done' | 'waiting' | 'failed'>;
  attempts: Attempt[];
  defaultProviderId: string;
  updatedAt: number;
  activeNodeId?: string;
  routing?: { nodeId: string; outcome: Outcome; summary: string };
  coordinatorSessionId?: string;
  coordinatorSessionDirectory?: string;
  routes?: { edgeId: string | null; reason: string; at: number }[];
  replies?: { nodeId: string; message: string; at: number; source?: 'app' | 'chat' | 'choice' }[];
  /** The open question, if the run is waiting on a choice. */
  decision?: Decision;
  /** Fingerprint of the coordinator input that last produced a wait; identical input is not re-sent. */
  waitKey?: string;
  /** Pull requests reported by stages, newest last. */
  deliverables?: Deliverable[];
  /** A stage stopped because tools were refused; `alreadyAllowed` were allowed in Gantry yet still refused. */
  blocked?: { nodeId: string; provider?: 'claude' | 'opencode'; rules: string[]; alreadyAllowed: string[]; at: number };
  /** What happened outside stage attempts and routes (pauses, retries, choices, blocks), newest last. */
  events?: RunEvent[];
  /** Recent review-loop snapshots, persisted with the execution rather than a transient retry note. */
  reviewFeedback?: ReviewFeedback[];
}
export interface RunEvent {
  at: number;
  kind: string;
  text: string;
  nodeId?: string;
}
/** Keep a bounded log the timeline can show. */
export function logEvent(run: Execution, kind: string, text: string, nodeId?: string) {
  run.events ??= [];
  run.events.push({ at: Date.now(), kind, text: text.slice(0, 600), ...(nodeId ? { nodeId } : {}) });
  if (run.events.length > 200) run.events.splice(0, run.events.length - 200);
}
export function nextNode(run: Execution) {
  if (run.graph.edges !== undefined) return run.graph.nodes.find((n) => n.id === (run.activeNodeId || run.graph.entryNodeId) && run.steps[n.id] === 'pending');
  return run.graph.nodes.find((n) => run.steps[n.id] === 'pending' && n.dependsOn.every((id) => run.steps[id] === 'done'));
}
const MAX_CHOICES = 6;
const cleanLabel = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : '');
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
export type ReportedPull = { repo: string; url: string; title: string };
export interface StageExtras {
  choices?: string[];
  question?: string;
  pullRequests?: ReportedPull[];
  /** The ticket's final notes (its result, often a link), written to the ticket when present. */
  finalNotes?: string;
}
export function parseOutcome(output: string): { outcome: Outcome; summary: string } & StageExtras {
  const lines = output.trim().split('\n');
  const marker = lines.at(-1)?.startsWith('GANTRY_RESULT ') ? lines.at(-1) : undefined;
  if (!marker) throw new Error('Agent did not return a structured handover. Review its output, then retry.');
  const result = JSON.parse(marker.slice('GANTRY_RESULT '.length));
  if (!['done', 'changes_requested', 'waiting', 'failed'].includes(result.outcome) || typeof result.summary !== 'string' || !result.summary.trim())
    throw new Error('Agent returned an invalid handover.');
  const choices = Array.isArray(result.choices) ? [...new Set(result.choices.map(cleanLabel).filter(Boolean))].slice(0, MAX_CHOICES) as string[] : [];
  const pullRequests: ReportedPull[] = [];
  for (const pr of Array.isArray(result.pullRequests) ? result.pullRequests.slice(0, 20) : []) {
    const url = typeof pr?.url === 'string' ? pr.url.trim().replace(/\/$/, '') : '';
    const match = PR_URL.exec(url);
    if (!match || pullRequests.some((p) => p.url === url)) continue;
    pullRequests.push({ repo: cleanLabel(pr.repo) || match[2], url, title: cleanLabel(pr.title) || `#${match[3]}` });
  }
  return {
    outcome: result.outcome,
    summary: result.summary.slice(0, 12000),
    ...(choices.length ? { choices } : {}),
    ...(choices.length && typeof result.question === 'string' && result.question.trim() ? { question: result.question.trim().slice(0, 600) } : {}),
    ...(pullRequests.length ? { pullRequests } : {}),
    ...(typeof result.finalNotes === 'string' && result.finalNotes.trim() ? { finalNotes: result.finalNotes.trim().slice(0, 5000) } : {}),
  };
}
/** Reset the correction target and every dependent, retaining all attempt history. */
export function resetFrom(run: Execution, target: string) {
  if (!run.graph.nodes.some((n) => n.id === target)) throw new Error('Unknown correction target.');
  const reset = new Set([target]);
  for (let pass = 0; pass < run.graph.nodes.length; pass++)
    for (const n of run.graph.nodes)
      if (run.graph.edges !== undefined ? run.graph.edges.some((e) => e.target === n.id && reset.has(e.source)) : n.dependsOn.some((id) => reset.has(id)))
        reset.add(n.id);
  for (const id of reset) run.steps[id] = 'pending';
  return reset;
}
/** Record PRs a stage reported; a later report for the same URL updates its title. */
export function recordDeliverables(run: Execution, nodeId: string, pulls: ReportedPull[] = []) {
  if (!pulls.length) return;
  run.deliverables ??= [];
  for (const pr of pulls) {
    const existing = run.deliverables.find((d) => d.url === pr.url);
    if (existing) Object.assign(existing, { repo: pr.repo, title: pr.title, nodeId, at: Date.now() });
    else run.deliverables.push({ ...pr, nodeId, at: Date.now() });
  }
}
export const formatDeliverable = (d: { repo: string; url: string; title: string }) => `${d.repo}:${d.url} ${d.title}`;
/** Without an explicit question, ask the handover's last question, or fall back to its opening. */
function questionFrom(summary: string) {
  const asked = summary.match(/[^.!?\n]*\?/g)?.at(-1)?.trim();
  return asked || (summary.length > 400 ? `${summary.slice(0, 400).trimEnd()}…` : summary);
}
export function finishAttempt(run: Execution, attempt: Attempt, outcome: Outcome, summary: string, extras: StageExtras = {}) {
  const { choices, pullRequests } = extras;
  attempt.state = outcome;
  attempt.summary = summary;
  attempt.endedAt = Date.now();
  const node = run.graph.nodes.find((n) => n.id === attempt.nodeId)!;
  run.message = summary;
  recordDeliverables(run, node.id, pullRequests);
  run.decision =
    outcome === 'waiting' && choices?.length
      ? { nodeId: node.id, question: extras.question || questionFrom(summary), options: choices.map((label, i) => ({ id: `opt-${i + 1}`, label })), source: 'stage', at: Date.now() }
      : undefined;
  if (run.graph.edges !== undefined) {
    run.steps[node.id] = outcome === 'done' ? 'done' : outcome === 'waiting' ? 'waiting' : 'failed';
    if (outcome === 'done' || outcome === 'changes_requested') run.routing = { nodeId: node.id, outcome, summary };
    else run.state = 'waiting';
    return;
  }
  if (outcome === 'done') {
    run.steps[node.id] = 'done';
    if (run.graph.nodes.every((n) => run.steps[n.id] === 'done')) {
      run.state = 'complete';
      if (run.deliverables?.length) run.message = `${run.deliverables.map(formatDeliverable).join('\n')}\n\n${summary}`;
    }
  } else if (outcome === 'changes_requested' && node.retryTarget) {
    const target = run.graph.nodes.find((n) => n.id === node.retryTarget)!;
    const count = run.attempts.filter((a) => a.nodeId === target.id).length;
    if (count < (target.maxAttempts ?? 3)) resetFrom(run, target.id);
    else {
      run.steps[node.id] = 'failed';
      run.state = 'waiting';
      run.message = `Retry limit reached for ${target.label}. ${summary}`;
      offerAttemptLimit(run, target.id);
    }
  } else {
    run.steps[node.id] = outcome === 'waiting' ? 'waiting' : 'failed';
    run.state = 'waiting';
  }
}

/** Whether a configured connection may be followed from the handover awaiting routing. */
function edgeAvailable(run: Execution, edgeId: unknown) {
  const current = run.routing;
  const edge = typeof edgeId === 'string' ? run.graph.edges?.find((e) => e.id === edgeId) : undefined;
  if (!current || !edge) return null;
  if (!(run.steps[edge.source] === 'done' || edge.source === current.nodeId)) return null;
  if (current.outcome === 'changes_requested' && edge.source !== current.nodeId) return null;
  return edge;
}

/**
 * Follow one configured connection. Used by the coordinator and by a user's one-click choice.
 * A user choice from the waiting node accepts that node's handover as settled.
 */
export function followEdge(run: Execution, edgeId: string, reason: string, chosenByUser = false) {
  const current = run.routing;
  if (!current) throw new Error('No handover is awaiting routing.');
  const edge = run.graph.edges?.find((e) => e.id === edgeId);
  if (!edge || !(run.steps[edge.source] === 'done' || edge.source === current.nodeId)) throw new Error('Coordinator selected an unavailable connection.');
  if (current.outcome === 'changes_requested' && edge.source !== current.nodeId)
    throw new Error('Corrections must follow a connection from the node requesting changes.');
  const target = run.graph.nodes.find((n) => n.id === edge.target)!;
  const visits = run.attempts.filter((a) => a.nodeId === target.id).length;
  if (visits >= (target.maxAttempts ?? 3)) {
    if (!chosenByUser) {
      run.state = 'waiting';
      run.message = `Visit limit reached for ${target.label}. ${reason}`;
      offerAttemptLimit(run, target.id, edge.id);
      return;
    }
    // An explicit choice authorizes one more visit.
    target.maxAttempts = visits + 1;
  }
  if (chosenByUser && edge.source === current.nodeId) run.steps[edge.source] = 'done';
  if (run.attempts.some((a) => a.nodeId === target.id)) resetFrom(run, target.id);
  run.steps[target.id] = 'pending';
  run.activeNodeId = target.id;
  run.routing = undefined;
  run.decision = undefined;
  run.waitKey = undefined;
  run.state = 'running';
  run.message = reason;
  run.routes ??= [];
  run.routes.push({ edgeId, reason, at: Date.now() });
}

/** Keep the blocked route intact until the person explicitly authorizes more work. */
function offerAttemptLimit(run: Execution, nodeId: string, edgeId?: string) {
  const target = run.graph.nodes.find((n) => n.id === nodeId)!;
  const visits = run.attempts.filter((a) => a.nodeId === nodeId).length;
  run.decision = {
    nodeId, source: 'attempt-limit', at: Date.now(),
    question: `${target.label} has used ${visits} attempt${visits === 1 ? '' : 's'} (limit: ${target.maxAttempts ?? 3}). Allow more attempts and continue? This changes only this ticket's workflow.`,
    options: [1, 3, 5].map((count) => ({ id: `limit-${count}`, label: count === 1 ? 'Allow 1 more attempt' : `Allow ${count} more attempts`, edgeId, additionalAttempts: count })),
  };
}

/** Existing saved runs get the same controls without asking the coordinator to run again. */
export function restoreAttemptLimitDecision(run: Execution) {
  if (run.state !== 'waiting' || run.decision || typeof run.message !== 'string') return;
  const targets = run.graph.nodes.filter((n) =>
    (run.message.startsWith(`Visit limit reached for ${n.label}. `) || run.message.startsWith(`Retry limit reached for ${n.label}. `)) &&
    run.attempts.filter((a) => a.nodeId === n.id).length >= (n.maxAttempts ?? 3));
  if (targets.length !== 1) return;
  const target = targets[0];
  if (run.graph.edges !== undefined) {
    const edges = run.graph.edges.filter((e) => e.source === run.routing?.nodeId && e.target === target.id);
    if (edges.length === 1) offerAttemptLimit(run, target.id, edges[0].id);
  } else if (run.graph.nodes.some((n) => n.retryTarget === target.id && run.steps[n.id] === 'failed')) {
    offerAttemptLimit(run, target.id);
  }
}

/** Called only for a persisted, explicit limit choice, never for coordinator output. */
export function allowMoreAttempts(run: Execution, optionId: string, message: string) {
  const decision = run.decision;
  const option = decision?.options.find((o) => o.id === optionId);
  if (decision?.source !== 'attempt-limit' || !option || ![1, 3, 5].includes(option.additionalAttempts ?? 0)) throw new Error('That limit choice is no longer available. Reload the graph.');
  const target = run.graph.nodes.find((n) => n.id === decision.nodeId);
  if (!target || run.state === 'running') throw new Error('This stage is not waiting for more attempts.');
  const visits = run.attempts.filter((a) => a.nodeId === target.id).length;
  target.maxAttempts = Math.max(target.maxAttempts ?? 3, visits) + option.additionalAttempts!;
  if (option.edgeId) followEdge(run, option.edgeId, message, true);
  else {
    resetFrom(run, target.id);
    run.decision = undefined;
    run.waitKey = undefined;
    run.state = 'running';
    run.message = message;
  }
}

/** Only configured paths from completed work can be taken; arbitrary node IDs never execute. */
export function applyRoute(run: Execution, output: string) {
  const line = output.trim().split('\n').at(-1);
  if (!line?.startsWith('GANTRY_ROUTE ')) throw new Error('Coordinator did not return a routing decision. Resume to retry routing.');
  const decision = JSON.parse(line.slice('GANTRY_ROUTE '.length));
  if (typeof decision.reason !== 'string' || !decision.reason.trim() || decision.reason.length > 12000)
    throw new Error('Coordinator returned an invalid routing reason.');
  if (decision.wait === true) {
    run.state = 'waiting';
    run.message = decision.reason;
    // Offer the user's options as buttons; only connections that could legally be followed are kept.
    const options: DecisionOption[] = [];
    for (const choice of Array.isArray(decision.choices) ? decision.choices : []) {
      const edge = edgeAvailable(run, choice?.edgeId);
      const label = cleanLabel(choice?.label);
      if (edge && label && !options.some((o) => o.edgeId === edge.id)) options.push({ id: `opt-${options.length + 1}`, label, edgeId: edge.id });
      if (options.length >= MAX_CHOICES) break;
    }
    const question = cleanLabel(decision.question) || decision.reason;
    run.decision = options.length && run.routing ? { nodeId: run.routing.nodeId, question, options, source: 'coordinator', at: Date.now() } : undefined;
    return;
  }
  const current = run.routing;
  if (!current) throw new Error('No handover is awaiting routing.');
  if (decision.edgeId === null) {
    if (current.outcome !== 'done' || run.graph.edges?.some((e) => e.source === current.nodeId))
      throw new Error('Coordinator cannot finish before a terminal node completes.');
    run.state = 'complete';
    // The final output leads with what was delivered, one `<repo>:<url> <title>` line per PR.
    run.message = run.deliverables?.length ? `${run.deliverables.map(formatDeliverable).join('\n')}\n\n${decision.reason}` : decision.reason;
    run.routing = undefined;
    run.decision = undefined;
    run.waitKey = undefined;
    run.routes ??= [];
    run.routes.push({ edgeId: null, reason: decision.reason, at: Date.now() });
    return;
  }
  followEdge(run, decision.edgeId, decision.reason);
}
