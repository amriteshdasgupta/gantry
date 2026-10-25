<div align="center">

# Gantry

### Your models. Your workflow. A graph you control.

**Build the graph your coding agents follow—from the first plan to the final review.**

Design the steps. Choose the models. Connect the decisions and feedback loops.<br>
Gantry turns your development process into a visible, repeatable workflow—in one desktop app.

[**Get started ↓**](#get-started) · [Explore the docs](docs/FAQ.md) · [Give feedback](https://github.com/Drajax69/gantry/issues)

**Claude Code · Codex · OpenCode**<br>
Open source · macOS & Windows · MIT licensed

</div>

## Stop repeating the process. Build it into the graph.

You know how you want software built: understand the problem, make a plan, implement, test, review, fix what the review catches. Gantry lets you give that process to your models.

**Create your own graph on a visual canvas.** Every node is a task with its own instructions and model. Every connection describes when to move to the next step. Branch by outcome, loop back for corrections, and save the workflow as a template for the next ticket.

### Build. Review. Improve. Then open the PR.

Give planning, implementation, and review their own stages. Send requested changes back to the builder. Route approved work to a pull request. **Make the quality checks part of the process, every time.**

<img alt="Gantry's graph editor showing planning, implementation and testing, review, and pull request stages, with a changes-requested loop back to implementation." src="docs/images/graph-review-loop.png" width="1600">

<p align="center"><sub>Feature delivery with a review loop. Captured from the Gantry UI with example data.</sub></p>

## More visibility. More deliberate quality. Less hand-holding.

| What you control           | Why it matters                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The process**            | Define the stages your task needs, from a two-step fix to a multi-stage workflow with branches and correction loops.                                 |
| **The model at each step** | Choose a provider, model, and reasoning effort per node. Give planning, coding, and review the settings they need.                                   |
| **The quality checks**     | Give tests and review explicit instructions and a place in the graph. Route feedback into another implementation pass.                               |
| **The visibility**         | Follow stage progress, inspect attempts and handovers, and see the coordinator's routing decisions. Know where work stands and what needs attention. |
| **The repeatability**      | Save multiple graph templates, pick one per ticket, and import or export workflows to reuse a process that works.                                    |

### Different problem? Different graph.

A bug doesn't always need the same path as a feature. Start with investigation, route a frontend issue to a UI fix or an API issue to a backend fix, then verify the result.

<img alt="Gantry's graph editor showing a bug investigation branching to a frontend or backend fix, with both paths leading to verification." src="docs/images/graph-bug-triage.png" width="1600">

<p align="center"><sub>Conditional bug triage. Captured from the Gantry UI with example data.</sub></p>

**You write the conditions in plain language.** Gantry's coordinator uses stage results to choose among the connections you've defined. Each ticket runs one working stage at a time; different tickets can run concurrently.

## Draw it once. Put it to work.

1. **Shape the workflow.** Add nodes, drag connections, and describe when each path should be taken.
2. **Give each stage a job.** Set instructions and model choices. Add shared project conventions and test commands once for every stage to use.
3. **Run it on a ticket.** Choose a graph template and move the ticket into **In progress** with **Run automatically** enabled.
4. **Follow the work.** Inspect progress and stage history, open the preview, and review the changes. Feed PR review feedback back into a stage when another pass is needed.

Start with the built-in **Plan → Implement → Review → Create PR** workflow, or make the graph your own.

## The graph is the process. The workspace is the whole picture.

Tickets, agent chats, Git worktrees, running previews, and pull requests stay together. Go from the workflow to the software it produced, without losing the context of the ticket.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/ticket-board-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/images/ticket-board-light.png">
  <img alt="Gantry brings your tickets, coding chats, running previews, and pull requests together in one colourful workspace." src="docs/images/ticket-board-dark.png" width="1440">
</picture>

<p align="center"><sub>The workflow, the work, and the result—in one place.</sub></p>

## Get started

### 1. Grab the essentials

Install [Node.js 22.12+](https://nodejs.org/), [Git](https://git-scm.com/), and [herdr](https://herdr.dev) for agent chats.

Choose and sign in to one coding agent: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), or [OpenCode](https://opencode.ai).

For GitHub reviews, install [GitHub CLI](https://cli.github.com/) and run `gh auth login`.

### 2. Build and open Gantry

Paste these commands into your terminal:

```sh
git clone https://github.com/Drajax69/gantry.git
cd gantry
npm ci
npm run desktop:setup
npm run desktop:start
```

### 3. Give it something to build

Open your project in your coding agent and paste:

> Set up Gantry for this folder using https://github.com/Drajax69/gantry/blob/main/SETUP.md

Your agent configures the workspace, previews, and starter graph for you.

Choose your agent in **Settings** → **Add workspace** → create a ticket → drag it into **In progress**.

New workspaces start the graph automatically when a ticket enters **In progress**. Open **Workspace graph** to customize your process, and follow each ticket's progress in its workflow view. Keep Gantry open while your agents work.

<details>
<summary><strong>Want a standalone app?</strong></summary>

After the setup above, run this on the computer you'll use:

```sh
npm run desktop:build
```

You'll find the app in `desktop/dist/`. On Apple Silicon Macs, open `desktop/dist/mac-arm64/Gantry.app`.

**Linux (AppImage).** Build a self-contained AppImage — it bundles Chromium + Node, so it runs on any glibc 2.28+ distro (Arch, Debian, Ubuntu, RHEL8) with nothing else installed:

```sh
npm run app:build:linux --prefix desktop
```

The result is `desktop/dist/Gantry-x86_64.AppImage`. To launch it as `gantry` from the terminal (ensure `~/.local/bin` is on your PATH):

```sh
install -Dm755 desktop/dist/Gantry-x86_64.AppImage ~/.local/opt/Gantry.AppImage
cat > ~/.local/bin/gantry <<'EOF'
#!/bin/sh
APP="$HOME/.local/opt/Gantry.AppImage"
if [ "$1" = "update" ]; then
  echo "Updating Gantry…"
  curl -fL "https://github.com/amriteshdasgupta/gantry/releases/latest/download/Gantry-x86_64.AppImage" -o "$APP.tmp" \
    && chmod +x "$APP.tmp" && mv "$APP.tmp" "$APP" && echo "Updated." || { echo "Update failed."; rm -f "$APP.tmp"; exit 1; }
  exit 0
fi
if command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1; then
  exec "$APP" "$@"
else
  exec "$APP" --appimage-extract-and-run "$@"   # no FUSE present
fi
EOF
chmod +x ~/.local/bin/gantry
gantry          # opens the desktop app
gantry update   # pulls the latest release in place
```

For a Windows installer, run:

```sh
npm run app:build:win --prefix desktop
```

Windows needs PowerShell. Builds are currently unsigned.

</details>

---

<div align="center">

**Your best development process. Ready for your next ticket.**

[Get started](#get-started), build your first graph, and put your models to work. [Star Gantry](https://github.com/Drajax69/gantry) to help more builders find it.

[Configuration](docs/configuration.md) · [FAQ](docs/FAQ.md) · [Contribute](CONTRIBUTING.md) · [Privacy & security](docs/security.md) · [MIT license](LICENSE)

</div>
