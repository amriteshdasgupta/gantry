import type { LocalChanges, Agent, AgentInput, AgentsResponse, AgentStatus, Anchor, CommentsResponse, Quote, ChatMessage, FileResponse, PrListItem, RecentItem, Space, SpacesResponse, TargetResponse } from "@/lib/types";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** How chats open in herdr. Mirrors LauncherSettings on the server. */
export interface TerminalLauncher {
  terminalApp: string;
  herdrPath: string;
  /** The terminal apps installed on this computer. */
  available: { id: string; label: string }[];
}

export interface HomeData {
  review: PrListItem[];
  mine: PrListItem[];
  recent: RecentItem[];
  prError: string | null;
}

export const api = {
  merge: (id: string, head: string, method: string) => call<{ merged: boolean; warning: string | null }>("/api/merge", post({ id, head, method })),
  home: () => call<HomeData>("/api/home"),
  resolve: (url: string) => call<{ id: string; file: string | null }>("/api/resolve", post({ url })),
  target: (id: string, refresh = false) =>
    call<TargetResponse>(`/api/target?${q(refresh ? { id, refresh: "1" } : { id })}`),
  file: (id: string, path: string, mode: "diff" | "full", source = "pr") =>
    call<FileResponse>(`/api/file?${q({ id, path, mode, source })}`),
  editFile: (id: string, path: string) => call<{ text: string; revision: string }>(`/api/file-edit?${q({ id, path })}`),
  saveFile: (id: string, path: string, text: string, revision: string) => call<{ text: string; revision: string }>("/api/file-edit", post({ id, path, text, revision })),
  tree: (id: string, source = "pr") => call<string[]>(`/api/tree?${q({ id, source })}`),
  localChanges: (id: string) => call<LocalChanges>(`/api/local-changes?${q({ id })}`),
  publish: (id: string, snapshot: LocalChanges, message: string) => call<{commit:string;branch:string;warning?:string}>("/api/local-changes", post({id, tree:snapshot.tree, head:snapshot.head, message})),
  ask: (id: string, text: string, opts: { anchor?: Anchor | null; thread?: string; quote?: Quote[] } = {}) =>
    call<{ msg: ChatMessage }>("/api/chat", post({ id, text, anchor: opts.anchor ?? null, thread: opts.thread, quote: opts.quote })),
  comments: (id: string, refresh = false) => call<CommentsResponse>(`/api/comments?${q(refresh ? { id, refresh: "1" } : { id })}`),
  stop: (id: string) => call<{ stopped: boolean }>("/api/chat", post({ id, action: "stop" })),
  remove: (id: string, msg: string) => call<{ deleted: boolean }>(`/api/chat?${q({ id, msg })}`, { method: "DELETE" }),
  spaces: () => call<SpacesResponse>("/api/spaces"),
  createSpace: (name?: string) => call<Space>("/api/spaces", post({ name })),
  updateSpace: (id: string, patch: Partial<Pick<Space, "name" | "active" | "targets" | "color" | "emoji">> & { file?: { target: string; path: string }; makeCurrent?: boolean }) =>
    call<Space>("/api/spaces", { ...post({ id, ...patch }), method: "PATCH" }),
  deleteSpace: (id: string) => call<SpacesResponse>(`/api/spaces?${q({ id })}`, { method: "DELETE" }),
  agents: () => call<AgentsResponse>("/api/agents"),
  addAgent: (input: AgentInput) => call<Agent>("/api/agents", post(input)),
  updateAgent: (id: string, patch: Partial<AgentInput> & { current?: boolean }) =>
    call<AgentsResponse>("/api/agents", { ...post({ id, ...patch }), method: "PATCH" }),
  removeAgent: (id: string) => call<AgentsResponse>(`/api/agents?${q({ id })}`, { method: "DELETE" }),
  testAgent: (id: string) => call<AgentStatus>("/api/agents/test", post({ id })),
  terminalLauncher: () => call<TerminalLauncher>("/api/terminal-launcher"),
  saveTerminalLauncher: (settings: TerminalLauncher) => call<TerminalLauncher>("/api/terminal-launcher", post(settings)),
  addToSpace: (url: string, space?: string) =>
    call<{ space: Space; id: string; file: string | null }>("/api/spaces/add", post({ url, space })),
};

export const spaceHref = (space: string) => `/space/${encodeURIComponent(space)}`;

/** Short tab label for a target id, e.g. "bridge #2467" or "bridge @1a2b3c4". */
export function shortLabel(id: string): string {
  const [, repo, kind, ...rest] = id.split("/");
  const ref = rest.join("/");
  switch (kind) {
    case "pull": return `${repo} #${ref}`;
    case "commit": return `${repo} @${ref.slice(0, 7)}`;
    case "compare": return `${repo} ${ref}`;
    case "local": return `${repo} (local)`;
    case "doc": return `${repo[0].toUpperCase()}${repo.slice(1)} doc`;
    default: return `${repo} : ${ref}`;
  }
}

/** App path for a target id; ids mirror github.com paths. */
export const hrefFor = (id: string, file?: string | null) =>
  `/${id.split("/").map(encodeURIComponent).join("/")}${file ? `?${q({ file })}` : ""}`;

export function timeAgo(ts: number | string): string {
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
