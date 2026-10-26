import { assistantNameFor, newId, isValidBranchName, branchFor, newWorkflow, type Workflow } from '@gantry/shared';
import type { Database } from '../db/db.js';

/**
 * Ticket store: a local work queue per project. Branches come from ticket
 * titles (untrusted) and are validated with Git's own ref rules before any
 * worktree is created. `active_run_id` is the atomic start lock: at most one
 * agent run can be attached to a ticket at a time, enforced by a partial
 * UNIQUE index so even a race between two queued jobs cannot double-start.
 */

export interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  assistant_name?: string | null;
  description: string;
  status: 'backlog' | 'in_progress' | 'done';
  scope: string;
  scopes?: string[] | null;
  scopes_json?: string | null;
  branch: string;
  additions: string | null;
  /** Final notes: the ticket's result, which may be a link rather than code. */
  outcome?: string | null;
  /** Set by the person: the ticket's work is out for review. */
  awaiting_review?: number;
  position: number;
  active_run_id: string | null;
  workflow_json?: string | null;
  created_at: string;
  updated_at: string;
}

export const TICKET_TITLE_MAX = 140;
export const TICKET_DESCRIPTION_MAX = 5000;
export const TICKET_OUTCOME_MAX = 5000;

export class TicketError extends Error {}

export interface TicketInput {
  title: string;
  assistantName?: string;
  description?: string;
  status?: string;
  scope?: string;
  scopes?: string[];
  branch?: string;
  additions?: string | null;
}

export function validateTicketInput(
  input: TicketInput,
  previous?: TicketRow,
  branchPrefix = 'ticket',
): { title: string; description: string; status: TicketRow['status']; scope: string; scopes?: string[] | null; branch: string; additions: string | null } {
  const title = String(input.title ?? previous?.title ?? '').trim();
  if (!title) throw new TicketError('Title is required.');
  if (title.length > TICKET_TITLE_MAX) throw new TicketError(`Title must be ${TICKET_TITLE_MAX} characters or fewer.`);
  const description = String(input.description ?? previous?.description ?? '').trim();
  if (description.length > TICKET_DESCRIPTION_MAX) throw new TicketError(`Notes must be ${TICKET_DESCRIPTION_MAX} characters or fewer.`);
  const status = (input.status ?? previous?.status ?? 'backlog') as TicketRow['status'];
  if (!['backlog', 'in_progress', 'done'].includes(status)) throw new TicketError('Unknown ticket status.');
  const scope = input.scope ?? previous?.scope ?? 'both';
  if (typeof scope !== 'string') throw new TicketError('Legacy scope must be a string.');
  if (input.scopes !== undefined && (!Array.isArray(input.scopes) || input.scopes.some((id) => typeof id !== 'string' || !id))) {
    throw new TicketError('Scopes must be a list of service IDs.');
  }
  const scopes = input.scopes === undefined ? previous?.scopes : [...new Set(input.scopes)];
  let branch = input.branch ?? previous?.branch;
  if (branch === undefined || branch === '') branch = branchFor(title, branchPrefix);
  branch = String(branch).trim();
  if (!isValidBranchName(branch)) throw new TicketError('Branch contains characters Git cannot use.');
  if (previous && previous.active_run_id && branch !== previous.branch) {
    throw new TicketError('The branch cannot change after agent work has started.');
  }
  return { title, description, status, scope, scopes, branch, additions: input.additions ?? previous?.additions ?? null };
}

export class TicketStore {
  constructor(private readonly db: Database) {}

  all(projectId: string): TicketRow[] {
    const rows = this.db.prepare('SELECT * FROM tickets WHERE project_id=? ORDER BY status, position, created_at').all(projectId) as unknown as TicketRow[];
    return rows.map(readTicketScopes);
  }

  get(id: string): TicketRow | null {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id=?').get(id) as TicketRow | undefined;
    return row ? readTicketScopes(row) : null;
  }

  create(projectId: string, input: TicketInput, scopes: string[], branchPrefix: string, workflow?: Workflow): TicketRow {
    this.validateAssistantName(projectId, input.assistantName);
    const validated = validateTicketInput(input, undefined, branchPrefix);
    if (input.scopes === undefined && input.scope === undefined) validated.scopes = [...scopes];
    if (validated.scopes != null) {
      for (const id of validated.scopes) {
        if (!scopes.includes(id)) throw new TicketError(`Unknown service scope "${id}".`);
      }
    } else if (input.scope !== undefined && scopes.length && !scopes.includes(validated.scope) && validated.scope !== 'both') {
      throw new TicketError(`Unknown ticket scope "${validated.scope}".`);
    }
    const now = new Date().toISOString();
    const ticket: TicketRow = {
      id: newId(),
      project_id: projectId,
      ...validated,
      position: 0,
      active_run_id: null,
      workflow_json: JSON.stringify(newWorkflow(workflow)),
      created_at: now,
      updated_at: now,
    };
    // New tickets go to the TOP of their column (matching the legacy board):
    // take position 0 and shift the rest down.
    this.db
      .prepare(
        `INSERT INTO tickets (id, project_id, title, description, status, scope, branch, additions, position, active_run_id, created_at, updated_at, workflow_json, scopes_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticket.id, ticket.project_id, ticket.title, ticket.description, ticket.status, ticket.scope, ticket.branch, ticket.additions, ticket.position, null, ticket.created_at, ticket.updated_at, ticket.workflow_json!, validated.scopes == null ? null : JSON.stringify(validated.scopes));
    this.db.prepare('UPDATE tickets SET position = position + 1 WHERE project_id=? AND status=? AND id != ?').run(projectId, ticket.status, ticket.id);

    const usedNames = new Set(this.all(projectId).filter(other => other.id !== ticket.id).map(other => other.assistant_name!.toLowerCase()));
    let assistantName = input.assistantName?.trim() || assistantNameFor(ticket.id);
    for (let attempt = 1; !input.assistantName && usedNames.has(assistantName.toLowerCase()); attempt++) {
      assistantName = `${assistantName} ${assistantNameFor(`${ticket.id}-${attempt}`).split(' ')[1]}`;
    }

    this.db.prepare('UPDATE tickets SET assistant_name=? WHERE id=?').run(assistantName, ticket.id);
    return this.get(ticket.id)!;
  }

  update(id: string, input: TicketInput, scopes: string[], branchPrefix: string): TicketRow {
    const previous = this.get(id);
    if (!previous) throw new TicketError('Ticket not found.');
    this.validateAssistantName(previous.project_id, input.assistantName, id);
    const validated = validateTicketInput(input, previous, branchPrefix);
    if (input.scopes !== undefined) {
      for (const id of validated.scopes ?? []) {
        if (!scopes.includes(id) && !previous.scopes?.includes(id)) throw new TicketError(`Unknown service scope "${id}".`);
      }
    } else if (input.scope !== undefined && input.scope !== previous.scope && scopes.length && !scopes.includes(validated.scope) && validated.scope !== 'both') {
      throw new TicketError(`Unknown ticket scope "${validated.scope}".`);
    }
    const statusChanged = validated.status !== previous.status;
    if (input.assistantName !== undefined) this.db.prepare('UPDATE tickets SET assistant_name=? WHERE id=?').run(input.assistantName.trim(), id);
    this.db
      .prepare('UPDATE tickets SET title=?, description=?, status=?, scope=?, branch=?, additions=?, updated_at=?, scopes_json=? WHERE id=?')
      .run(validated.title, validated.description, validated.status, validated.scope, validated.branch, validated.additions, new Date().toISOString(), validated.scopes == null ? null : JSON.stringify(validated.scopes), id);
    if (statusChanged) {
      const maxPosition = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM tickets WHERE project_id=? AND status=?').get(previous.project_id, validated.status) as { p: number }).p;
      this.db.prepare('UPDATE tickets SET position=? WHERE id=?').run(Number(maxPosition) + 1, id);
    }
    return this.get(id)!;
  }

  patch(id: string, values: Partial<Pick<TicketRow, 'status' | 'active_run_id' | 'additions'>>): TicketRow {
    const previous = this.get(id);
    if (!previous) throw new TicketError('Ticket not found.');
    this.db
      .prepare('UPDATE tickets SET status=COALESCE(?, status), active_run_id=COALESCE(?, active_run_id), additions=COALESCE(?, additions), updated_at=? WHERE id=?')
      .run(values.status ?? null, values.active_run_id ?? null, values.additions ?? null, new Date().toISOString(), id);
    return this.get(id)!;
  }

  private validateAssistantName(projectId: string, name: unknown, exceptId?: string): void {
    if (name === undefined) return;
    if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z '-]{1,39}$/.test(name.trim())) {
      throw new TicketError('Assistant name must be 2–40 letters, spaces, apostrophes or hyphens.');
    }
    if (name.trim().toLowerCase() === 'gantry') throw new TicketError('Gantry is reserved for workspace voice commands.');
    if (this.all(projectId).some(ticket => ticket.id !== exceptId && ticket.assistant_name?.toLowerCase() === name.trim().toLowerCase())) {
      throw new TicketError('Another ticket in this workspace already uses that assistant name.');
    }
  }

  /** Set or clear a ticket's final notes. Kept apart from update() so stages can write it without touching other fields. */
  setOutcome(id: string, outcome: unknown): TicketRow {
    if (outcome !== null && typeof outcome !== 'string') throw new TicketError('Final notes must be text.');
    const text = (outcome ?? '').trim();
    if (text.length > TICKET_OUTCOME_MAX) throw new TicketError(`Final notes must be ${TICKET_OUTCOME_MAX} characters or fewer.`);
    const result = this.db.prepare('UPDATE tickets SET outcome=?, updated_at=? WHERE id=?').run(text || null, new Date().toISOString(), id);
    if (Number(result.changes) === 0) throw new TicketError('Ticket not found.');
    return this.get(id)!;
  }

  /** Mark or unmark a ticket as waiting on review. Only the person sets this; it tracks where the work really is. */
  setAwaitingReview(id: string, value: unknown): TicketRow {
    if (typeof value !== 'boolean') throw new TicketError('Waiting on review must be true or false.');
    const result = this.db.prepare('UPDATE tickets SET awaiting_review=?, updated_at=? WHERE id=?').run(value ? 1 : 0, new Date().toISOString(), id);
    if (Number(result.changes) === 0) throw new TicketError('Ticket not found.');
    return this.get(id)!;
  }

  remove(id: string): void {
    const result = this.db.prepare('DELETE FROM tickets WHERE id=?').run(id);
    if (Number(result.changes) === 0) throw new TicketError('Ticket not found.');
  }

  /** Reorder one status column. The submitted order must be complete and current. */
  reorder(projectId: string, status: string, ticketIds: string[]): TicketRow[] {
    if (!['backlog', 'in_progress', 'done'].includes(status)) throw new TicketError('Unknown ticket status.');
    if (!Array.isArray(ticketIds) || ticketIds.some((id) => typeof id !== 'string')) throw new TicketError('Ticket order must be a list of ticket IDs.');
    const column = this.db.prepare('SELECT id FROM tickets WHERE project_id=? AND status=?').all(projectId, status) as { id: string }[];
    const current = column.map((row) => row.id);
    if (ticketIds.length !== current.length || new Set(ticketIds).size !== ticketIds.length || current.some((id) => !ticketIds.includes(id))) {
      throw new TicketError('Ticket order no longer matches this column. Refresh and try again.');
    }
    const tx = this.db;
    tx.exec('BEGIN IMMEDIATE');
    try {
      ticketIds.forEach((id, index) => {
        tx.prepare('UPDATE tickets SET position=? WHERE id=?').run(index, id);
      });
      tx.exec('COMMIT');
    } catch (error) {
      tx.exec('ROLLBACK');
      throw error;
    }
    return this.all(projectId).filter((ticket) => ticket.status === status);
  }

  /** Atomically attach a run to a ticket. Returns false when a run is already active. */
  claimRun(ticketId: string, runId: string): boolean {
    const result = this.db
      .prepare('UPDATE tickets SET active_run_id=?, updated_at=? WHERE id=? AND active_run_id IS NULL')
      .run(runId, new Date().toISOString(), ticketId);
    return Number(result.changes) === 1;
  }

  releaseRun(ticketId: string, runId: string): void {
    this.db.prepare('UPDATE tickets SET active_run_id=NULL, updated_at=? WHERE id=? AND active_run_id=?').run(new Date().toISOString(), ticketId, runId);
  }

  /** Move tickets to Done once their branches are confirmed merged. */
  completeMergedBranches(projectId: string, branches: Set<string>): TicketRow[] {
    if (!branches.size) return [];
    const now = new Date().toISOString();
    const tickets = this.db.prepare("SELECT * FROM tickets WHERE project_id=? AND status != 'done'").all(projectId) as unknown as TicketRow[];
    const completed: TicketRow[] = [];
    for (const ticket of tickets) {
      if (!branches.has(ticket.branch)) continue;
      this.db.prepare("UPDATE tickets SET status='done', updated_at=? WHERE id=?").run(now, ticket.id);
      completed.push({ ...readTicketScopes(ticket), status: 'done' });
    }
    return completed;
  }
}

function readTicketScopes(row: TicketRow): TicketRow {
  return { ...row, assistant_name: row.assistant_name || assistantNameFor(row.id), scopes: row.scopes_json == null ? null : JSON.parse(row.scopes_json) as string[] };
}
