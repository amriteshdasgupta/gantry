# Configuration reference

`gantry.yaml` sits at the root of a workspace — a directory that contains your repositories. Gantry re-reads it on every discovery pass, so edits apply without a restart. The authoritative definition is the Zod schema in `packages/shared/src/config/schema.ts`; this page documents every key, its default, and the interpolation rules.

Naming rules enforced by the schema: `apiVersion` must be exactly `gantry.dev/v1`, and every `id` (`project`, `repositories`, `services`, `environments`, `promptTemplates`, `scopes`, `agents`) must be lowercase kebab-case (`/^[a-z][a-z0-9-]*$/`). At least one repository is required.

Validation collects *all* problems and reports them together, then `validateConfigReferences` adds cross-reference checks:

- `services.<id>.repository` must name a declared repository
- `services.<id>.start` is required when `runtime` is `command`
- `services.<id>.dependsOn` entries must exist, and the dependency graph must be acyclic
- `services.<id>.banner.autoLogin` requires at least one environment
- `environments.<id>.envFiles` keys must be declared service ids

## Top level

### Starter graph

New configs created by **Add workspace** or `gantry init` include an automatic
**Plan → Implement → Review → Create PR** graph. Each stage includes instructions;
implementation runs relevant tests, review can route corrections back to
implementation, and the final stage commits, pushes, and creates or updates PRs.
The graph never merges or deploys. Stages inherit the selected provider and model
unless overridden in **Workspace graph**. Keep Gantry open to execute stages.

Existing custom graphs are preserved. Existing configs without `workflow` show
the starter layout with automation off until explicitly enabled. To install the
automatic graph manually, copy the `workflow` section from
[the starter graph example](../examples/starter-workflow.yaml).

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `apiVersion` | string | — (required) | Must be `gantry.dev/v1`. |
| `project` | object | — (required) | Project identity and defaults; see below. |
| `repositories` | array | — (required, min 1) | Repositories in this workspace. |
| `services` | array | `[]` | Preview services. |
| `environments` | array | `[]` | Named private-environment sets. |
| `promptTemplates` | array | `[]` | Project prompt templates. |
| `scopes` | array | `[]` | Deprecated legacy categories; accepted for compatibility, no longer offered as choices. |
| `agents` | array | `[]` | Per-agent overrides (`binary`, extra `args`). |
| `workflow` | object | Starter graph, automation off when omitted | Stage instructions, positions, connections, and automatic execution. New-workspace setup writes the automatic starter explicitly. |
| `workflowTemplates` | array | `[]` | Named alternative graphs (`id`, `name`, `graph`) available when creating tickets. |
| `safety` | object | see below | Validation policy rendered into prompts. |

Ticket scopes are the service IDs declared in `services` in `gantry.yaml`. The ticket form offers checkboxes and allows multiple selections; new tickets select all current services by default. Clear all selections for workspace-wide work. Workspaces with no services offer no scope choices.

Ticket create/update requests accept `scopes: string[]`. Unknown service IDs and malformed values are rejected; duplicate IDs are removed. Omitting `scopes` on an update preserves the selection. Explicit `[]` clears it. Selected services removed from YAML remain visible as unavailable and can be deselected; they do not prevent unrelated ticket edits. Scope describes the requested work; it does not limit worktree creation or preview dependencies.

Existing tickets retain their legacy `scope`; unrelated edits preserve it until the service selection changes. `both` resolves to all current services; a category matching a service ID or repository ID resolves to those services. Unmatched categories are displayed as legacy scopes and remain editable. Existing top-level `scopes` entries are accepted but do not add UI options. The API status exposes resolved `scopes` and `scopeDescription`, retaining `scope` for older clients.

## `project`

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `id` | string | — (required) | Lowercase kebab-case project id. |
| `name` | string | — (required) | Display name, 1-80 characters. |
| `defaultAgent` | string | `codex` | Adapter id used by "Start" in the UI. |
| `defaultPromptTemplate` | string | `builtin:default` | Template id, or `builtin:default` / `builtin:paper-setter-legacy`. |
| `branchPrefix` | string | `ticket` | Ticket branches become `<branchPrefix>/<slug>`. Must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. |
| `worktreeRoot` | string | `.worktrees` | Where ticket worktree groups are created, relative to the workspace. Must not contain `..`. |
| `portBase` | number | `5200` | First port tried when allocating preview ports. Range 1024-65000. |
| `portRange` | number | `1000` | Number of ports to walk from `portBase`. Minimum 16. |
| `workspaceInstructions` | string[] | `['AGENTS.md', 'CLAUDE.md']` | Instruction file names looked up at workspace level and listed in prompts. |

## `repositories[]`

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| `id` | string | — (required) | Lowercase kebab-case, referenced by services. |
| `path` | string | — (required) | Workspace-relative path (or absolute path inside the workspace). |
| `remote` | string | `origin` | Git remote used for fetches and PR ref lookups. |
| `defaultBranch` | string | `main` | Fallback base for new branches. |
| `worktree` | boolean | `true` | Create ticket worktrees for this repository. Set `false` for tooling repos (e.g. an E2E harness). |
| `required` | boolean | `true` | The project fails to load if a required repository is missing on disk; required repositories also fall back to their primary checkout when a branch group is one-sided. |
| `role` | `product` \| `tooling` | `product` | `product` repositories join branch previews and tickets; `tooling` ones are only mounted into tickets. |
| `instructions` | string[] | `['AGENTS.md', 'CLAUDE.md']` | Instruction file names looked up inside the repository and listed in prompts. |

### Version control provider (Reviews)

The Reviews page lists open pull requests from GitHub (via `gh`), GitLab (merge requests) or Bitbucket Cloud. The provider is detected from each repository's remote and can be changed in **Settings → Version control**; the choice and any API tokens are saved in `vcs-credentials.json` (mode 0600) in the Gantry data directory, not in `gantry.yaml`, and the API never returns tokens. Self-hosted GitLab needs its URL set there too. GitLab and Bitbucket pull requests open on the provider's site; in-app review, comments and merge remain GitHub-only.

## `services[]`

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| `id` | string | — (required) | Lowercase kebab-case. |
| `repository` | string | — (required) | Repository id this service runs from. |
| `runtime` | `command` \| `vite` \| `node` \| `python` | `command` | `command` runs `start` verbatim; the others use Gantry's managed runners (banner, `initServer`, Flask). |
| `watch` | boolean | `true` for managed Node | With `runtime: node`, restart when the entry or imported modules change. Set `false` to disable. Other runtimes use their own reload commands. |
| `install` | command | unset | Run once per (checkout, service); result is stamped so it is not repeated. |
| `start` | command | unset | **Required for `runtime: command`.** Managed runtimes start themselves and ignore it. |
| `healthUrl` | URL | unset | May reference `${port}`; probed for readiness. |
| `openUrl` | URL | unset | May reference `${port}`; the URL the UI and CLI open. |
| `port` | number | unset | Fixed port. Omit to allocate from the project range (allocations are sticky). |
| `dependsOn` | string[] | `[]` | Services that must be `ready` before this one starts. |
| `env` | map | `{}` | Extra environment values; values are interpolated. |
| `envFiles` | string[] | `[]` | Env files loaded in order, later files winning. Paths are relative to the repository checkout. |
| `workDir` | string | `.` | Working directory relative to the repository checkout. |
| `hooks.preStart` | command[] | `[]` | Run before spawn (120 s timeout each). |
| `hooks.postStart` | command[] | `[]` | Run after the service process is launched (not after readiness); failures are logged and do not stop the service. |
| `platform.darwin` / `platform.win32` / `platform.linux` | object | unset | Per-OS `install` / `start` overrides. |
| `banner.enabled` | boolean | `true` | Inject the local-preview banner (Vite runner only). |
| `banner.autoLogin` | boolean | `false` | Attempt programmatic sign-in; requires an environment and a project-provided login module (see `entry`). |
| `entry` | string | unset | `runtime: node` — module to import relative to the checkout, must export `initServer` (or a listenable `app`). `runtime: python` — module name imported from `src/` exposing `app`. For `runtime: vite`, the optional auto-login module. |

A command may be written three ways; all normalize to `{ kind, value }`:

```yaml
start: npm run dev                 # shell string (run through sh -c)
start: [npm, run, dev]             # argv array (no shell)
start: { kind: shell, value: npm run dev }
```

Environment values loaded from env files never leave the server process except by being handed to the child process. Runtime markers added to every service environment: `PORT`, `HOST=127.0.0.1`, `GANTRY_PREVIEW_SERVICE`, `GANTRY_WORKSPACE`, `GANTRY_CHECKOUT`, `GANTRY_PREVIEW_ID`, `GANTRY_DATA_DIR`, `GANTRY_READY_FILE`, and (when the banner is enabled) `GANTRY_BANNER*`.

## `environments[]`

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| `id` | string | — (required) | Lowercase kebab-case. |
| `label` | string | — (required) | Display name. |
| `default` | boolean | `false` | Used when a preview has no explicit environment selected. |
| `envFiles` | map | `{}` | Per-service private env files. Keys are service ids; values are **workspace-relative** paths to files you never commit. |
| `env` | map | `{}` | Non-secret values applied to every service (interpolated). |
| `requireKeys` | map | `{}` | Service id -> list of keys that must exist after env files load; missing keys fail before a switch. |

Selecting a different environment stops the preview and clears service signatures, so services restart against the new files. Missing env files are skipped silently; `requireKeys` is the mechanism for catching a file that is present but incomplete.

## `promptTemplates[]`

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| `id` | string | — (required) | Lowercase kebab-case; reference it from `project.defaultPromptTemplate`. |
| `label` | string | — (required) | Shown in the UI. |
| `body` | string | — (required) | Template text with `${var}` placeholders. |
| `extends` | string | unset | `builtin:default`, `builtin:paper-setter-legacy`, or another template id. The parent body is rendered before this one; cycles are rejected. |

## `agents[]`

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| `id` | string | — (required) | `codex`, `claude`, `opencode`, `generic`, or a custom adapter id. |
| `binary` | string | unset | Executable override; otherwise the adapter's discovery order applies. |
| `args` | map | `{}` | Extra adapter-specific arguments (for `codex`, appended as `--key value`; for `claude`, `permissionMode` is recognised; for `generic`, `command` is the template). |

## `safety`

| Key | Type | Default | Description |
| --- | --- | ------- | ----------- |
| `testRecordPrefix` | string | `TEST_` | Required prefix for any record a test creates; rendered into prompts. |
| `manualTestFile` | string | `manual-test-needed.md` | Filename agents must write when verification must stop; also the only markdown artifact served besides `summary.md`. |
| `policy` | string | unset | Free-form validation/safety policy rendered into prompts. |

## Variable interpolation

One engine (`packages/shared/src/config/vars.ts`) serves config values, hooks, health URLs and prompt templates. `$$` produces a literal `$`. An unknown variable raises an error that names the variable and lists the available ones — before anything is started.

### Prompt templates

| Variable | Value |
| -------- | ----- |
| `${ticket.title}` | Ticket title |
| `${ticket.description}`, `${ticket.notes}` | Ticket notes (alias kept for legacy compatibility) |
| `${ticket.scope}` | Comma-separated selected service IDs |
| `${ticket.scopeDescription}` | Selected service IDs, workspace-wide text, or the retained legacy scope |
| `${ticket.branch}` | Ticket branch |
| `${branch}` | Same as `${ticket.branch}` |
| `${workspace}` | Workspace root (realpath) |
| `${repo.<id>}` | Absolute path of repository `<id>` (the worktree path when the ticket has one) |
| `${url.<serviceId>}` | Service URL with `${port}` substituted |
| `${path.<serviceId>}` | Checkout path backing that service |
| `${artifactDir}` | Ticket evidence directory (local only) |
| `${previewUrl}` | Primary preview URL, or a "not ready yet" placeholder |
| `${safety.testRecordPrefix}` | From `safety` |
| `${safety.manualTestFile}` | From `safety` |
| `${project.id}`, `${project.name}` | Project identity |

### Service commands, hooks and env values

| Variable | Value |
| -------- | ----- |
| `${port}` | Allocated port for this service |
| `${port.<id>}`, `${origin.<id>}` | Allocated port and loopback HTTP origin of a configured service |
| `${workspace}` | Workspace root |
| `${branch}` | Preview branch (`__primary__` for the main workspace) |
| `${project.id}` | Project id |
| `${repo.<id>}` | Checkout path of the repository this service runs from |
| `${path.<serviceId>}` | Checkout path of that service |
| `${repoDir}` | Directory name of the checkout (`env` values only) |
| `${primaryDir}` | Directory name of the primary checkout, when known (`env` values only) |

`${repoDir}` and `${primaryDir}` are added for `env` value interpolation only; commands and hooks see the variables above them. `healthUrl` is interpolated with only `${port}` when probed. `${env:NAME}` resolves from the server's process environment; a missing or empty value raises a `VarError` that names the variable. Prefer private env files over `env:` references in committed configuration so machine-specific values and secrets stay out of `gantry.yaml`.

## Secret handling rules

1. **Never put a secret in `gantry.yaml`.** It is a project file, it is committed, and it is re-read and re-validated constantly.
2. **Reference, don't inline.** `environments[].envFiles` points at private files (workspace-relative paths such as `.local/environments/staging/backend.env`); Gantry reads them server-side only.
3. **Values never reach the API.** `/api/status` ends with `env: redactEnv({})`; environment state is reported as key names and value lengths at most.
4. **Repo env files are never rewritten.** `.env`, `.env.local` and friends are read and merged in precedence order; nothing writes back to them.
5. **Evidence stays local.** `${artifactDir}` is inside the Gantry data directory, created `0700`; prompts instruct agents never to commit or upload it.

## Worked example

A workspace with a Vite frontend, a Node backend, a Python logic service and an E2E harness, plus two private environment sets:

```yaml
apiVersion: gantry.dev/v1

project:
  id: acme-shop
  name: Acme Shop
  defaultAgent: codex
  defaultPromptTemplate: builtin:default
  branchPrefix: ticket
  worktreeRoot: .worktrees
  portBase: 5200
  portRange: 500
  workspaceInstructions: [AGENTS.md, CLAUDE.md]

repositories:
  - id: frontend
    path: shop-web
    remote: origin
    defaultBranch: main
    role: product
    worktree: true
    required: true
  - id: backend
    path: shop-api
    remote: origin
    defaultBranch: main
    role: product
    worktree: true
    required: true
  - id: logic
    path: shop-logic
    remote: origin
    defaultBranch: main
    role: product
    worktree: true
    required: false
  - id: e2e
    path: shop-e2e
    remote: origin
    defaultBranch: main
    role: tooling
    worktree: false
    required: false

services:
  - id: frontend
    repository: frontend
    runtime: vite
    install: npm ci --no-audit --no-fund
    healthUrl: http://127.0.0.1:${port}/
    openUrl: http://127.0.0.1:${port}/
    dependsOn: [backend]
    envFiles: [.env, .env.local]
    banner:
      enabled: true
      autoLogin: false

  - id: backend
    repository: backend
    runtime: node
    entry: src/app.ts
    install: npm ci --no-audit --no-fund
    healthUrl: http://127.0.0.1:${port}/health
    openUrl: http://127.0.0.1:${port}/api-docs/
    dependsOn: [logic]
    envFiles: [.env, .env.local]
    env:
      LOG_LEVEL: debug
      CALLBACK_URL: http://127.0.0.1:${port}/callback

  - id: logic
    repository: logic
    runtime: python
    entry: app
    healthUrl: http://127.0.0.1:${port}/health
    envFiles: [.env, .env.local]
    platform:
      win32:
        install: python -m venv .venv && .venv/Scripts/pip install -r requirements.txt

environments:
  - id: staging
    label: Staging
    default: true
    envFiles:
      frontend: .local/environments/staging/frontend.env
      backend: .local/environments/staging/backend.env
      logic: .local/environments/staging/logic.env
    env:
      FEATURE_FLAGS: preview
    requireKeys:
      backend: [DATABASE_URL, AUTH_SECRET]

  - id: sandbox
    label: Sandbox
    envFiles:
      frontend: .local/environments/sandbox/frontend.env
      backend: .local/environments/sandbox/backend.env
    requireKeys:
      backend: [DATABASE_URL]

promptTemplates:
  - id: shop-conventions
    label: Acme Shop conventions
    extends: builtin:default
    body: |
      Project-specific rules for this ticket:
      - The frontend lives in ${repo.frontend}; API routes in ${repo.backend}.
      - Verify against the preview at ${url.frontend} and record evidence in ${artifactDir}.
      - Never mutate an existing record; create only ${safety.testRecordPrefix}-prefixed data.

agents:
  - id: codex
    binary: /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex

safety:
  testRecordPrefix: TEST_
  manualTestFile: manual-test-needed.md
  policy: Local validation only. No migrations, seeds, deploys or production mutations.
```

With this config, starting a ticket titled "Add promo banners" creates `ticket/add-promo-banners` worktrees for `frontend`, `backend` and `logic` under `.worktrees/ticket--add-promo-banners/`, allocates three sticky ports from 5200 upward, starts `logic` -> `backend` -> `frontend` in dependency order, and launches Codex with a prompt that names the real preview URL, the three worktree paths and the ticket's evidence directory.

## Environment variables that configure Gantry itself

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `GANTRY_PORT` | `4500` | Dashboard port. |
| `GANTRY_HOST` | `127.0.0.1` | Bind address; anything non-loopback prints a warning. |
| `GANTRY_DATA_DIR` | platform default | Where the database, logs and artifacts live. |
| `GANTRY_UI_DIR` | detected | Serve the dashboard from a specific build directory. |
| `GANTRY_DEV_ORIGINS` | empty | Comma-separated origins allowed to call the API during UI development. |
| `GANTRY_CODEX_BINARY` | unset | Codex binary override, between config and bundled discovery. |
| `GANTRY_DISCOVER_INTERVAL_MS` | `15000` | Fast discovery cadence. |
| `GANTRY_REMOTE_INTERVAL_MS` | `120000` | Remote sync cadence. |
| `GANTRY_TAKEOVER_GRACE_MS` | `4000` | SIGTERM grace before SIGKILL on takeover. |
| `GANTRY_SERVICE_READY_TIMEOUT_MS` | `120000` | Before a starting service is marked failed. |

### Connecting services within a preview

Reference configured services in `env` with `${origin.<id>}` (the loopback HTTP origin without a path) and `${port.<id>}`. Addresses are reserved before startup, so callbacks and browser CORS origins can reference callers without circular readiness dependencies. Use `dependsOn` only for services that must be healthy before startup. Optional `whenFile: exam-runtime/server.ts` starts a service only in checkouts containing that relative file. These values override env files, and changes to dependency ports restart the consuming service.

```yaml
services:
  - id: frontend
    repository: frontend
    runtime: vite
    dependsOn: [backend]
    env:
      VITE_BACKEND_URL: ${origin.backend}
```

Use the variable name your application reads; Gantry does not assume a frontend framework or API setting. `dependsOn` alone controls startup order, not application URLs.

### Backend source reloads

Managed `runtime: node` services run with Node watch mode by default. Changes to the entry or imported modules restart the service process on its existing port; logs are retained. This includes modules loaded through the checkout's TypeScript loader. Set `watch: false` on a Node service to opt out. Arbitrary files read as data and newly created, not-yet-imported modules are not guaranteed to trigger a restart.

**Linux atomic-save limitation:** Node's built-in watcher can stop detecting edits to a file after an editor replaces it using an atomic save (write a temporary file, then rename it over the original). If the backend serves stale code, restart the affected preview in Gantry to load the latest code and recreate its watchers. This may recur after another atomic save. Where supported, configure your editor to save files in place instead. Automatic reload after repeated atomic saves is not guaranteed on Linux.

For `runtime: command`, use the framework's development command or add `--watch --watch-preserve-output` to a Node command. Gantry does not wrap arbitrary commands in a second watcher. Vite already reloads its frontend independently. Backend restarts briefly interrupt requests and reset in-memory server state; they do not reload the browser page.

## Workspace graph templates

Workspaces can keep multiple graphs. In **Workspace graph**, select a template to
edit it, or use **Add as workspace graph template** to save the current draft under
a new name. The same button in a ticket's **Edit graph** saves its current draft,
including unsaved graph edits, without changing the ticket or copying its progress.
Shared instructions remain workspace-wide.

When creating a ticket, choose **Workspace graph template**. The ticket receives
an independent snapshot: later template edits affect only future tickets. The
**Default** graph remains in `workflow`; older clients and requests without a
selection continue to use it. Alternative templates live in `workflowTemplates`:

```yaml
workflowTemplates:
  - id: quick-fix
    name: Quick fix
    graph:
      autoStart: false
      nodes:
        - id: implement
          label: Implement
          kind: agent
          instructions: Implement and verify the requested fix.
          dependsOn: []
```

Template IDs must be unique lowercase alphanumeric/hyphen strings (up to 80
characters); `default` is reserved. Names must be nonempty, unique ignoring case,
and at most 80 characters; **Default** is reserved. A workspace supports up to 100
named alternatives. Graphs use the same validation as `workflow`.

The desktop **New ticket** dialog shows an editable copy beside the ticket details.
Set stage instructions, providers, models, connections, and **Run automatically**
before selecting **Create ticket**. These edits affect only the new ticket and are
saved together with its details. Switching templates or closing the dialog asks
before discarding graph edits. After creation, the dialog closes to the board;
open the ticket when you want to view or run it.

Runtime API: `GET /api/projects/:projectId/workflow-templates` lists the default
and alternatives. `POST` to that collection with `{ name, graph }` creates an
alternative with a generated ID; `POST` to `.../workflow-templates/:templateId`
updates an existing alternative. Ticket creation accepts `workflowTemplateId`;
unknown selections are rejected before creating a ticket. An optional `graph`
overrides the selected template for this ticket and is validated before insertion;
omitting it keeps the selected template's graph. Invalid graphs create no ticket.
Existing `workflow`
endpoints continue reading and writing the default graph.

## Copy a workspace graph

In the desktop app, open **Workspace graph** and select **Export graph** to download
the current draft as a versioned JSON file. Open the destination workspace, select
**Import graph**, and choose the file. Confirm **Replace draft**, review the graph,
then select **Save graph**. Canceling or importing an invalid file preserves the draft.

Files include nodes, instructions, connections, layout, and provider/model settings.
Check provider availability in the destination workspace. Automatic runs are disabled
on import until you enable them. Shared workspace instructions and ticket execution
history are not copied, and existing tickets keep their own graph snapshots.
Import and export run locally in the browser; only saving uses the existing workspace
configuration API. Files must be version 1 Gantry graph exports under 8 MB.
