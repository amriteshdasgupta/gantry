# Agent adapters

Gantry starts coding agents in the background, parses their session ids from streamed output, and lets you take over the session when you want the keyboard back. Agent-specific behaviour is isolated in one interface so adding an agent touches no core code.

## Capabilities model

Every adapter reports a serializable `AgentCapabilities` object (`packages/shared/src/agent.ts`) that the dashboard renders directly:

| Field | Values | Meaning |
| ----- | ------ | ------- |
| `resumeMode` | `deeplink` \| `terminal` \| `unsupported` | How a session is reopened: a native deep link, an attached terminal command, or not at all. |
| `takeover` | boolean | Can Gantry interrupt a background run mid-turn? |
| `interruptMode` | `process-group` \| `process` \| `unsupported` | How the interrupt is delivered. Gantry always uses the process group. |
| `deepLinkScheme` | string or null | e.g. `codex://threads`. |
| `streaming` | boolean | Structured session events stream to the run log. |
| `discoveredVia` | string or null | How the binary was found: `config`, `PATH`, or a well-known install path. |
| `notes` | string[] | Plain-language explanation shown in the UI. |

The rule: **what an adapter cannot do is reported as such, not approximated.** `unavailableCapabilities` produces the honest "not available" object with an explanatory note.

## The adapter contract

`packages/server/src/agents/types.ts`:

```ts
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  readonly promptNotes: string;              // appended to every startup prompt
  resolveBinary(override?: string): Promise<{ path: string | null; via: string | null }>;
  capabilities(binaryPath: string | null): Promise<AgentCapabilities>;
  buildStart(context: AgentStartContext): SpawnSpec;
  buildResume(sessionId: string, context: AgentStartContext): SpawnSpec | null;
  deepLink(sessionId: string): string | null;
  parseSessionLine(line: string): string | null;
}
```

`SpawnSpec` is `{ argv, cwd, claim }`. The claim is the command text `ps` will show once the child has exec'd, and is stored alongside `pid`/`pgid` so takeover can verify ownership before signalling.

## Built-in adapters

### `codex` — Codex CLI

- **Start:** `codex exec --json --skip-git-repo-check --approve-for-me -C <workspace> [--add-dir <path>…] <prompt>`
- **Session id:** parsed from streamed JSON events (`thread_id`, `threadId`, `thread.id`, `session_id`, `sessionId`)
- **Resume:** deep link `codex://threads/<id>`; background resume uses `codex exec resume <id>`
- **Takeover:** yes — interrupt the process group, then open the same thread in the Codex app
- **Streaming:** yes

Binary discovery order:

1. `agents.codex.binary` in `gantry.yaml`
2. `GANTRY_CODEX_BINARY`
3. The binary bundled with the ChatGPT desktop app (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`)
4. `codex` on `PATH`

Extra keys from `agents[].args` are appended as `--key value`.

### `claude` — Claude Code

- **Start:** `claude -p <prompt> --output-format stream-json --verbose --permission-mode <acceptEdits|…> [--add-dir <path>…]`
- **Session id:** parsed from streamed JSON events (`session_id` / `sessionId`)
- **Resume:** terminal — `claude --resume <id>`; there is no native app deep link, so "Open session" attaches a terminal
- **Takeover:** yes — the background run is interrupted in the shared session, then the terminal is opened
- **Streaming:** yes

The permission mode can be overridden per project with `agents[].args.permissionMode`. Discovery is `agents.claude.binary`, then `claude` on `PATH`. `promptNotes` adds "Work autonomously toward the ticket goal; avoid interactive questions." so background runs do not stall on a prompt nobody is watching.

### `opencode` — OpenCode

- **Start:** `opencode run <prompt>`
- **Session id:** best-effort regex on run output (`ses_…`)
- **Resume:** terminal — `opencode --session <id> run "Continue the previous task."`
- **Takeover:** yes, process-group
- **Streaming:** no

This adapter is explicitly best-effort: if OpenCode does not print a session id, Gantry reports that there is nothing to resume rather than guessing.

### `generic` — any command

Configured through `agents[].args.command`, a template in which `${prompt}` and `${workspace}` are substituted. An explicit command is required. Arguments support single and double quotes and backslash escapes; substitution happens after parsing so prompts remain literal argument values. Commands run directly without shell expansion, pipes, or redirection.

```yaml
agents:
  - id: generic
    binary: /path/to/launcher
    args:
      command: my-agent --cwd ${workspace} --task ${prompt}
```

The generic adapter has no session concept, and it says so: `resumeMode: unsupported`, no `deepLinkScheme`, no session parsing. `takeover` and `interruptMode: process-group` are supported without a session ID, because stopping the verified process group works regardless.

## How takeover works

1. The run row holds `(pid, pgid, pid_claim, session_id)`.
2. `takeover` refuses if no session id has been reported yet — interrupting an agent that has not started its turn is not useful.
3. `ownsProcess(pid, pgid, claim)` re-reads `ps -p <pid> -o pgid=,command=`. If it does not match, the run is marked `failed` and **nothing is signalled**.
4. `interruptProcessGroup` sends SIGTERM to the group, waits up to the grace period (default 4 s, `GANTRY_TAKEOVER_GRACE_MS`), re-verifies, then escalates to SIGKILL.
5. The run state moves to `interrupting` while signalling and `ready` once the session is free; the watcher finalizes it. The session stays usable via resume or deep link.
6. The response returns the session id and, when supported, the deep link.

Startup recovery re-verifies recorded runs the same way, so a Gantry restart never orphans or double-signals an agent.

## Environment passed to an agent

Runs are spawned detached with a minimal environment: your inherited environment plus `GANTRY_RUN_ID` and `GANTRY_TICKET_ID`. The worktrees and the ticket's artifact directory are passed as additional directories through the adapter's `addDirs`, and the prompt names them explicitly. Git invocations elsewhere in Gantry always run with `GIT_TERMINAL_PROMPT=0` and batch-mode SSH, so nothing ever waits on a credential prompt.

## Adding a new adapter

1. Create a class implementing `AgentAdapter` in `packages/server/src/agents/` (a new file, or alongside the built-ins in `adapters.ts`).

   ```ts
   export class MyAgentAdapter implements AgentAdapter {
     readonly id = 'myagent';
     readonly label = 'My Agent';
     readonly promptNotes = '';

     async resolveBinary(override?: string) {
       if (override) return { path: override, via: 'config' };
       return { path: await whichMyAgent(), via: 'PATH' };
     }

     async capabilities(binaryPath: string | null) {
       if (!binaryPath) return unavailableCapabilities(this.id, this.label, ['Install My Agent, or set agents.myagent.binary.']);
       return {
         id: this.id, label: this.label, available: true, discoveredVia: binaryPath,
         version: null, resumeMode: 'terminal', takeover: true, interruptMode: 'process-group',
         deepLinkScheme: null, streaming: false,
         notes: ['Session ids are parsed from run output when My Agent prints them.'],
       };
     }

     buildStart(context: AgentStartContext) {
       return { argv: [context.binary, 'run', context.prompt], cwd: context.workspace, claim: 'myagent run' };
     }

     buildResume(sessionId: string, context: AgentStartContext) {
       return { argv: [context.binary, '--resume', sessionId], cwd: context.workspace, claim: 'myagent --resume' };
     }

     deepLink() { return null; }
     parseSessionLine(line: string) { return /session (\S+)/.exec(line)?.[1] ?? null; }
   }
   ```

2. Register it in the `AgentRegistry` constructor (`packages/server/src/agents/registry.ts`):

   ```ts
   for (const adapter of [new CodexAdapter(), new ClaudeCodeAdapter(), new OpenCodeAdapter(), new GenericAdapter(), new MyAgentAdapter()]) {
     this.adapters.set(adapter.id, adapter);
   }
   ```

3. Add the id to the adapter tests in `tests/adapters.test.ts`.

That is the whole change — no ticket, preview, prompt or HTTP modifications. To make it the project default, set `project.defaultAgent: myagent` and add an `agents[]` entry to `gantry.yaml`.

Two things to get right:

- **`claim` must be the post-exec command line.** It is the string matched against `ps` output; if it does not match, takeover will correctly refuse to signal.
- **Report capabilities honestly.** If your agent cannot be resumed, return `resumeMode: 'unsupported'` and a note explaining why. The UI shows the note; nobody has to discover the limitation by trying.

## Unified desktop chat

The desktop app uses one provider registry, configured in Settings, for new ticket conversations and PR review. It does not use the standalone runtime's per-project `defaultAgent` for this choice. A ticket retains its original provider and session when the default changes.

Open chat prepares coordinated worktrees and opens a saved conversation in herdr, which is required: Claude Code, OpenCode or Codex. Each ticket gets its own herdr space with a **Master** tab. Opening a workflow stage chat creates a separate tab named after the stage in that same space; reopening a session reuses its tab. Stage chats remain paused during interactive use to avoid two agents writing to the same session. Spaces and tabs are created on demand on both macOS and Linux. A stage opened before the master chat reserves the Master tab for later. When a ticket is Done, its space closes once no agent is working or waiting for input. Older shared-workspace chats migrate when reopened after their agents exit. Codex and OpenCode conversations are created with the ticket context already in them (Codex through its app server, OpenCode through a short-lived `opencode serve`), so no model turn runs before you see the chat. API-only providers support PR review and workflow stages but have no interactive chat. Conversations receive ticket notes, checkout paths, and workspace instructions without starting an agent turn. Ask the external agent to implement the feature and create or update draft PRs; Gantry discovers PRs by branch. Session associations remain local under `~/.pr-lens/ticket-conversations`.

### Correcting a graph from PR review

If a correction reaches a stage's automatic attempt limit (three by default), the workflow waits and shows **Allow 1 more attempt**, **Allow 3 more attempts**, and **Allow 5 more attempts** directly in the execution panel. Choose one to increase that stage's limit for this ticket and continue along the blocked correction route. An optional reply accompanies the choice. This preserves prior attempts and review feedback; it does not change the workspace template or disable future limits.

In a ticket's PR review, click **Review loop**, choose a stage in the saved execution graph, optionally add instructions, and click **Restart with review feedback**. The selected stage and its downstream stages reopen, preserving earlier attempts, PR links, worktrees, and provider settings. Close interactive ticket/stage chats and pause any running workflow before restarting. The ticket must be In progress and must already have a workflow execution. If the graph changes while the dialog is open, use **Reload graph** before confirming.

Gantry refreshes GitHub file threads (including outdated locations), general comments, and review bodies once when you restart. A failed refresh leaves the workflow untouched and shows an error to retry. It also captures the PR's local review discussion and your optional note. The latest three bounded snapshots persist with the execution and are supplied to subsequent stages and graph routing as external review data; oversized bodies and older entries can be omitted. Opening or reloading the picker reads local execution state without polling GitHub. A PR associated with multiple active tickets must be opened in the intended ticket's review space.

The desktop's local `GET /api/review-loop?targetId=owner/repo/pull/42&spaceId=...` resolves that association and returns its execution. `POST /api/review-loop` accepts `targetId`, optional `spaceId`, `nodeId`, optional `message` (up to 4,000 characters), `expectedUpdatedAt`, and `confirm: true`. The server resolves the ticket itself, checks the execution revision and active writers, captures feedback, then queues the correction under the existing execution lock.
