import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { StatusView } from '../client/gantry';
import { forgetChat, pendingFor, queuedFor } from './chats';
import { HOME } from './exec';
import { forgetWorkspaceSpaces } from './spaces';
import { forgetAllowedTools } from './stage-permissions';
import { forgetConversations, masterBusy } from './ticket-conversations';
import { executionHasWork, forgetExecution } from './workflow-executor';
import { withTicketLocks } from './worktree-cleanup';

/** The Gantry service owns the workspace; this app's own per-ticket state must be idle first and erased with it. */
export async function removeWorkspace(upstream: URL, projectId: string, body: string): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', Origin: upstream.origin };
  const statusResponse = await fetch(new URL('/api/status', upstream), { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!statusResponse.ok) return statusResponse;
  const status = await statusResponse.json() as StatusView;
  const ticketIds = status.tickets.filter(ticket => ticket.projectId === projectId).map(ticket => ticket.id);
  return withTicketLocks(ticketIds, async () => {
    if (ticketIds.some(id => masterBusy(id) || executionHasWork(id) || pendingFor(`ticket/${id}`) || queuedFor(`ticket/${id}`).length)) {
      return Response.json({ error: 'Agents are still working in this workspace. Pause its workflows and wait for them to stop, then retry.' }, { status: 409 });
    }
    const response = await fetch(new URL(`/api/projects/${projectId}`, upstream), { method: 'DELETE', headers, body, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (response.ok && (JSON.parse(body) as { deleteData?: unknown }).deleteData === true) {
      for (const id of ticketIds) {
        forgetExecution(id);
        forgetConversations(id);
        forgetChat(`ticket/${id}`);
        fs.rmSync(path.join(HOME, 'mcp', `${id}.json`), { force: true });
      }
      for (const target of forgetWorkspaceSpaces(projectId)) forgetChat(target);
      forgetAllowedTools(projectId);
    }
    return response;
  });
}
