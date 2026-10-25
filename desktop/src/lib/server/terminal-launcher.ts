import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { HOME, withLock } from "./exec";
import { httpError } from "./http";
import { sessionOpenInTerminal } from "./stage-sessions";

/**
 * Every interactive chat (a ticket's chat, its master chat, a stage's chat) opens in herdr:
 * one herdr workspace per Gantry workspace, one tab per ticket, one pane per conversation.
 * Herdr is required. The terminal app setting only says which app shows herdr's window.
 */
const exec = promisify(execFile);
const SETTINGS = path.join(HOME, "terminal-launcher.json");
const STATE = path.join(HOME, "terminal-launcher-state.json");
const SCRIPTS = path.join(HOME, "launch-scripts");
export const DEFAULT_HERDR = process.env.PR_LENS_HERDR || path.join(os.homedir(), ".local", "bin", "herdr");
const GHOSTTY = process.env.PR_LENS_GHOSTTY || "/Applications/Ghostty.app";

export interface LauncherSettings {
  /** The id of the terminal app that shows herdr's window when none is open. */
  terminalApp: string;
  herdrPath: string;
}
/** Where one conversation should open: its Gantry workspace, its ticket, and the command that starts the chat. */
export interface LaunchTarget {
  workspace: { id: string; name: string; path: string };
  ticket: { id: string; title: string };
  sessionId: string;
  cwd: string;
  command: string;
  /** Typed into the chat once its agent is up, for CLIs that cannot take an opening message as an argument. */
  typeMessage?: string;
}
interface HerdrTicket { workspaceId: string; tabId: string; panes: Record<string, string> }
interface State {
  herdr: { spaces: Record<string, { workspaceId: string; homeTabId: string }>; tickets: Record<string, HerdrTicket> };
}

/** A terminal app that can show herdr's window: whether it is installed, and how to open a window running a program. */
interface Terminal { id: string; label: string; installed: () => boolean; open: (program: string, cwd: string) => Promise<void> }

const onPath = (bin: string) => (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin)));
/** A terminal started as `bin ...args(program)`, which returns once the process has started. */
const cli = (id: string, label: string, bin: string, args: (program: string) => string[]): Terminal => ({
  id, label, installed: () => onPath(bin),
  open: (program, cwd) => new Promise((resolve, reject) => {
    const child = spawn(bin, args(program), { cwd, detached: true, stdio: "ignore" });
    child.once("error", reject).once("spawn", () => { child.unref(); resolve(); });
  }),
});
/** A macOS app driven by AppleScript, which gets the program and its directory as data, never as script text. */
const appleScript = (id: string, label: string, installed: () => boolean, script: string): Terminal => ({
  id, label, installed,
  open: async (program, cwd) => void await exec("osascript", ["-e", script, quote(program), cwd], { timeout: 15000 }),
});

const TERMINALS: Partial<Record<NodeJS.Platform, Terminal[]>> = {
  darwin: [
    appleScript("ghostty", "Ghostty", () => fs.existsSync(GHOSTTY), `on run argv
      tell application "Ghostty"
        set cfg to new surface configuration
        set command of cfg to item 1 of argv
        set initial working directory of cfg to item 2 of argv
        new window with configuration cfg
        activate
      end tell
    end run`),
    appleScript("terminal", "Terminal", () => true, `on run argv
      tell application "Terminal"
        do script item 1 of argv
        activate
      end tell
    end run`),
  ],
  linux: [
    cli("ghostty", "Ghostty", "ghostty", (p) => ["-e", p]),
    cli("kitty", "kitty", "kitty", (p) => [p]),
    cli("alacritty", "Alacritty", "alacritty", (p) => ["-e", p]),
    cli("wezterm", "WezTerm", "wezterm", (p) => ["start", "--", p]),
    cli("gnome-terminal", "GNOME Terminal", "gnome-terminal", (p) => ["--", p]),
    cli("konsole", "Konsole", "konsole", (p) => ["-e", p]),
    cli("xfce4-terminal", "Xfce Terminal", "xfce4-terminal", (p) => ["-x", p]),
    cli("xterm", "xterm", "xterm", (p) => ["-e", p]),
  ],
};
/** The terminal apps installed on this machine, in order of preference. */
export const installedTerminals = () => (TERMINALS[process.platform] ?? []).filter((t) => t.installed());

export function launcherSettings(): LauncherSettings & { available: { id: string; label: string }[] } {
  const installed = installedTerminals();
  const available = installed.map(({ id, label }) => ({ id, label }));
  let saved: Partial<LauncherSettings> = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { /* defaults */ }
  // A saved app that has since been uninstalled falls back to the first one installed.
  const terminalApp = installed.some((t) => t.id === saved.terminalApp) ? saved.terminalApp! : installed[0]?.id ?? "";
  return { terminalApp, herdrPath: saved.herdrPath || DEFAULT_HERDR, available };
}
export function saveLauncherSettings(input: Partial<LauncherSettings>) {
  const { available, ...current } = launcherSettings();
  const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as LauncherSettings;
  if (!available.some((t) => t.id === next.terminalApp)) throw httpError(400, "Choose a terminal app installed on this computer.");
  next.herdrPath = String(next.herdrPath || DEFAULT_HERDR).trim();
  if (!path.isAbsolute(next.herdrPath)) throw httpError(400, "Give herdr's full path, like ~/.local/bin/herdr expanded.");
  fs.writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(next, null, 1), { mode: 0o600 });
  fs.renameSync(`${SETTINGS}.tmp`, SETTINGS);
  return launcherSettings();
}

/** Whether herdr runs at the configured path, with its version for the setup check. */
export async function herdrStatus(): Promise<{ ok: boolean; detail: string }> {
  const bin = launcherSettings().herdrPath;
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 8000 });
    return { ok: true, detail: stdout.trim().split("\n")[0] || "Installed" };
  } catch {
    return { ok: false, detail: `herdr isn't installed at ${bin}. Install it from https://herdr.dev, or set its path in Settings.` };
  }
}

function loadState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, "utf8")) as Partial<State>;
    return { herdr: { spaces: s.herdr?.spaces ?? {}, tickets: s.herdr?.tickets ?? {} } };
  } catch { return { herdr: { spaces: {}, tickets: {} } }; }
}
function saveState(state: State) {
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(`${STATE}.tmp`, STATE);
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A private one-shot script, so long prompts are not typed into the terminal. It deletes itself as it starts. */
function launchScript(target: LaunchTarget) {
  fs.mkdirSync(SCRIPTS, { recursive: true, mode: 0o700 });
  const file = path.join(SCRIPTS, `${target.sessionId}.sh`);
  fs.writeFileSync(file, `rm -f "$0"\n${target.command}\n`, { mode: 0o600 });
  return `sh ${quote(file)}`;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function herdr(bin: string, ...args: string[]): Promise<Json> {
  const { stdout } = await exec(bin, args, { timeout: 15000 });
  // Some commands, like pane run, print nothing when they succeed.
  return stdout.trim() ? JSON.parse(stdout).result as Json : {};
}
const exists = (bin: string, kind: "workspace" | "tab" | "pane", id: string) => herdr(bin, kind, "get", id).then(() => true, () => false);

/** The app windows of attached herdr clients, found from each client's parent processes. Empty when no herdr window is open. */
async function herdrHosts() {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,comm="], { timeout: 5000 });
  const procs = new Map(stdout.trim().split("\n").map((line) => {
    const [, pid, ppid, comm] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? [];
    return [Number(pid), { ppid: Number(ppid), comm: comm ?? "" }] as const;
  }));
  const servers = new Set((await exec("pgrep", ["-f", "herdr server"]).then((r) => r.stdout, () => "")).trim().split("\n").map(Number));
  const hosts: string[] = [];
  for (const [pid, p] of procs) {
    if (path.basename(p.comm) !== "herdr" || servers.has(pid)) continue;
    if (process.platform !== "darwin") { hosts.push("herdr"); continue; }
    for (let at = p.ppid, hops = 0; at > 1 && hops < 20; at = procs.get(at)?.ppid ?? 0, hops++) {
      const app = procs.get(at)?.comm.match(/^(.*?\.app)\/Contents\/MacOS\//)?.[1];
      if (app) { hosts.push(app); break; }
    }
  }
  return hosts;
}

/** Brings the herdr window to the front, or opens one in the chosen terminal app when none is attached. */
async function showHerdr(settings: LauncherSettings) {
  const [host] = await herdrHosts();
  if (host) {
    // ponytail: no portable way to raise another app's window off macOS, so an attached client is left as is.
    if (process.platform === "darwin") await exec("open", ["-a", host], { timeout: 5000 });
    return;
  }
  const terminal = installedTerminals().find((t) => t.id === settings.terminalApp);
  if (!terminal) throw new Error("No terminal app found. Install one, then choose it in Settings.");
  await terminal.open(settings.herdrPath, os.homedir());
  // Wait for the client to attach so the next chat does not open a second herdr window.
  for (let i = 0; i < 20 && !(await herdrHosts()).length; i++) await new Promise((r) => setTimeout(r, 250));
}

/** Types the opening message once herdr sees the agent running in the pane. */
async function typeWhenReady(bin: string, pane: string, message: string) {
  for (let i = 0; i < 60; i++) {
    const live = await herdr(bin, "pane", "get", pane).then((r) => r.pane as Json, () => null);
    if (live?.agent) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // The agent's input box draws just after the agent reports itself.
  await new Promise((r) => setTimeout(r, 1500));
  await herdr(bin, "pane", "send-text", pane, message);
  await herdr(bin, "pane", "send-keys", pane, "enter");
}

async function openInHerdr(settings: LauncherSettings, target: LaunchTarget) {
  const bin = settings.herdrPath;
  const state = loadState();
  let space = state.herdr.spaces[target.workspace.id];
  if (!space || !(await exists(bin, "workspace", space.workspaceId))) {
    // herdr closes a workspace with its last tab, so its first tab stays as the workspace's home.
    const made = await herdr(bin, "workspace", "create", "--cwd", target.workspace.path, "--label", target.workspace.name, "--no-focus");
    space = { workspaceId: made.workspace.workspace_id, homeTabId: made.tab.tab_id };
    await herdr(bin, "tab", "rename", space.homeTabId, "Gantry");
    state.herdr.spaces[target.workspace.id] = space;
  }
  let ticket: HerdrTicket | undefined = state.herdr.tickets[target.ticket.id];
  if (ticket && (ticket.workspaceId !== space.workspaceId || !(await exists(bin, "tab", ticket.tabId)))) ticket = undefined;
  let pane = ticket?.panes[target.sessionId];
  let run = true;
  let live = pane ? await herdr(bin, "pane", "get", pane).then((r) => r.pane as Json, () => null) : null;
  if (ticket && live?.tab_id !== ticket.tabId) {
    // herdr records each agent pane's session, so a chat is found even when its pane id was forgotten.
    const panes = (await herdr(bin, "pane", "list", "--workspace", ticket.workspaceId)).panes as Json[];
    live = panes.find((p) => p.tab_id === ticket!.tabId && p.agent_session?.value === target.sessionId) ?? null;
    if (live) pane = live.pane_id as string;
  }
  if (live && live.tab_id === ticket?.tabId) {
    // Reuse the chat's pane, and restart it only when its agent has exited.
    // herdr's agent field comes from hooks and can drop while the agent still runs, so check the process.
    run = !(await sessionOpenInTerminal(target.sessionId));
  } else if (!ticket) {
    const made = await herdr(bin, "tab", "create", "--workspace", space.workspaceId, "--cwd", target.cwd, "--label", target.ticket.title.slice(0, 60), "--no-focus");
    ticket = { workspaceId: space.workspaceId, tabId: made.tab.tab_id, panes: {} };
    pane = made.root_pane.pane_id as string;
  } else {
    // Split the tab's newest pane, alternating direction so panes stay usable.
    const panes = ((await herdr(bin, "pane", "list", "--workspace", ticket.workspaceId)).panes as Json[]).filter((p) => p.tab_id === ticket!.tabId);
    const made = await herdr(bin, "pane", "split", panes.at(-1)!.pane_id, "--direction", panes.length % 2 ? "right" : "down", "--cwd", target.cwd, "--no-focus");
    pane = made.pane.pane_id as string;
  }
  ticket!.panes[target.sessionId] = pane!;
  state.herdr.tickets[target.ticket.id] = ticket!;
  saveState(state);
  if (run) await herdr(bin, "pane", "run", pane!, launchScript(target));
  // The chat is running; failing to focus it or show herdr must not fail the open.
  await herdr(bin, "workspace", "focus", space.workspaceId).then(() => herdr(bin, "tab", "focus", ticket!.tabId)).catch(() => {});
  await showHerdr(settings).catch(() => {});
  if (run && target.typeMessage) await typeWhenReady(bin, pane!, target.typeMessage);
}

/** Closes a done ticket's tab once none of its panes has an agent working or waiting on the person. */
async function closeInHerdr(bin: string, state: State, ticketId: string) {
  const ticket = state.herdr.tickets[ticketId];
  if (await exists(bin, "tab", ticket.tabId)) {
    const panes = (await herdr(bin, "pane", "list", "--workspace", ticket.workspaceId)).panes as Json[];
    if (panes.some((p) => p.tab_id === ticket.tabId && p.agent && ["working", "blocked"].includes(p.agent_status))) return;
    await herdr(bin, "tab", "close", ticket.tabId);
  }
  delete state.herdr.tickets[ticketId];
}

// --- entry points -----------------------------------------------------------------------------

/** Opens the chat in herdr. Herdr is required, so a failure is reported rather than worked around. */
export async function openInHerdrChat(target: LaunchTarget): Promise<void> {
  const status = await herdrStatus();
  if (!status.ok) throw httpError(409, status.detail);
  const settings = launcherSettings();
  try {
    await withLock("terminal-launcher", () => openInHerdr(settings, target));
  } catch (error) {
    if ((error as { status?: number }).status) throw error;
    throw httpError(502, `herdr could not open the chat: ${(error as Error).message}`);
  }
}

/** Closes the tabs of tickets that are now Done. Called from the executor's tick with every ticket's status. */
export async function closeDoneTickets(statusOf: (ticketId: string) => string | undefined) {
  const state = loadState();
  if (!Object.keys(state.herdr.tickets).some((id) => statusOf(id) === "done")) return;
  await withLock("terminal-launcher", async () => {
    const fresh = loadState();
    const bin = launcherSettings().herdrPath;
    for (const id of Object.keys(fresh.herdr.tickets)) if (statusOf(id) === "done") await closeInHerdr(bin, fresh, id).catch(() => {});
    saveState(fresh);
  });
}
