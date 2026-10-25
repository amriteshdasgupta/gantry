"use client";

import { useEffect, useState } from "react";
import { BackToTickets } from "@/components/gantry/link";
import { CheckIcon, Loader2Icon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/theme-toggle";
import { AgentIcon } from "@/components/agents/agent-icon";
import { api, type TerminalLauncher } from "@/lib/client/api";
import { agentsStore, chooseAgent, useAgents } from "@/lib/client/agents";
import type { Agent, AgentKind, AgentStatus } from "@/lib/types";

const KINDS: { kind: AgentKind; label: string; blurb: string }[] = [
  { kind: "claude", label: "Claude", blurb: "Claude Code CLI, signed in on this computer" },
  { kind: "codex", label: "Codex", blurb: "OpenAI Codex CLI, signed in on this computer" },
  { kind: "opencode", label: "OpenCode", blurb: "OpenCode CLI, with a provider set up (opencode auth login)" },
  { kind: "openai", label: "Own provider", blurb: "Any OpenAI-compatible API: OpenAI, OpenRouter, Ollama, LM Studio…" },
];

const MODEL_HINT: Record<AgentKind, string> = {
  claude: "Default, or e.g. opus, sonnet",
  codex: "Default, or e.g. gpt-5-codex",
  opencode: "Default, or provider/model, e.g. anthropic/claude-sonnet-4-5",
  openai: "e.g. gpt-5, anthropic/claude-sonnet-4.5, llama3.1",
};

const PRESETS = [
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { name: "Ollama", url: "http://localhost:11434/v1" },
  { name: "LM Studio", url: "http://localhost:1234/v1" },
];

/** null: closed; a kind: adding one; an Agent: editing it. */
type Editing = null | { kind: AgentKind } | Agent;

export function Settings() {
  const data = useAgents();
  const [editing, setEditing] = useState<Editing>(null);
  const [tested, setTested] = useState<Record<string, AgentStatus | "busy">>({});

  async function test(id: string) {
    setTested((t) => ({ ...t, [id]: "busy" }));
    const status = await api.testAgent(id).catch((e: Error) => ({ ok: false, detail: e.message }));
    setTested((t) => ({ ...t, [id]: status }));
  }

  async function remove(a: Agent) {
    try {
      agentsStore.set(await api.removeAgent(a.id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="app-bar flex h-12 items-center gap-3 border-b px-4">
        <BackToTickets />
        <span className="text-sm text-muted-foreground">Settings</span>
        <span className="flex-1" />
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <section className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Choose the provider for new ticket conversations and PR reviews. Tickets open in Codex or Claude Code,
            and keep their saved conversation when you change the default. API providers are available for PR reviews.
          </p>
        </section>

        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <Button key={k.kind} variant="outline" onClick={() => setEditing({ kind: k.kind })} title={k.blurb}>
              <PlusIcon /> {k.label}
            </Button>
          ))}
        </div>

        {editing && !("id" in editing) && (
          <AgentForm kind={editing.kind} onDone={() => setEditing(null)} />
        )}

        {!data && <Skeleton className="h-20" />}
        <div className="flex flex-col gap-2">
          {data?.agents.map((a) => {
            const current = a.id === data.current;
            const t = tested[a.id];
            const status = t && t !== "busy" ? t : a.status;
            if (editing && "id" in editing && editing.id === a.id) {
              return <AgentForm key={a.id} kind={a.kind} agent={a} onDone={() => setEditing(null)} />;
            }
            return (
              <div key={a.id} className={cn("flex items-center gap-3 rounded-lg border p-3", current && "border-foreground/30 bg-muted/40")}>
                <AgentIcon kind={a.kind} className="size-8 [&_svg]:size-4" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    {current && <Badge variant="secondary">In use</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {KINDS.find((k) => k.kind === a.kind)?.label}
                    {a.model ? ` · ${a.model}` : " · default model"}
                    {a.kind === "openai" && a.baseUrl ? ` · ${a.baseUrl}` : ""}
                  </div>
                  <div className={cn("mt-0.5 flex items-center gap-1.5 text-xs", status.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                    <span className={cn("size-1.5 rounded-full", status.ok ? "bg-emerald-500" : "bg-destructive")} />
                    <span className="truncate">{status.detail}</span>
                  </div>
                </div>
                {!current && (
                  <Button size="sm" variant="outline" onClick={() => chooseAgent(a.id).catch((e: Error) => toast.error(e.message))}>
                    <CheckIcon /> Use
                  </Button>
                )}
                <Button size="icon-sm" variant="ghost" onClick={() => test(a.id)} aria-label={`Test ${a.name}`}>
                  {t === "busy" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}>
                  <PencilIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => remove(a)} disabled={data.agents.length <= 1} aria-label={`Remove ${a.name}`}>
                  <Trash2Icon />
                </Button>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          Agents can edit files in the local review checkout when you ask for changes. Claude and Codex do not load your settings, hooks or MCP servers.
          Own providers get file reading and editing, search, and git inspection tools confined to the checkout. See edits in Local changes, then use Commit and push to publish them to the PR.
          API keys are stored in ~/.pr-lens/agents.json, readable only by you.
        </p>

        <ChatLauncher />
      </main>
    </div>
  );
}

/** Where ticket, master and stage chats open. */
function ChatLauncher() {
  const [settings, setSettings] = useState<TerminalLauncher | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.terminalLauncher().then(setSettings, (e: Error) => toast.error(e.message)); }, []);
  if (!settings) return <Skeleton className="h-20" />;

  async function save() {
    setSaving(true);
    try {
      setSettings(await api.saveTerminalLauncher(settings!));
      toast.success("herdr settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 border-t pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Chats open in herdr</h2>
        <p className="text-sm text-muted-foreground">
          Every ticket gets its own herdr space, with a Master chat tab and a separate tab for each stage chat you open.
          The space closes once the ticket is Done and no agent in it is working or waiting for you. The terminal app shows herdr&apos;s window when none is open.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Show herdr in</span>
        {settings.available.map((t) => (
          <Button key={t.id} size="sm" variant={settings.terminalApp === t.id ? "secondary" : "ghost"} onClick={() => setSettings({ ...settings, terminalApp: t.id })}>
            {t.label}
          </Button>
        ))}
        {!settings.available.length && <span className="text-xs text-muted-foreground">No supported terminal app found.</span>}
      </div>
      <Field label="herdr binary">
        <Input value={settings.herdrPath} onChange={(e) => setSettings({ ...settings, herdrPath: e.target.value })} />
      </Field>
      <div>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2Icon className="animate-spin" />} Save
        </Button>
      </div>
    </section>
  );
}

function AgentForm({ kind, agent, onDone }: { kind: AgentKind; agent?: Agent; onDone: () => void }) {
  const label = KINDS.find((k) => k.kind === kind)!.label;
  const [name, setName] = useState(agent?.name ?? (kind === "openai" ? "" : label));
  const [model, setModel] = useState(agent?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(agent?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { kind, name, model, ...(kind === "openai" ? { baseUrl, ...(apiKey ? { apiKey } : {}) } : {}) };
      if (agent) agentsStore.set(await api.updateAgent(agent.id, input));
      else {
        await api.addAgent(input);
        agentsStore.set(await api.agents());
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4" aria-label={agent ? `Edit ${agent.name}` : `Add ${label}`}>
      <div className="flex items-center gap-2 font-medium">
        <AgentIcon kind={kind} />
        {agent ? `Edit ${agent.name}` : `Add ${label}`}
      </div>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "openai" ? "e.g. OpenRouter GPT-5" : label} autoFocus />
      </Field>
      {kind === "openai" && (
        <>
          <Field label="Base URL">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="font-mono" />
            <div className="flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => {
                    setBaseUrl(p.url);
                    if (!name) setName(p.name);
                  }}
                  className="rounded-md border bg-background px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </Field>
          <Field label="API key">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={agent?.hasKey ? "Saved. Type a new one to replace it" : "Leave empty for local servers like Ollama"}
              autoComplete="off"
            />
          </Field>
        </>
      )}
      <Field label="Model">
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={MODEL_HINT[kind]} className="font-mono" />
      </Field>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />} {agent ? "Save" : "Add and use"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
