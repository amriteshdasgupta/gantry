import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Anchor, Quote, ChatEvent, ChatMessage, PrState, RecentItem, TargetInfo, ToolUse } from "@/lib/types";
import { DIRS, safeName } from "./exec";
import type { PreparedTarget } from "./targets";
import { drivers, getAgent, type Turn } from "./agents";
import { scopedSessionId } from './agents/session-scope';

/** Persisted per target: the conversation plus each agent's session for it. */
interface ChatFile {
  targetId: string;
  title: string;
  prState?: PrState;
  updatedAt: number;
  /** Per agent id: the session it continues, and what that session has cost so far
   *  (claude reports a running total across resumes). */
  sessions?: Record<string, { id: string | null; costUsd?: number; directory?: string }>;
  /** Before agents were pluggable there was one Claude session. */
  sessionId?: string | null;
  sessionCostUsd?: number;
  messages: ChatMessage[];
}

interface Run {
  msg: ChatMessage;
  abort: AbortController;
  worktree: string;
}

type Listener = (e: ChatEvent) => void;

const g = globalThis as unknown as {
  __lensListeners?: Map<string, Set<Listener>>;
  __lensRuns?: Map<string, Run>;
  __lensCleanupPaths?: Set<string>;
};
const listeners = (g.__lensListeners ??= new Map());
const ALL = "*";
const runs = (g.__lensRuns ??= new Map());
const cleanupPaths = (g.__lensCleanupPaths ??= new Set());
/** Questions asked while another answer is running, per target, oldest first. */
const queues: Map<string, { user: ChatMessage; t: PreparedTarget; agent?: string }[]> = ((g as { __lensQueues?: Map<string, never[]> }).__lensQueues ??= new Map());

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

const fileFor = (id: string) => path.join(DIRS.chats, `${safeName(id)}.json`);

export function forgetChat(id: string) {
  fs.rmSync(fileFor(id), { force: true });
}

export function loadChat(id: string): ChatFile | null {
  try {
    const chat = JSON.parse(fs.readFileSync(fileFor(id), "utf8")) as ChatFile;
    if (!chat.sessions) {
      chat.sessions = chat.sessionId ? { claude: { id: chat.sessionId, costUsd: chat.sessionCostUsd } } : {};
      delete chat.sessionId;
      delete chat.sessionCostUsd;
    }
    return chat;
  } catch {
    return null;
  }
}

function saveChat(chat: ChatFile) {
  chat.updatedAt = Date.now();
  const file = fileFor(chat.targetId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(chat, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/** Keep a chat's title and PR state current when its target is opened, so Recent shows a merge. */
export function noteTarget(info: TargetInfo) {
  const chat = loadChat(info.id);
  if (!chat || (chat.title === info.title && chat.prState === info.prState)) return;
  chat.title = info.title;
  if (info.prState) chat.prState = info.prState;
  // Written directly, not with saveChat: opening a review isn't activity, so it keeps its place in Recent.
  const file = fileFor(chat.targetId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(chat, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

export function hasChat(id: string): boolean {
  return fs.existsSync(fileFor(id));
}

export function pendingFor(id: string): ChatMessage | null {
  return runs.get(id)?.msg ?? null;
}

export function queuedFor(id: string): string[] {
  return (queues.get(id) ?? []).map((j) => j.user.id);
}

export function checkoutsHaveAgents(paths: string[]): boolean {
  const selected = new Set(paths.map(p => path.resolve(p)));
  return [...runs.values()].some(run => selected.has(path.resolve(run.worktree)))
    || [...queues.values()].some(queue => queue.some(job => selected.has(path.resolve(job.t.worktree))));
}

/** Reserve checkouts synchronously so a local review cannot start during removal. */
export async function withIdleCheckouts<T>(paths: string[], action: () => Promise<T>): Promise<T> {
  const selected = [...new Set(paths.map(p => path.resolve(p)))];
  if (selected.some(p => cleanupPaths.has(p)) || checkoutsHaveAgents(selected)) {
    throw Object.assign(new Error('Wait for checkout agents to finish before cleanup.'), { status: 409 });
  }
  selected.forEach(p => cleanupPaths.add(p));
  try {
    return await action();
  } finally {
    selected.forEach(p => cleanupPaths.delete(p));
  }
}

export function listRecent(limit = 30): RecentItem[] {
  const out: RecentItem[] = [];
  for (const name of fs.readdirSync(DIRS.chats)) {
    if (!name.endsWith(".json")) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(DIRS.chats, name), "utf8")) as ChatFile;
      out.push({
        id: c.targetId,
        title: c.title,
        updatedAt: c.updatedAt,
        questions: c.messages.filter((m) => m.role === "user").length,
        ...(c.prState ? { prState: c.prState } : {}),
      });
    } catch {
      /* skip unreadable files */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export function subscribe(id: string, fn: Listener): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(id);
  };
}

/** Listen to one target's chat, or every target's with "*" (events then carry `target`). */
function emit(id: string, e: ChatEvent) {
  const tagged = { ...e, target: id };
  for (const fn of [...(listeners.get(id) ?? []), ...(listeners.get(ALL) ?? [])]) {
    try {
      fn(tagged);
    } catch {
      /* a broken listener shouldn't stop the run */
    }
  }
}

export function deleteMessage(id: string, msgId: string): boolean {
  const chat = loadChat(id);
  if (!chat) return false;
  const before = chat.messages.length;
  // Deleting a question also removes the answer to it; deleting a thread's first question removes the thread.
  chat.messages = chat.messages.filter((m) => m.id !== msgId && m.replyTo !== msgId && m.thread !== msgId);
  const q = queues.get(id);
  if (q) queues.set(id, q.filter((j) => j.user.id !== msgId && j.user.thread !== msgId));
  if (chat.messages.length === before) return false;
  saveChat(chat);
  emit(id, { type: "deleted", id: msgId });
  return true;
}

export function stopRun(id: string): boolean {
  const run = runs.get(id);
  if (!run) return false;
  run.abort.abort();
  return true;
}

function systemPrompt(t: PreparedTarget): string {
  const { info } = t;
  const diffHint = info.baseSha
    ? `The change under review is \`git diff ${info.baseSha} ${info.headSha}\`. Use \`git diff ${info.baseSha} HEAD -- <path>\` to see what changed in a file and \`git log ${info.baseSha}..HEAD\` for its commits.`
    : "There is no diff; the user is browsing the repository.";
  return [
    info.kind === "doc"
      ? `You are helping someone review and edit a ${info.repo} document (${info.url}). The working directory is a local copy of it; the document is document.md.`
      : info.kind === "local"
      ? `You are helping someone review what a Gantry ticket produced in its ${info.repo} worktree (often documents, such as a plan, rather than code). The working directory is that worktree, at ${info.headSha}.`
      : `You are helping someone review code in ${info.owner}/${info.repo}. The working directory is an editable local checkout initially based at ${info.headSha}.`,
    `Local checkout: ${t.worktree}. Read and edit the files in this checkout.`,
    diffHint,
    "",
    t.description,
    "",
    "Answer the reviewer's questions about this code. Read the surrounding code before answering, and cite locations as path:line.",
    "Be direct and concise. Point out real bugs and risks when you see them. When the user asks for changes, edit files in this checkout and summarize the changes and validation. Preserve unrelated edits. Do not commit or push unless the user asks. " + (info.kind === "doc"
      ? `Edits stay in the local copy as a draft; the Draft view shows them, and Publish to ${info.repo} writes them back. Never publish to ${info.repo} yourself.`
      : info.kind === "local"
      ? "Edits land in the ticket's own worktree, where its stages also work; the Local changes view shows them."
      : "Explain that edits are local to the Gantry checkout; the Local changes view shows them, and Commit and push publishes them to the PR."),
    "When a picture would explain it better (a flow, a sequence of calls, how pieces connect, a state machine), draw a small diagram in a ```mermaid code block (flowchart, sequenceDiagram, classDiagram or stateDiagram). The reviewer sees it rendered. Keep it to the parts that matter, quote labels that contain punctuation, and still explain in words.",
  ].join("\n");
}

function promptFor(text: string, anchor: Anchor | null, quote?: Quote[]): string {
  if (quote?.length) {
    const said = quote.map((q) => `@${q.author} wrote:\n${q.body.replace(/^/gm, "> ")}`).join("\n\n");
    text = `${quote.length === 1 ? "A reviewer left this comment" : "Reviewers left these comments"} on GitHub:\n\n${said}\n\n${text}`;
  }
  if (!anchor) return text;
  const lines = anchor.start === anchor.end ? `line ${anchor.start}` : `lines ${anchor.start}-${anchor.end}`;
  const side = anchor.side === "old" ? " (old version, before the change)" : "";
  // An outdated GitHub comment points at code that has changed since, so there's no snippet to show.
  if (!anchor.snippet) return `About ${anchor.file} ${lines}${side} in an earlier version of the change (that code has changed since):\n\n${text}`;
  return `About ${anchor.file} ${lines}${side}:\n\`\`\`\n${anchor.snippet}\n\`\`\`\n\n${text}`;
}

export interface SendInput {
  text: string;
  anchor: Anchor | null;
  replyTo?: string;
  /** Continue this thread (the id of its first question). */
  thread?: string;
  /** GitHub comments the question is about. */
  quote?: Quote[];
  /** Agent id; defaults to the current agent. */
  agent?: string;
}

/** Record the user's question and answer it, after any answer already running. Returns the user message. */
export function send(t: PreparedTarget, input: SendInput): ChatMessage {
  if (cleanupPaths.has(path.resolve(t.worktree))) throw Object.assign(new Error('Worktree cleanup is in progress. Retry shortly.'), { status: 409 });
  const id = t.info.id;
  const chat: ChatFile = loadChat(id) ?? {
    targetId: id, title: t.info.title, updatedAt: Date.now(), sessions: {}, messages: [],
  };
  chat.title = t.info.title;
  if (t.info.prState) chat.prState = t.info.prState;

  // A reply in a thread inherits the lines the thread is about.
  const root = input.thread ? chat.messages.find((m) => m.id === input.thread) : undefined;
  if (input.thread && !root) throw Object.assign(new Error("That thread was deleted."), { status: 404 });
  const parent = input.replyTo ? chat.messages.find((m) => m.id === input.replyTo) : undefined;
  const anchor = root?.anchor ?? input.anchor ?? parent?.anchor ?? null;

  const userId = randomUUID();
  const user: ChatMessage = {
    id: userId, role: "user", anchor, text: input.text.trim(), ts: Date.now(),
    thread: root?.id ?? userId,
    ...(input.quote?.length ? { quote: input.quote.slice(0, 20).map((q) => ({ author: String(q.author).slice(0, 100), body: String(q.body).slice(0, 8000), ...(q.url ? { url: String(q.url) } : {}) })) } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
  chat.messages.push(user);
  saveChat(chat);
  emit(id, { type: "user", msg: user });

  const q = queues.get(id) ?? [];
  q.push({ user, t, agent: input.agent });
  queues.set(id, q);
  if (!runs.has(id)) next(id);
  return user;
}

function next(id: string) {
  const job = queues.get(id)?.shift();
  if (!job) {
    queues.delete(id);
    return;
  }
  answer(job.t, job.user, job.agent);
}

function answer(t: PreparedTarget, user: ChatMessage, agentId?: string) {
  const id = t.info.id;
  const agent = getAgent(agentId);
  const chat = loadChat(id);
  if (!chat || !chat.messages.some((m) => m.id === user.id)) return next(id);
  const anchor = user.anchor;

  // Everything said so far, for agents without a session to resume.
  const waiting = new Set(queuedFor(id));
  const history: Turn[] = chat.messages
    .filter((m) => m.id !== user.id && !waiting.has(m.id) && m.text && !m.error)
    .map((m) => ({ role: m.role, text: m.role === "user" ? promptFor(m.text, m.anchor, m.quote) : m.text }));

  const msg: ChatMessage = {
    id: randomUUID(), role: "assistant", anchor, text: "", ts: Date.now(), replyTo: user.id, thread: user.thread, tools: [], agent: agent.name,
  };
  const abort = new AbortController();
  runs.set(id, { msg, abort, worktree: t.worktree });
  emit(id, { type: "start", msg });

  const prev = chat.sessions?.[agent.id];
  // Older OpenCode sessions could be rooted in Gantry's launch directory via
  // inherited PWD. Start a correctly scoped session once, carrying chat history
  // into it, rather than continuing to deny access to the actual PR checkout.
  let sessionId = scopedSessionId(agent.kind, prev?.id, prev?.directory, t.worktree);
  let totalCost: number | null = null;
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);

  drivers[agent.kind]({
    agent,
    cwd: t.worktree,
    system: systemPrompt(t),
    prompt: promptFor(user.text, anchor, user.quote),
    sessionId,
    sessionDirectory: prev?.directory,
    history,
    signal: abort.signal,
    hooks: {
      text(text) {
        msg.text += text;
        emit(id, { type: "delta", id: msg.id, text });
      },
      tool(tool: ToolUse) {
        msg.tools!.push(tool);
        emit(id, { type: "tool", id: msg.id, tool });
      },
      session(s) {
        sessionId = s;
      },
      cost(total) {
        totalCost = total;
      },
      error(message) {
        msg.error ??= message;
      },
    },
  })
    .catch((e: Error) => {
      msg.error ??= e.message;
    })
    .finally(() => {
      clearTimeout(timer);
      msg.ts = Date.now();
      const latest = loadChat(id) ?? chat;
      const sessions = (latest.sessions ??= {});
      const before = sessions[agent.id];
      const entry = { id: sessionId, costUsd: sessionId === before?.id ? before?.costUsd : undefined, directory: t.worktree };
      if (totalCost !== null) {
        const spent = sessionId === before?.id ? (before?.costUsd ?? 0) : 0;
        msg.costUsd = Math.max(0, totalCost - spent);
        entry.costUsd = totalCost;
      }
      if (agent.kind !== "openai") sessions[agent.id] = entry;
      // Only keep the answer if its question wasn't deleted mid-run.
      if (latest.messages.some((m) => m.id === user.id)) latest.messages.push(msg);
      saveChat(latest);
      runs.delete(id);
      emit(id, { type: "done", msg });
      next(id);
    });
}
