# Contributing to Gantry

Thanks for helping. This document covers setup, project layout, and what a pull request needs.

## Dev setup

Requirements: Node.js >= 22.5 (Gantry uses `node:sqlite`), npm 10+, and `git` on your `PATH` (the test suite creates real temporary repositories).

```sh
git clone <your-fork>
cd gantry
npm install
npm run build          # tsc -b shared server cli + vite build for the UI
```

Run things locally:

```sh
npm run dev:server     # @gantry/server under tsx watch
npm run dev:ui         # Vite dev server for the dashboard
gantry init /path/to/sandbox-workspace   # scaffold a config to experiment with
```

Point the dev UI at the dev API with `GANTRY_DEV_ORIGINS=http://localhost:5173` when starting the server, and use `GANTRY_DATA_DIR=/tmp/gantry-dev` so experiments never touch your real data directory.

Tests, types, style:

```sh
npx vitest run         # unit + integration tests (real temp git repos, offline)
npx vitest             # watch mode
npm run test:e2e       # browser specs (Playwright)
npm run typecheck      # tsc -b packages/shared packages/server packages/cli && tsc --noEmit -p packages/ui
npm run lint           # eslint packages scripts
npm run format         # prettier --write .
```

## Project layout

```text
packages/shared    zod config schema, ${var} interpolation, branch/paths/redact utils, capability model
packages/server    app core: db, projects, git, discover, supervisor, jobs, tickets, prompts, agents, artifacts, http, importer
packages/cli       the `gantry` binary (serve, add, init, import-legacy, status, open)
packages/ui        React + Vite dashboard
tests/             vitest suites; tests/helpers.ts builds disposable git fixtures
scripts/           fixture + release tooling
docs/              architecture, configuration, security, migration, release, agents, FAQ
examples/          complete example workspaces
```

See [docs/architecture.md](./docs/architecture.md) for how the modules fit together and the invariants they maintain.

## Ground rules for changes

- **Respect the reliability invariants** ([docs/architecture.md](./docs/architecture.md)): the atomic start lock, durable jobs, the fast/slow discovery split, ownership verification before any signal, and archive-not-delete. A change that weakens one needs a strong argument in the PR description.
- **No secrets, ever.** Never commit environment files, tokens, tickets, or absolute home paths — not in code, not in tests, not in documentation. Use placeholder paths such as `/path/to/workspace`.
- **Config changes go through the schema.** Add the field to `packages/shared/src/config/schema.ts` with a default, extend `validateConfigReferences` if it interacts with other keys, and update [docs/configuration.md](./docs/configuration.md).
- **Destructive operations need `confirm: true`** on the API and an explicit dialog in the UI.
- **Capabilities are reported honestly.** If a new integration cannot do something, return the unavailable capability object with a note; do not approximate.

## Commit style

Conventional Commits, imperative subject line, wrapped body when needed:

```text
feat(agents): add deep link support for the generic adapter
fix(supervisor): check service signature before reallocating ports
docs(configuration): document platform overrides
refactor(jobs): bound job attempts after a restart
test(worktrees): cover reuse of a dirty worktree
chore(ci): run the UI build in a separate job
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`. Scopes are package or module names (`agents`, `supervisor`, `jobs`, `tickets`, `prompts`, `http`, `ui`, `config`).

## Pull requests

Before opening:

- [ ] tests added or updated (`npx vitest run` green)
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` run
- [ ] no secrets, real usernames, or absolute home paths introduced
- [ ] documentation updated when behaviour, config, or the API changed
- [ ] changelog entry under `## [Unreleased]` for user-visible changes

In the description, say what changed, why, and how you verified it. If the PR touches supervision, jobs, or agents, include the scenario you exercised (restart mid-run, slow remote, dirty worktree, …).

Run the relevant typecheck, lint, tests, and builds locally before publishing changes. Pushes to `production` also run the GitHub Actions release workflow, which builds and verifies the release archive before publishing it. See [the release process](./docs/release.md) for version preparation.

Small PRs win. A focused change with a clear test is easier to review and easier to revert.

## Code of conduct

By participating you agree to the [Contributor Covenant](./CODE_OF_CONDUCT.md). Report unacceptable behaviour privately to the maintainers at the address in [SECURITY.md](./SECURITY.md).

## Security issues

Do not open a public issue for a security problem. See [SECURITY.md](./SECURITY.md) for private reporting and scope.

## Desktop application

The primary product UI is now `desktop/` (Electron + Next.js); `packages/ui` remains the standalone runtime dashboard. Install its independent dependency lock with `npm run desktop:setup`. Use `npm run desktop:build` to build the runtime and desktop together. Run the desktop's typecheck, lint and offline browser tests before submitting UI changes. Never copy `~/.pr-lens`, Gantry's data directory, workspace YAML, screenshots of personal work, or local checkouts into the repository.

For concurrent worktrees, choose unused offline browser-test ports with
`GANTRY_E2E_PORT=3657 GANTRY_E2E_RUNTIME_PORT=3658 npm run desktop:test`.
