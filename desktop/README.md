# Gantry desktop

This is the unified Electron and Next.js application. Run setup and builds from the repository root as described in [the Gantry README](../README.md).

The PR-review feature grew from the existing PR Lens implementation. Compatibility names (`pr-lens://`, `PR_LENS_*`, and `~/.pr-lens`) remain to preserve existing links and personal data; the application is Gantry.

Run `npm ci` here once. `npm run dev` starts Next.js; start the runtime separately for local development. `npm run app:build` packages the app using the parent repository as runtime source. No personal tickets or provider credentials belong in this directory.

Each workspace has a **Workspace graph** editor in its sidebar. **Shared starting instructions** inside that editor edits the workspace's selected prompt into a custom template in its local `gantry.yaml`. New external Codex and Claude ticket conversations receive the rendered template as starting instructions, together with ticket details and prepared worktree paths. Opening a chat does not automatically send a model turn. Existing conversations retain their original instructions. Templates support the existing Gantry variables, including `${ticket.title}`, `${ticket.description}`, `${ticket.branch}`, `${workspace}`, `${previewUrl}`, and `${repo.<repository-id>}`; product repository paths resolve to the ticket's worktrees. Paper Setter workspaces imported from the legacy branch manager retain their selected legacy preset until edited.

The sidebar's **Previews** section embeds **Main** and each **In progress** ticket's local service page. Backlog and Done tickets are excluded. A service picker, reload control, external-browser link, and expandable service logs are available in the preview pane. Main uses each repository's configured default branch; when that branch is not checked out, Gantry prepares a separate worktree without switching the user's working branch. Main remains active while Gantry is running and cannot be paused or archived. This previews local default-branch code; it does not automatically pull or reset Git branches.

**Debug** opens preview diagnostics on the right without reloading the embedded page. Gantry-managed Vite previews capture console output, uncaught errors, unhandled rejections, Fetch/XHR results, and resource timings. Filter entries, show errors only, clear the log, or expand an entry for details. Capture keeps at most 500 entries in browser memory, scoped to the current preview document; it does not write logs to disk. Requests show method, URL, status (when exposed by the browser), and duration, with browser-visible headers and text/JSON request and response bodies (up to 16 KB each; binary bodies are labelled, not decoded). This is a focused diagnostics panel, not the full browser DevTools protocol; WebSocket frames and server logs are not part of its network feed. Server logs are in the Logs tab.

The Debug panel has Console, Network, and Logs tabs. Network includes an XHR-only filter; Logs lets you select a service, refresh its output, and control preview services. Preview pages start directly at the service toolbar.

Workspaces stay directly selectable at the top of the sidebar. The selected workspace's name and path introduce its Tickets, Reviews, and Previews navigation, and a persistent breadcrumb identifies the workspace in every view, including embedded reviews and previews. Switching workspaces returns to Tickets and resets ticket and preview selection. Navigating away while a review is loading keeps the newer selection; the pending review is saved without reopening over it. The Tickets badge counts only in-progress tickets.

Ticket reviews open within the workspace sidebar. Switching to Tickets and back to Reviews retains the open review. The embedded review switcher lists only that workspace's ticket spaces and the currently open space; unassigned spaces remain available in the standalone review app. Reviewing PRs without a linked ticket creates a separate, explicitly selected review space, keeping all PRs in the group together without reusing another workspace's current ticket space. Create other unassigned spaces in the standalone review app, or start a ticket to create a workspace-linked review. Review deep links select the ticket's owning workspace even when a different workspace was previously selected, and that selection remains after the ticket completes. Network status chips highlight successful requests in green and failures in red; expanded requests include Request and Response tabs.

Moving a ticket into In progress (by dragging or changing Stage) prepares and opens its external provider conversation. Chat, Preview, and Review actions and review spaces are available only for in-progress tickets; existing conversation associations are retained for reopening. Codex conversations materialize their initial context through thread/inject_items without running a model turn, and Gantry checks the rollout file before opening the app. Missing rollouts are replaced with a durable conversation while retaining the previous session ID for reference.

On macOS, the first Open chat for a Codex ticket also prefills the native composer with the full ticket context and workspace prompt. Press Send in Codex to begin. Successful handoff is recorded so subsequent opens preserve the draft; missing-file recovery prefills the replacement chat again. Legacy associations with existing turns are not prefilled.

## Workspace graphs

The Tickets **Graph** view shows each in-progress ticket's complete workflow, dependencies, step states, and current stage. Backlog and Done tickets stay on the Board. Search by title or branch, inspect stages with the graph controls, and use the ticket card for details, chat, preview, and review. Graphs refresh every two seconds; tickets without a workflow snapshot show an explicit empty state.

**Workspace graph** in the sidebar defines the path for future tickets. The default is Plan → Implement → Test → Create Playwright trace. Select a step to edit its name, instructions, owner, and dependencies. Steps sharing dependencies can run in parallel; a join waits for every dependency. User decision steps appear as **Waiting on you** when ready. Shared starting instructions remain available inside the graph editor.

New tickets store an independent graph snapshot in SQLite. Workspace edits do not change those snapshots. **Edit graph** in ticket details changes only pending steps; started steps keep their definition and progress. Older tickets can explicitly **Copy workspace graph**. Graph updates use revisions to reject stale edits. Saving a workspace graph preserves the rest of `gantry.yaml`.

Agents receive the ticket graph in their starting instructions. The agent coordinates execution and parallel delegation; Gantry tracks reported progress and enforces dependencies when accepting updates. This does not launch a separate agent process per node automatically. Agents report with:

```sh
gantry workflow <ticket-id>                              # Inspect graph and revision
gantry workflow <ticket-id> plan running
gantry workflow <ticket-id> plan waiting --message 'Which API contract should I use?'
gantry workflow <ticket-id> plan done --message 'Plan verified'
```

Use `--port` or `GANTRY_PORT` for a non-default Gantry server. Independent agents can report concurrent steps; the CLI retries revision conflicts. Users can also update progress from ticket details. Complete a human decision only after the requested response. Waiting tickets are linked from the board's **Waiting on you** banner. Existing external conversations need the graph instructions supplied again if their graph is changed after the conversation starts.

Schema migration `004_ticket_workflow.sql` adds the nullable ticket snapshot column when Gantry opens its database. It leaves older tickets unchanged. Do not apply this migration to a shared installation merely to verify a feature branch; use an isolated local preview data directory.
