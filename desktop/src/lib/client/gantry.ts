export { ticketServiceScopes } from "../../../../packages/shared/src/ticket";
import type { Workflow, WorkflowRun, StepState } from "../../../../packages/shared/src/workflow";
export type { Workflow, WorkflowRun, StepState };
// Typed client for the Gantry HTTP API.
// Shapes mirror packages/server/src/status.ts and packages/shared/src/ticket.ts.

export interface AgentView {
  id: string;
  capabilities: {
    id: string;
    label: string;
    available: boolean;
    version: string | null;
    resumeMode: string;
    takeover: boolean;
    interruptMode: string;
    deepLinkScheme: string | null;
    streaming: boolean;
    notes: string[];
  };
  configured: boolean;
}

export interface TicketRunView {
  id: string;
  agent: string;
  state: string;
  sessionId: string | null;
  deepLink: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  processAlive: boolean;
  logUrl: string;
}

export interface TicketView {
  execution?: {
    activeNodeId?: string;
    state: string;
    message: string;
    updatedAt: number;
    decision?: { nodeId: string; question: string; source?: 'coordinator' | 'stage' | 'attempt-limit'; options: { id: string; label: string; edgeId?: string }[] };
    deliverables?: { repo: string; url: string; title: string }[];
  };
  conversation?: { provider: "claude" | "codex" | "opencode"; providerName: string; sessionId: string } | null;
  reviewSpaceId?: string;
  workflow?: WorkflowRun | null;
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  scope: string;
  scopes: string[];
  scopeDescription?: string;
  branch: string;
  additions: string | null;
  /** Final notes: the ticket's result, which may be a link rather than code. */
  outcome?: string | null;
  /** Set by the person: the ticket's work is out for review. */
  awaitingReview?: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  run: TicketRunView | null;
  previewUrl: string | null;
  previewStatus: string | null;
  pullRequests: { role: string; number: number; url: string; title: string }[];
  artifacts: { file: string; label: string; kind: string; url: string; size: number }[];
}

export interface PreviewServiceView {
  id: string;
  state: string;
  port: number | null;
  healthUrl: string | null;
  openLink: string | null;
  error: string | null;
  logUrl: string | null;
}

export interface PreviewCheckoutView {
  repositoryId: string;
  path: string;
  head: string | null;
  branch: string | null;
  isFallback: boolean;
  isPrimary: boolean;
}

export interface PreviewView {
  id: string;
  projectId: string;
  branch: string;
  isPrimary: boolean;
  status: string;
  environment: string | null;
  paused: boolean;
  archived: boolean;
  retired: boolean;
  removed: boolean;
  evidence: Record<string, { evidence: string; number: number | null; url: string | null }>;
  checkouts: PreviewCheckoutView[];
  services: PreviewServiceView[];
}

export interface PullGroupView {
  id: string;
  projectId: string;
  branch: string;
  pulls: Record<string, { number: number; title: string; url: string; branch: string; head: string; draft?: boolean; ready: boolean; blockers: string[]; reviewStatus?: 'waiting' | 'changes_requested' | 'commented' | 'approved' }>;
  previewId: string | null;
  previewUrl: string | null;
  ready: boolean;
  blockers: string[];
}

export interface ProjectView {
  id: string;
  name: string;
  workspace: string;
  configPath: string;
  defaultAgent: string;
  defaultPromptTemplate: string;
  branchPrefix: string;
  scopes: { id: string; label: string; description: string }[];
  environments: { id: string; label: string; default: boolean }[];
  agents: AgentView[];
  repositories: { id: string; path: string; absolutePath: string; worktree: boolean; required: boolean; role: string; defaultBranch?: string }[];
  services: { id: string; repository: string; openUrl: string | null }[];
  promptTemplates: { id: string; label: string }[];
  instructionFiles: string[];
}

export interface JobView {
  id: string;
  kind: string;
  projectId: string | null;
  ticketId: string | null;
  state: string;
  phase: string | null;
  progress: number;
  detail: string | null;
  error: string | null;
}

export interface StatusView {
  version: string;
  checkedAt: number;
  dataDirName: string;
  host: { port: number; loopback: boolean };
  remoteSync: { lastSyncAt: number; error: string | null };
  projects: ProjectView[];
  tickets: TicketView[];
  previews: PreviewView[];
  pulls: PullGroupView[];
  remote: { projectId: string; repositories: Record<string, { checkedAt: number; error: string | null }> }[];
  jobs: JobView[];
}

async function request<T>(route: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/gantry${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

export interface CleanupAssessment {
  ticketId: string;
  ticketIds: string[];
  checkouts: { repositoryId: string; path: string; head: string; eligible: boolean; reason: string }[];
  blockers: string[];
}

export interface CleanupResult {
  results: { repositoryId: string; path: string; status: 'removed' | 'blocked' | 'failed'; reason: string }[];
  assessment: CleanupAssessment;
}

export const gantry = {
  assessCleanup: (id: string): Promise<CleanupAssessment> => request(`/api/tickets/${id}/worktree-cleanup`, 'GET'),
  cleanupWorktrees: (id: string, checkouts: CleanupAssessment['checkouts']): Promise<CleanupResult> =>
    request(`/api/tickets/${id}/worktree-cleanup`, 'POST', { confirm: true, checkouts }),
  workspaceWorkflowTemplates: (id: string): Promise<{ id: string; name: string; graph: Workflow }[]> => request(`/api/projects/${id}/workflow-templates`, 'GET'),
  saveWorkspaceWorkflowTemplate: (id: string, name: string, graph: Workflow, templateId?: string): Promise<{ id: string; name: string; graph: Workflow }> =>
    request(`/api/projects/${id}/workflow-templates${templateId ? `/${templateId}` : ''}`, 'POST', { name, graph }),
  workspaceWorkflow: (id: string): Promise<Workflow> => request(`/api/projects/${id}/workflow`, 'GET'),
  saveWorkspaceWorkflow: (id: string, graph: Workflow): Promise<Workflow> => request(`/api/projects/${id}/workflow`, 'POST', graph),
  saveTicketWorkflow: (id: string, graph: Workflow, revision: number): Promise<WorkflowRun> => request(`/api/tickets/${id}/workflow`, 'POST', { graph, revision }),
  stepProgress: (id: string, nodeId: string, state: StepState, message: string, revision: number): Promise<WorkflowRun> => request(`/api/tickets/${id}/workflow-progress`, 'POST', { nodeId, state, message, revision }),
  workspacePrompt: (id: string): Promise<{ prompt: string }> => request(`/api/projects/${id}/chat-prompt`, 'GET'),
  saveWorkspacePrompt: (id: string, prompt: string): Promise<{ prompt: string }> => request(`/api/projects/${id}/chat-prompt`, 'POST', { prompt }),
  status: (): Promise<StatusView> => request('/api/status', 'GET'),
  addProject: (workspace: string): Promise<{ ok: boolean; projectId: string }> => request('/api/projects', 'POST', { workspace, initialize: true }),
  removeProject: (projectId: string): Promise<{ ok: boolean }> => request(`/api/projects/${projectId}`, 'DELETE'),
  refreshProject: (projectId: string): Promise<{ ok: boolean }> => request(`/api/projects/${projectId}/refresh`, 'POST', {}),
  createTicket: (projectId: string, input: { title: string; description?: string; scope?: string; scopes?: string[]; branch?: string; additions?: string | null; workflowTemplateId?: string; graph?: Workflow }): Promise<TicketView> =>
    request(`/api/projects/${projectId}/tickets`, 'POST', input),
  updateTicket: (ticketId: string, input: { title?: string; description?: string; status?: string; scope?: string; scopes?: string[]; branch?: string; additions?: string | null }): Promise<TicketView> =>
    request(`/api/tickets/${ticketId}/update`, 'POST', input),
  setTicketOutcome: (ticketId: string, outcome: string): Promise<TicketView> =>
    request(`/api/tickets/${ticketId}/outcome`, 'POST', { outcome }),
  setTicketAwaitingReview: (ticketId: string, awaitingReview: boolean): Promise<TicketView> =>
    request(`/api/tickets/${ticketId}/awaiting-review`, 'POST', { awaitingReview }),
  deleteTicket: (ticketId: string): Promise<{ ok: boolean }> => request(`/api/tickets/${ticketId}/delete`, 'POST', {}),
  reorderTickets: (projectId: string, status: string, ticketIds: string[]): Promise<unknown> =>
    request(`/api/projects/${projectId}/tickets/reorder`, 'POST', { status, ticketIds }),
  ticketPrompt: (ticketId: string, agentId?: string): Promise<{ agentId: string; prompt: string }> =>
    request(`/api/tickets/${ticketId}/prompt`, 'POST', { agentId }),
  startTicket: (ticketId: string, input: { agentId?: string; prompt?: string }): Promise<{ ok: boolean; jobId: string; deduped?: boolean }> =>
    request(`/api/tickets/${ticketId}/start`, 'POST', input),
  handoffTicket: (ticketId: string): Promise<{ ok: boolean; sessionId: string | null; deepLink: string | null }> =>
    request(`/api/tickets/${ticketId}/handoff`, 'POST', {}),
  previewAction: (previewId: string, action: string, body?: { confirm?: boolean; environmentId?: string }): Promise<{ ok: boolean }> =>
    request(`/api/previews/${previewId}/${action}`, 'POST', body ?? {}),
};
