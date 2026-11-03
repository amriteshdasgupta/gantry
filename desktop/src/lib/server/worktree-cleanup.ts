import 'server-only';
import type { CleanupAssessment } from '../client/gantry';
import { executionHasWork } from './workflow-executor';
import { pendingFor, queuedFor, checkoutsHaveAgents, withIdleCheckouts } from './chats';
import { withLock } from './exec';
import { masterBusy } from './ticket-conversations';

function blockersFor(assessment: CleanupAssessment): string[] {
  const blockers = [...assessment.blockers];
  if (assessment.ticketIds.some(masterBusy)) {
    blockers.push('Wait for master chat replies to finish before cleanup.');
  }
  if (assessment.ticketIds.some(id => executionHasWork(id))) {
    blockers.push('Pause workflow work on every ticket sharing this branch and wait for its agents to stop before cleanup.');
  }
  if (assessment.ticketIds.some(id => pendingFor(`ticket/${id}`) || queuedFor(`ticket/${id}`).length)) {
    blockers.push('Wait for ticket agents sharing this branch to finish before cleanup.');
  }
  if (checkoutsHaveAgents(assessment.checkouts.map(checkout => checkout.path))) {
    blockers.push('Wait for checkout agents to finish before cleanup.');
  }
  return blockers;
}

function scopeFor(assessment: CleanupAssessment): string[] {
  if (!Array.isArray(assessment.ticketIds) || !assessment.ticketIds.includes(assessment.ticketId)
    || assessment.ticketIds.some(id => typeof id !== 'string' || !/^[\w-]+$/.test(id))) {
    throw new Error('Runtime cleanup scope is unavailable. Restart Gantry and retry.');
  }
  return [...new Set(assessment.ticketIds)].sort();
}

export function withTicketLocks<T>(ids: string[], action: () => Promise<T>): Promise<T> {
  const keys = ids.flatMap(id => [`workflow:${id}`, `ticket-conversation:${id}`]);
  const acquire = (index: number): Promise<T> => index === keys.length
    ? action()
    : withLock(keys[index], () => acquire(index + 1));
  return acquire(0);
}

/** Resolve shared-branch scope from the runtime, then recheck it under every ticket's locks. */
export async function ticketWorktreeCleanup(upstream: URL, ticketId: string, method: string, body?: string): Promise<Response> {
  const url = new URL(`/api/tickets/${ticketId}/worktree-cleanup`, upstream);
  const forward = (verb: string, payload = body) => fetch(url, {
    method: verb,
    headers: { 'Content-Type': 'application/json', Origin: upstream.origin },
    ...(verb === 'POST' ? { body: payload } : {}),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });

  const response = await forward('GET');
  if (!response.ok) return response;
  const assessment = await response.json() as CleanupAssessment;
  const ids = scopeFor(assessment);
  if (method === 'GET') {
    return Response.json({ ...assessment, blockers: blockersFor(assessment) });
  }

  return withTicketLocks(ids, async () => {
    const refreshed = await forward('GET');
    if (!refreshed.ok) return refreshed;
    const current = await refreshed.json() as CleanupAssessment;
    if (JSON.stringify(scopeFor(current)) !== JSON.stringify(ids)) {
      return Response.json({ error: 'Tickets sharing this branch changed. Review a fresh cleanup assessment.' }, { status: 409 });
    }
    const blockers = blockersFor(current);
    if (blockers.length) return Response.json({ error: blockers.join(' ') }, { status: 409 });

    const payload = JSON.stringify({ ...JSON.parse(body || '{}'), ticketIds: ids });
    return withIdleCheckouts(current.checkouts.map(checkout => checkout.path), () => forward('POST', payload));
  });
}
