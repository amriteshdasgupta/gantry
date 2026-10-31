import "server-only";
import { resolveOpenCodeModel } from './agents/opencode-models';
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "./spawn";
import { CLI, findAgent, getAgent, isCliKind, type CliKind } from "./agents/store";
import { HOME, git, withLock } from "./exec";
import { httpError } from "./http";
import { loadChat, pendingFor } from "./chats";
import { ticketContext, type TicketWorkspace } from "./ticket-chat";
import { summarizeExecution } from "./workflow-summary";
import type { Execution } from "./workflow-state";
import { openInHerdrChat, type LaunchTarget } from "./terminal-launcher";
import { sessionOpenInTerminal } from './stage-sessions';

export interface MasterMessage {
  role: 'user' | 'assistant';
  text: string;
  error?: string;
}
const globalMaster = globalThis as unknown as { masterTurns?: Map<string, AbortController> };
const masterTurns = globalMaster.masterTurns ??= new Map<string, AbortController>();
export const masterBusy = (id: string) => masterTurns.has(id);
export const stopMaster = (id: string) => masterTurns.get(id)?.abort();

const directory = path.join(HOME, "ticket-conversations");
export interface TicketConversation {
  ticketId: string;
  agentId: string;
  provider: CliKind;
  providerName: string;
  model: string;
  sessionId: string;
  previousSessionIds?: string[];
  // Also preserves legacy chats whose starting prompt was handed to the user.
  promptPrefilled?: boolean;
  cwd: string;
  branch: string;
  checkouts: { repositoryId: string; path: string }[];
  context: string;
  /** The first message a new chat starts with, when it differs from the context. */
  firstMessage?: string;
  createdAt: number;
  messages?: MasterMessage[];
}
const fileFor = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw httpError(400, "Invalid ticket.");
  return path.join(directory, `${id}.json`);
};
export function conversationFor(id: string): TicketConversation | null {
  try { return JSON.parse(fs.readFileSync(fileFor(id), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
function save(record: TicketConversation) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = fileFor(record.ticketId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function contextFor(work: TicketWorkspace) {
  return [
    `Gantry ticket: ${work.ticket.title}`, `Ticket ID: ${work.ticket.id}`, `Branch: ${work.ticket.branch}`,
    `Your assistant name is ${work.ticket.assistant_name || 'the ticket assistant'}.`,
    work.ticket.description, work.ticket.additions || "", work.prompt || "",
    `Workspace instructions: ${path.join(work.project.workspace, "AGENTS.md")}`,
    "Prepared ticket worktrees:", ...work.checkouts.map(c => `${c.repositoryId}: ${c.path}`),
    "Read workspace and repository instructions. Work in the prepared worktrees, preserve unrelated changes, and validate the feature. Follow the workspace starting prompt above for delivery and validation. Gantry associates PRs on this branch with this ticket. Do not merge or deploy.",
  ].filter(Boolean).join("\n\n");
}

/** Create a durable Codex thread without sending a turn or invoking a model. */
async function withCodexServer<T>(cwd: string, action: (call: (method: string, params: unknown) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const child = spawn(CLI.codex, ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 0;
  let buffer = "";
  const waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const fail = (error: Error) => { for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(error); } waiting.clear(); };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Codex app server exited before creating the conversation.")));
  child.stdin.on("error", fail);
  child.stderr.on("data", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const entry = waiting.get(message.id);
        if (!entry) continue;
        waiting.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || "Codex could not create a conversation."));
        else entry.resolve(message.result || {});
      } catch { /* Non-protocol output is not a response. */ }
    }
  });
  const call = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Codex did not respond. Check its installation and try again.")); }, 20000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await call("initialize", { clientInfo: { name: "gantry", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return await action(call);
  } finally { child.stdin.end(); child.kill(); fail(new Error("Codex connection closed.")); }
}

/** The raw durable rollout of a Codex stage thread. */
export async function readWorkflowRollout(cwd: string, sessionId: string): Promise<string> {
  return withCodexServer(cwd, async call => {
    const result = await call("thread/read", { threadId: sessionId, includeTurns: true });
    const thread = result.thread as { path?: string };
    if (!thread?.path) throw new Error('Codex did not expose the stage history file.');
    return fs.promises.readFile(thread.path, 'utf8');
  });
}

export async function readWorkflowConversation(cwd: string, sessionId: string) {
  // A separate app-server reports another process's live turn as interrupted.
  // Its durable task events are the cross-process source of completion.
  const { rolloutThread } = await import('./workflow-chat-state');
  return rolloutThread(await readWorkflowRollout(cwd, sessionId));
}

/** The Claude Code transcript file for a session, if it still exists. */
export function claudeTranscriptPath(id: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  try {
    for (const d of fs.readdirSync(projects, { withFileTypes: true })) {
      const candidate = path.join(projects, d.name, `${id}.jsonl`);
      if (d.isDirectory() && fs.existsSync(candidate)) return candidate;
    }
  } catch { /* No Claude history on this machine. */ }
  return null;
}

async function createCodexThread(record: Omit<TicketConversation, "sessionId">, existingId?: string, keep: (record: TicketConversation) => void = save): Promise<string> {
  return withCodexServer(record.cwd, async call => {
    if (existingId) {
      try {
        const existing = await call("thread/read", { threadId: existingId, includeTurns: !record.promptPrefilled });
        const rollout = (existing.thread as { path?: string })?.path;
        if (!rollout) throw new Error("Codex returned no conversation file. Retry after updating Codex.");
        await fs.promises.access(rollout);
        // Older associations with real turns already have a visible conversation.
        if ((existing.thread as { turns?: unknown[] })?.turns?.length) record.promptPrefilled = true;
        return existingId;
      } catch (error) {
        const e = error as NodeJS.ErrnoException;
        if (e.code !== "ENOENT" && !/no rollout found|thread .*not found|failed to resolve rollout path|does not exist/i.test(e.message)) throw error;
      }
    }
    const response = await call("thread/start", {
      cwd: record.cwd, ephemeral: false, developerInstructions: record.context,
      sandbox: "danger-full-access", approvalPolicy: "never",
      ...(record.model ? { model: record.model } : {}),
    });
    const id = (response.thread as { id?: string })?.id;
    if (!id || !/^[\w-]+$/.test(id)) throw new Error("Codex did not return a conversation ID.");
    // thread/start is lazy: materialize history without starting model execution.
    await call("thread/inject_items", { threadId: id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: record.context }] }] });
    // Persist the policy for the native app's later resume, before queuing any work.
    // Creation-time overrides alone do not establish saved next-turn settings.
    await call("thread/settings/update", {
      threadId: id, sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never",
    });
    const rollout = (response.thread as { path?: string })?.path;
    if (!rollout) throw new Error("Codex did not return a durable conversation path.");
    await fs.promises.access(rollout);
    keep({ ...record, sessionId: id });
    await call("thread/name/set", { threadId: id, name: `Gantry · ${record.branch}` }).catch(() => {});
    return id;
  });
}

/**
 * Create an OpenCode session that already holds the ticket context, without a model turn,
 * through a short-lived local OpenCode server. The chat then resumes it with `opencode -s`.
 */
async function createOpenCodeSession(record: Omit<TicketConversation, "sessionId">): Promise<string> {
  record.model = await resolveOpenCodeModel(record.model, record.cwd);
  const password = randomUUID();
  const child = spawn(CLI.opencode, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: record.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error("OpenCode's server did not start. Check its installation and try again.")), 30000);
      const read = (chunk: Buffer) => {
        out += chunk;
        const found = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (found) { clearTimeout(timer); resolve(found[1]); }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", () => { clearTimeout(timer); reject(new Error(`OpenCode's server stopped: ${out.trim().split("\n").slice(-2).join(" ")}`)); });
    });
    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json" };
    const at = `?directory=${encodeURIComponent(record.cwd)}`;
    const [providerID, ...rest] = record.model.split("/");
    const made = await fetch(`${url}/session${at}`, {
      method: "POST", headers, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ title: `Gantry · ${record.branch}`, ...(rest.length ? { model: { providerID, id: rest.join("/") } } : {}) }),
    });
    const id = made.ok ? ((await made.json()) as { id?: string }).id : undefined;
    if (!id || !/^ses_\w+$/.test(id)) throw new Error(`OpenCode did not create a conversation (${made.status}).`);
    // The context goes in as the first message without asking for a reply, so the chat starts from it.
    const context = await fetch(`${url}/session/${id}/message${at}`, {
      method: "POST", headers, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: record.context }] }),
    });
    if (!context.ok) throw new Error(`OpenCode did not accept the ticket context (${context.status}).`);
    return id;
  } finally { child.kill(); }
}

/** A new conversation for a coding CLI: Claude takes the id Gantry picks; Codex and OpenCode create theirs with the context in it. */
async function newSession(record: Omit<TicketConversation, "sessionId">, keep?: (record: TicketConversation) => void): Promise<string> {
  if (record.provider === "codex") return createCodexThread(record, undefined, keep);
  if (record.provider === "opencode") return createOpenCodeSession(record);
  return randomUUID();
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
// What a Codex or OpenCode chat is sent first; its context is already in the conversation.
const KICKOFF = "Start the work described above.";
function claudeSessionExists(id: string) {
  return claudeTranscriptPath(id) !== null;
}
async function launch(record: TicketConversation, work: TicketWorkspace, persist = true, claudeExtras: string[] = [], stageLabel?: string) {
  const opening = record.firstMessage ?? KICKOFF;
  let typeMessage: string | undefined;
  let args: string[];
  if (record.provider === "claude") {
    const resumes = claudeSessionExists(record.sessionId);
    args = [CLI.claude, ...(resumes ? ["--resume", record.sessionId] : ["--session-id", record.sessionId]), "--append-system-prompt", record.context, ...claudeExtras, ...(record.model ? ["--model", record.model] : []), ...record.checkouts.flatMap(c => ["--add-dir", c.path]), ...(!record.promptPrefilled && !resumes ? ["--", record.firstMessage ?? record.context] : [])];
  } else if (record.provider === "codex") {
    args = [CLI.codex, "resume", record.sessionId, "-C", record.cwd, "--sandbox", "danger-full-access", "--ask-for-approval", "never", ...(record.model ? ["--model", record.model] : []), ...(!record.promptPrefilled ? [opening] : [])];
  } else {
    // OpenCode takes no opening message when resuming, so herdr types it once the chat is up.
    record.model = await resolveOpenCodeModel(record.model, record.cwd);
    args = [CLI.opencode, "-s", record.sessionId, ...(record.model ? ["--model", record.model] : [])];
    if (!record.promptPrefilled) typeMessage = opening;
  }
  const command = `cd ${quote(record.cwd)} && ${["env", `PATH=${process.env.PATH || ""}`, ...args].map(quote).join(" ")}`;
  const target: LaunchTarget = {
    workspace: { id: work.project.id, name: work.project.name, path: work.project.workspace },
    ticket: { id: record.ticketId, title: work.ticket.title }, sessionId: record.sessionId, cwd: record.cwd, command, typeMessage, stageLabel,
  };
  await openInHerdrChat(target);
  record.promptPrefilled = true;
  if (persist) save(record);
}

export async function openTicketConversation(ticketId: string, origin: string) {
  if (masterBusy(ticketId)) throw httpError(409, 'Wait for the spoken conversation to finish before opening its terminal.');
  return withLock(`ticket-conversation:${ticketId}`, async () => {
    if (masterBusy(ticketId)) throw httpError(409, 'The master chat is answering.');
    const { executionFor } = await import('./workflow-executor');
    const run = executionFor(ticketId);
    if (run || masterConversationFor(ticketId)) return openMasterConversation(ticketId, run, origin);
    let record = conversationFor(ticketId);
    // Resolve the ticket even on resume; deleted tickets must not launch a stale record.
    const existing = await ticketContext(ticketId);
    if (existing.ticket.status !== "in_progress") throw httpError(409, "Move this ticket to In progress to open its conversation.");
    if (pendingFor(`ticket/${ticketId}`)) throw httpError(409, "The previous embedded agent is still running. Wait for it to finish, then retry.");
    if (!record) {
      const agent = getAgent();
      if (!isCliKind(agent.kind)) throw httpError(409, "This provider is an API endpoint, not a coding CLI. Choose Claude Code, OpenCode or Codex in Settings to open a ticket chat.");
      const work = await ticketContext(ticketId, true);
      const cwd = work.checkouts[0]?.path;
      if (!cwd) throw httpError(409, "This ticket has no worktrees.");
      for (const checkout of work.checkouts) {
        if ((await git(checkout.path, "branch", "--show-current")).trim() !== work.ticket.branch) throw httpError(409, "A ticket worktree changed branches. Restore its ticket branch before opening a conversation.");
      }
      const base = { ticketId, agentId: agent.id, provider: agent.kind as CliKind, providerName: agent.name, model: agent.model, cwd, branch: work.ticket.branch, checkouts: work.checkouts, context: contextFor(work), createdAt: Date.now() };
      // Reuse a real session from the former embedded chat when it exists.
      const previous = loadChat(`ticket/${ticketId}`)?.sessions?.[agent.id]?.id;
      const sessionId = agent.kind !== "opencode" && previous && /^[0-9a-f-]{36}$/i.test(previous) ? previous : await newSession(base);
      record = { ...base, sessionId };
      save(record);
    } else if (record.branch !== existing.ticket.branch) {
      throw httpError(409, "This ticket is linked to a conversation on its original branch. Restore that branch to reopen the same conversation.");
    }
    if (record.provider === "codex") {
      const id = await createCodexThread(record, record.sessionId);
      if (id !== record.sessionId) {
        record = { ...record, promptPrefilled: false, previousSessionIds: [...(record.previousSessionIds ?? []), record.sessionId], sessionId: id };
        save(record);
      }
    }
    await launch(record, existing);
    return { conversation: publicConversation(record) };
  });
}
export function publicConversation(record: TicketConversation | null) {
  if (!record) return null;
  const { ticketId, provider, providerName, sessionId, branch, createdAt } = record;
  return { ticketId, provider, providerName, sessionId, branch, createdAt };
}

/** Open an existing stage session without replacing the ticket's original chat association. */
export async function openWorkflowConversation(work: TicketWorkspace, attempt: {sessionId?:string;providerKind:string;providerId:string;model:string}, stageLabel = "Stage") {
  if (!attempt.sessionId || !/^[\w-]+$/.test(attempt.sessionId) || !['codex','claude','opencode'].includes(attempt.providerKind)) throw httpError(409, 'Read this API stage in its history panel.');
  const cwd=work.checkouts[0]?.path;
  if (!cwd) throw httpError(409,'This ticket has no worktrees.');
  const record:TicketConversation={ticketId:work.ticket.id,agentId:attempt.providerId,provider:attempt.providerKind as CliKind,providerName:attempt.providerKind,model:attempt.model,sessionId:attempt.sessionId,cwd,branch:work.ticket.branch,checkouts:work.checkouts,context:'Continue the existing Gantry stage. Preserve its instructions and finish with its structured GANTRY_RESULT handover.',promptPrefilled:true,createdAt:Date.now()};
  if(record.provider==='claude' && !claudeSessionExists(record.sessionId)) throw httpError(409,'This stage conversation is no longer available. Its output remains in stage history.');
  if(record.provider!=='claude') { await launch(record,work,false,[],stageLabel); return {conversation:publicConversation(record)}; }
  // A Claude chat gets the same tools and MCP servers the headless stage has, so both behave alike.
  const { allowedTools, stageSettingsFile } = await import('./stage-permissions');
  const { stageMcpConfig } = await import('./stage-mcp');
  const allow = allowedTools(work.project.id);
  const mcp = await stageMcpConfig(work.ticket.id, work.checkouts.map(c => c.path));
  const settings = stageSettingsFile(work.project.workspace);
  await launch(record,work,false,[...(allow.length ? ['--allowedTools', allow.join(',')] : []), ...(mcp ? ['--mcp-config', mcp] : []), ...(settings ? ['--settings', settings] : [])],stageLabel);
  return {conversation:publicConversation(record)};
}

// A graph ticket's master chat is kept apart from the plain ticket chat: a plain chat stops
// automation from starting, and the master chat exists to work alongside it.
const masterFileFor = (id: string) => path.join(directory, "master", path.basename(fileFor(id)));
export function masterConversationFor(id: string): TicketConversation | null {
  try { return JSON.parse(fs.readFileSync(masterFileFor(id), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export function forgetConversations(id: string) {
  fs.rmSync(fileFor(id), { force: true });
  fs.rmSync(masterFileFor(id), { force: true });
}
function saveMaster(record: TicketConversation) {
  fs.mkdirSync(path.dirname(masterFileFor(record.ticketId)), { recursive: true, mode: 0o700 });
  const file = masterFileFor(record.ticketId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
const masterEndpoint = (origin: string) => `${origin}/api/workflow-execution`;
function masterContextFor(work: TicketWorkspace, run: Execution, origin: string) {
  const api = masterEndpoint(origin);
  const call = (body: Record<string, string>) => `curl -sS ${api} -H 'Content-Type: application/json' --data-binary @- <<'JSON'\n${JSON.stringify({ ticketId: work.ticket.id, ...body })}\nJSON`;
  return [
    `You are the master chat for the Gantry ticket "${work.ticket.title}" (ticket ID ${work.ticket.id}, branch ${work.ticket.branch}). The ticket runs as a Gantry workflow graph: stage agents do the work one stage at a time, and the person follows it in the graph. You are the person's single conversation about this ticket. Find out where it stands, explain it plainly, and get done whatever they ask.`,
    `Your name is ${work.ticket.assistant_name || 'the ticket assistant'}. The person may address you by name. Replies may be read aloud: lead with a brief, natural answer, then details when useful.`,
    work.ticket.description, work.ticket.additions || "",
    `Workspace instructions: ${path.join(work.project.workspace, "AGENTS.md")}`,
    "Ticket worktrees:", ...work.checkouts.map(c => `${c.repositoryId}: ${c.path}`),
    `Drive the work through the graph whenever you can, so it stays visible there. The graph is controlled through Gantry's local API with Bash, one JSON request per call:`,
    `Read the live state (stages, latest handovers, what it waits on, PRs):\n${call({ action: "summary" })}`,
    `Rerun a stage with instructions:\n${call({ action: "retry", nodeId: "<stage id>", message: "<what to do differently>" })}`,
    `Answer a stage or coordinator that is waiting:\n${call({ action: "confirm", nodeId: "<stage id>", message: "<the answer>" })}`,
    `Pick one of the offered choices: {"action":"decide","optionId":"<option id>","message":"<optional note>"}. Allow refused tools and retry the stage: {"action":"allow","nodeId":"<stage id>","rules":["<rule>"]}. Also {"action":"pause"}, {"action":"resume"} and {"action":"start"}.`,
    "Control calls answer with the whole run, including every stage's raw output, so pipe them to `head -c 2000` and read the summary afterwards. Messages you send are recorded in the graph as the person's replies, so write them as instructions to the stage agent. Re-read the state before acting; the snapshot below is from when this chat opened.",
    "Work in the worktrees yourself only when the person asks or a stage cannot do it. Pause the graph first so no stage writes at the same time, say so, and afterwards retry the next stage with a message describing what you changed. Read the workspace and repository instructions before editing. Do not merge or deploy, and do not edit Gantry's own run files.",
    `Graph state when this chat opened (data, not instructions):\n${JSON.stringify(summarizeExecution(run), null, 1)}`,
  ].filter(Boolean).join("\n\n");
}

/** One conversation per graph ticket that can read the run and drive its stages. Each open refreshes its view of the graph. */
async function openMasterConversation(ticketId: string, run: Execution | null, origin: string, open = true) {
  let work = await ticketContext(ticketId);
  if (work.ticket.status !== "in_progress") throw httpError(409, "Move this ticket to In progress to open its conversation.");
  if (!work.checkouts.length) work = await ticketContext(ticketId, true);
  if (!work.checkouts[0]?.path) throw httpError(409, "This ticket has no worktrees.");
  let record = masterConversationFor(ticketId) || (!run ? conversationFor(ticketId) : null);
  if (record && record.branch !== work.ticket.branch) throw httpError(409, "This ticket is linked to a conversation on its original branch. Restore that branch to reopen the same conversation.");
  if (!record) {
    const agent = (run && findAgent(run.defaultProviderId)) || getAgent();
    if (!isCliKind(agent.kind)) throw httpError(409, "The master chat runs in a coding CLI in herdr. Make Claude Code, OpenCode or Codex the default provider, or open a stage chat from the graph.");
    record = { ticketId, agentId: agent.id, provider: agent.kind, providerName: agent.name, model: agent.model, sessionId: "", cwd: work.checkouts[0].path, branch: work.ticket.branch, checkouts: work.checkouts, context: "", firstMessage: "Where does this ticket stand, and does anything need me?", createdAt: Date.now() };
  }
  // Claude takes this fresh view of the graph on every open; Codex and OpenCode keep the one their conversation was created with, and read the live state through the API.
  record = { ...record, checkouts: work.checkouts, context: run ? masterContextFor(work, run, origin) : contextFor(work) + '\n\nYou are the ticket master assistant. Answer concisely. Do not start work unless asked.' };
  if (open && !record.sessionId) record.sessionId = await newSession(record, saveMaster);
  saveMaster(record);
  if (!open) return { conversation: publicConversation(record), master: true };
  if (record.provider !== "claude") {
    await launch(record, work, false);
    saveMaster(record);
    return { conversation: publicConversation(record), master: true };
  }
  // Graph calls are not pre-approved: the person approves each one in the chat. The workspace stage settings still apply.
  const { stageMcpConfig } = await import("./stage-mcp");
  const { stageSettingsFile } = await import("./stage-permissions");
  const mcp = await stageMcpConfig(ticketId, work.checkouts.map(c => c.path));
  const settings = stageSettingsFile(work.project.workspace);
  await launch(record, work, false, [...(mcp ? ["--mcp-config", mcp] : []), ...(settings ? ["--settings", settings] : [])]);
  saveMaster(record);
  return { conversation: publicConversation(record), master: true };
}

/** One writer to the same durable provider session, whether accessed by voice, text or herdr. */
export async function sendMasterMessage(ticketId: string, text: unknown, origin: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw httpError(400, 'Message must contain 1–8000 characters.');
  if (masterBusy(ticketId)) throw httpError(409, 'This assistant is already answering.');
  const abort = new AbortController();
  masterTurns.set(ticketId, abort);
  try {
    return await withLock(`ticket-conversation:${ticketId}`, async () => {
      const { executionFor } = await import('./workflow-executor');
      await openMasterConversation(ticketId, executionFor(ticketId), origin, false);
      const record = masterConversationFor(ticketId)!;
      if (record.sessionId && await sessionOpenInTerminal(record.sessionId)) throw httpError(409, 'Exit this master chat in herdr before speaking here, so its session has only one writer.');
      const { drivers } = await import('./agents');
      const { allowedTools, stageSettingsFile } = await import('./stage-permissions');
      const { stageMcpConfig } = await import('./stage-mcp');
      const work = await ticketContext(ticketId);
      const mcpConfig = record.provider === 'claude' ? await stageMcpConfig(ticketId, record.checkouts.map(checkout => checkout.path)) : undefined;
      const history = (record.messages ?? []).filter(message => !message.error);
      const answer: MasterMessage = { role: 'assistant', text: '', error: 'Reply interrupted before completion.' };
      record.messages = [...(record.messages ?? []), { role: 'user', text: text.trim() }, answer];
      saveMaster(record);
      const timer = setTimeout(() => abort.abort(), 5 * 60 * 1000);
      try {
        await drivers[record.provider]({
          agent: { id: record.agentId, kind: record.provider, name: record.providerName, model: record.model },
          cwd: record.cwd, system: record.context, prompt: text.trim(), sessionId: record.sessionId || null,
          sessionDirectory: record.cwd,
          history, signal: abort.signal,
          workflow: { workspace: work.project.workspace, addDirs: record.checkouts.map(checkout => checkout.path), allowedTools: allowedTools(work.project.id), settings: stageSettingsFile(work.project.workspace) || undefined, mcpConfig: mcpConfig || undefined },
          hooks: {
            text: chunk => { answer.text += chunk; },
            tool: () => {}, cost: () => {},
            session: id => { record.sessionId = id; saveMaster(record); },
            error: error => { answer.error = error; },
            denied: denials => { answer.error = `Provider refused tools: ${denials.map(denial => denial.tool_name).join(', ')}. Check workspace permissions.`; },
          },
        });
        if (answer.error === 'Reply interrupted before completion.') delete answer.error;
        if (abort.signal.aborted) answer.error = 'Stopped.';
        if (!answer.text && !answer.error) answer.error = 'The provider returned no reply.';
      } catch (error) {
        answer.error = (error as Error).message;
      } finally {
        clearTimeout(timer);
        record.promptPrefilled = true;
        saveMaster(record);
      }
      return { messages: record.messages, conversation: publicConversation(record) };
    });
  } finally {
    masterTurns.delete(ticketId);
  }
}
