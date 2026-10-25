# Changelog

All notable changes to Gantry are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Open unlinked workspace PRs in an explicit review space instead of another workspace's current ticket space, and retain a deep-linked workspace after its ticket completes.
- Guard merged-worktree cleanup against workflow activity on every ticket sharing a branch, allow idle paused/waiting workflows, and revalidate nested squash merges through cached parent PRs.
- Show full individual workflow graphs and current stages in the desktop Graph view, limited to in-progress tickets.
- Show OpenCode permission requests in the workflow's Allow and retry panel, persist exact provider-specific grants, and apply them on retry without changing Claude permissions. Existing logged permission failures gain the same approval panel.
- Apply checkout-scoped OpenCode session migration to workflow stages and coordinators as well as review chats. Legacy or mismatched sessions start fresh with available context preserved; empty CLI responses produce explicit errors.
- Authorize OpenCode workflow runs for the configured workspace and ticket checkouts, including resumed sessions. Surface CLI permission waits as actionable stage failures instead of silently remaining running.
- Bind OpenCode review runs to the PR checkout instead of an inherited launch directory. Older incorrectly scoped review sessions are refreshed with their chat history preserved, and failed tool calls now display their error details.
- Resolve legacy bare OpenCode model names automatically from the workspace's model catalog for stage runs and chats. Unknown or ambiguous models now explain how to select a valid model; upstream errors identify the model, session and OpenCode log location, and model-list failures are visible in the dropdown editor.

### Changed

- Make workspace selection a distinct top-level sidebar section, keep workspace identity visible across every view, and scope the embedded review switcher to the selected workspace. Review deep links select their ticket's workspace.
- Preview and edit a ticket's workflow, stage instructions, and execution settings directly in New ticket. Create saves the graph with the ticket and returns to the board without reopening details.
- Ticket scopes now select one or more services from `gantry.yaml` using checkboxes in desktop and standalone dashboards, with persisted selections and service-based agent prompts. Older tickets and YAML remain readable.

### Added

- Add `npm run desktop:restart` to rebuild, install, and relaunch the desktop app on Apple Silicon macOS.
- Automatically build, verify, and publish a versioned GitHub release with its archive and checksum when changes land on `production`.
- Clean merged worktrees from Done ticket cards with an explicit confirmation, live local Git validation, active-work guards, and per-checkout results. Ticket history and branches are retained.
- Support named workspace graph templates, choose a graph when creating a ticket, and save ticket graph drafts as reusable templates.
- Restart a ticket graph from a chosen stage directly in PR review, carrying refreshed GitHub feedback and local review discussion into the correction loop.

- Show cached pull request status icons on desktop ticket cards, graph nodes and ticket details.

- Export workspace graphs as JSON and import them into another workspace for review before saving.

- Windows desktop build targets, native window controls, external agent consoles, command-shim support and owned process-tree supervision. Native Windows lifecycle checks remain required before distribution.

- Ship the unified Gantry desktop app with ticket dialogs, column dragging, shared provider settings and external ticket conversations, and integrated PR review.
- Detect repositories for first-run workspace setup and prepare ticket worktrees independently of any provider.
- Keep personal state out of the source repository.

### Added

- Add a searchable ticket status graph with shared ticket actions, linked conversations, and visible two-second refreshes.

- Give tickets persistent individual colours, with coordinated board accents and matching ticket headers in light and dark mode.

- Review unpublished edits in Local changes and commit and push them to the PR directly from Gantry. Preserve local commits after failed pushes and remote refreshes.

- Open GitHub pull requests in the PR Lens desktop app directly from the Pull requests board.

### Fixed

- Reduce ticket dialog height slightly while preserving its width and scrollable content.

- Remove the extra inset before the embedded review space selector and widen it to show more of the space name.

- Default Gantry to light mode on first open, preserving saved desktop theme choices.

- Wire preview services using dynamic dependency origins and ports; legacy frontend imports now connect to their own preview backend.

- Managed runtimes retain a verifiable process claim, preventing duplicate preview processes on discovery passes.

- Custom agents now accept quoted command arguments and preserve literal prompt content during substitution.
- Custom-agent takeover can stop a verified process without a session ID.
- Browser checks wait for successful run and takeover states, and fixture cleanup stops only its own agents and previews through Gantry's API.

## [0.1.0] - 2026-10-13

Initial public release. Gantry is a local development control plane: register a Git workspace, describe it once in `gantry.yaml`, and move a ticket from the board to coordinated worktrees, an isolated branch preview, an AI coding agent, takeover, and PR/evidence review.

### Added

- **Workspace configuration** — `gantry.yaml` validated by a Zod schema: project defaults, repositories, services, environments, prompt templates, scopes, agent overrides, and a safety policy. Reloaded on every discovery pass, so edits apply without a restart.
- **Ticket board** — per-project backlog / in progress / done with explicit ordering, scopes, branch derivation from titles (validated with Git's ref rules), and an atomic start lock so a ticket has exactly one active run.
- **Coordinated worktrees** — one worktree per worktree-enabled repository per ticket, created idempotently and reused when they already exist, with bounded fetches so an offline or slow remote never blocks a start.
- **Branch previews** — fast local discovery groups worktrees by branch; services start in dependency order on sticky loopback ports with per-service install stamping, signature-based restarts, readiness probes, and a managed Vite banner that names the branch in the browser.
- **Managed runtimes** — `command`, `vite` (banner + optional auto-login module), `node` (imports the checkout's entry module with `ts-node` when present), and `python` (serves a Flask app from the checkout's virtual environment).
- **Service supervision** — desired-state reconciliation with ownership verification before any signal, restart backoff, health passes, startup recovery, and platform-specific command overrides.
- **Durable job queue** — SQLite-backed jobs with dedupe keys, worker-id leases, bounded retry attempts, and phase/progress reporting in the dashboard.
- **Agent adapters** — Codex CLI (JSON events, `codex://threads` deep links), Claude Code (stream-json, terminal resume), OpenCode (best-effort session parsing), and a generic command adapter; takeover interrupts a verified process group and hands back the session.
- **Prompt engine** — layered prompts from builtin or project templates with `extends` chains, repository instruction discovery, agent notes, and per-ticket additions, all through one `${var}` interpolation engine.
- **Evidence handling** — a five-file artifact allowlist (`manual-test-needed.md`, `video.webm`, `trace.zip`, `final.png`, `summary.md`), `0700` directories, and sandboxed serving.
- **Merge evidence** — patch-id verification that retires previews and completes tickets after fast-forward, squash, rebase, and nested-squash merges, with proofs cached across offline runs; optional exact PR state when the GitHub CLI is authenticated.
- **HTTP API and dashboard** — Fastify server with loopback-only binding, host allowlist, same-origin mutations, strict CSP, and a React UI for tickets, previews, and pull requests.
- **Legacy importer** — `gantry import-legacy` migrates a legacy preview-manager workspace (config, tickets, preview preferences, prompt preset) with a dry-run mode and a JSON migration report.
- **CLI** — `gantry serve`, `add`, `init`, `import-legacy`, `status`, `open`.
- **Docs** — architecture, configuration reference, security model, migration guide, agent adapters, release process, and FAQ.

[Unreleased]: relative link reference, see the repository's compare view for `HEAD...v0.1.0`
[0.1.0]: tagged `v0.1.0` in this repository
