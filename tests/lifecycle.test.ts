import { test, describe, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildStatus } from '../packages/server/src/status.js';
import { GantryApp } from '../packages/server/src/app.js';
import { createAppContext } from '../packages/server/src/config/app.js';
import type { AgentAdapter, AgentStartContext, SpawnSpec } from '../packages/server/src/agents/types.js';
import { initFixtureRepo, tempDir, write, until, delay, killGroup } from './helpers.js';

/**
 * Full fixture lifecycle over real temporary Git repositories and real
 * `node` child processes (never real coding agents):
 *
 *   register project -> discovery -> ticket -> queued start job -> worktrees
 *   -> fake agent run -> duplicate-start lock -> preview services become
 *   ready on real ports -> pause/restart -> takeover -> restart recovery.
 */

const cleanups: (() => Promise<void>)[] = [];
const trackedPids: { pid: number; pgid: number }[] = [];
afterAll(async () => {
  for (const pid of trackedPids.splice(0).reverse()) await killGroup(pid.pgid, pid.pid);
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
});

const SERVER_SCRIPT = `
import http from 'node:http';
const port = Number(process.env.PORT);
const role = process.env.ROLE ?? 'unknown';
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ role, port, ok: true, backend: process.env.BACKEND_URL }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1');
`;

function fakeAdapter(): AgentAdapter {
  const script = `console.log(JSON.stringify({session_id: 'sess-fixture-1'})); setInterval(() => {}, 1 << 30);`;
  return {
    id: 'fake',
    label: 'Fake agent',
    promptNotes: '',
    async resolveBinary() {
      return { path: process.execPath, via: 'test' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async capabilities(binaryPath: string | null): Promise<any> {
      return {
        id: 'fake',
        label: 'Fake agent',
        available: Boolean(binaryPath),
        discoveredVia: binaryPath,
        version: 'test',
        resumeMode: 'unsupported',
        takeover: true,
        interruptMode: 'process-group',
        deepLinkScheme: null,
        streaming: true,
        notes: [],
      };
    },
    buildStart(context: AgentStartContext): SpawnSpec {
      return { argv: [process.execPath, '-e', script], cwd: context.workspace, claim: 'node -e' };
    },
    buildResume() {
      return null;
    },
    deepLink() {
      return null;
    },
    parseSessionLine(line: string): string | null {
      try {
        const parsed = JSON.parse(line) as { session_id?: string };
        return typeof parsed.session_id === 'string' ? parsed.session_id : null;
      } catch {
        return null;
      }
    },
  };
}

async function createFixtureWorkspace(): Promise<{ workspace: string; dataDir: string; cleanup: () => Promise<void> }> {
  const outer = await tempDir('gantry-lifecycle-');
  cleanups.push(outer.cleanup);
  const workspace = path.join(outer.dir, 'workspace');
  const dataDir = path.join(outer.dir, 'data');
  await fs.mkdir(path.join(workspace, 'frontend'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'backend'), { recursive: true });
  for (const repo of ['frontend', 'backend']) {
    const repoDir = path.join(workspace, repo);
    await initFixtureRepo(repoDir);
    await write(path.join(repoDir, 'package.json'), JSON.stringify({ name: repo, version: '1.0.0' }));
    await write(path.join(repoDir, 'package-lock.json'), JSON.stringify({ name: repo, lockfileVersion: 3, packages: {} }));
    await write(path.join(repoDir, 'server.mjs'), SERVER_SCRIPT);
    await write(path.join(repoDir, 'app.cjs'), "const valid = require('./validator.cjs'); exports.app = require('node:http').createServer((_req, res) => res.end(JSON.stringify({ok:valid, role:process.env.ROLE, port:Number(process.env.PORT), frontend:process.env.FRONTEND_URL})));");
    await write(path.join(repoDir, 'validator.cjs'), 'module.exports = true;');
    await write(path.join(repoDir, 'AGENTS.md'), `# ${repo} instructions\nBe tidy.\n`);
    await write(path.join(workspace, 'AGENTS.md'), '# Workspace instructions\n');
    await fs.rm(path.join(repoDir, 'README.md'), { force: true });
    await import('node:child_process').then(({ execFile }) => new Promise<void>((resolve, reject) => {
      execFile('git', ['add', '.'], { cwd: repoDir }, (error) => (error ? reject(error) : resolve()));
    }));
    await import('node:child_process').then(({ execFile }) => new Promise<void>((resolve, reject) => {
      execFile('git', ['commit', '-m', 'fixture files'], { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } }, (error) => (error ? reject(error) : resolve()));
    }));
  }
  await write(
    path.join(workspace, 'gantry.yaml'),
    [
      'apiVersion: gantry.dev/v1',
      'project:',
      '  id: fixture',
      '  name: Fixture',
      '  defaultAgent: fake',
      '  branchPrefix: codex',
      '  portBase: 24000',
      '  portRange: 500',
      'repositories:',
      '  - id: frontend',
      '    path: frontend',
      '  - id: backend',
      '    path: backend',
      'services:',
      '  - id: frontend',
      '    repository: frontend',
      '    runtime: command',
      '    start: node server.mjs',
      '    healthUrl: http://127.0.0.1:${port}/health',
      '    env:',
      '      ROLE: frontend',
      '      BACKEND_URL: ${origin.backend}',
      '    dependsOn: [backend]',
      '  - id: backend',
      '    repository: backend',
      '    runtime: node',
      '    entry: app.cjs',
      '    healthUrl: http://127.0.0.1:${port}/health',
      '    env:',
      '      ROLE: backend',
      '      FRONTEND_URL: ${origin.frontend}',
    ].join('\n'),
  );
  return { workspace, dataDir, cleanup: outer.cleanup };
}

function makeApp(dataDir: string): GantryApp {
  process.env.GANTRY_DATA_DIR = dataDir;
  process.env.GANTRY_UI_DIR = '/nonexistent-gantry-ui';
  const ctx = createAppContext({ discoverIntervalMs: 500, remoteSyncIntervalMs: 3_600_000, serviceReadinessTimeoutMs: 20_000 });
  return new GantryApp(ctx);
}

async function previewRow(app: GantryApp, branch: string): Promise<{ id: string; status: string } | null> {
  const row = app.db.prepare('SELECT id, status FROM previews WHERE branch=?').get(branch) as { id: string; status: string } | undefined;
  return row ?? null;
}

async function waitUntilReady(app: GantryApp, previewId: string): Promise<Record<string, { state: string; port: number | null }>> {
  const deadline = Date.now() + 20_000;
  let snapshot: Record<string, { state: string; port: number | null }> = {};
  while (Date.now() < deadline) {
    await app.supervisor.tick();
    await app.supervisor.healthPass();
    const rows = app.db.prepare('SELECT service_id, state, port FROM preview_services WHERE preview_id=?').all(previewId) as { service_id: string; state: string; port: number | null }[];
    snapshot = Object.fromEntries(rows.map((row) => [row.service_id, { state: row.state, port: row.port }]));
    if (rows.length === 2 && rows.every((row) => row.state === 'ready')) {
      const response = await fetch(`http://127.0.0.1:${snapshot.frontend.port}/health`);
      const body = await response.json() as { backend: string };
      assert.equal(body.backend, `http://127.0.0.1:${snapshot.backend.port}`);
      return snapshot;
    }
    await delay(150);
  }
  const errors = app.db.prepare('SELECT service_id, error FROM preview_services WHERE preview_id=?').all(previewId) as { service_id: string; error: string | null }[];
  throw new Error(`services never became ready: ${JSON.stringify(snapshot)} errors: ${JSON.stringify(errors)}`);
}

describe('full fixture lifecycle', () => {
  test('ticket -> worktrees -> agent -> lock -> previews -> takeover -> recovery', async () => {
    const { workspace, dataDir } = await createFixtureWorkspace();
    const app = makeApp(dataDir);
    cleanups.push(async () => {
      app.jobs.stop();
      await until(async () => {
        try {
          return await app.supervisor.withIdleProject('fixture', async () => true);
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 409) return false;
          throw error;
        }
      }, 20_000, 'discovery finishes before closing the fixture database');
      for (const row of app.db.prepare('SELECT pid, pgid FROM runs WHERE pid IS NOT NULL').all() as { pid: number; pgid: number | null }[]) {
        if (row.pgid) await killGroup(row.pgid, row.pid);
      }
      const previews = app.db.prepare('SELECT id FROM previews').all() as { id: string }[];
      for (const preview of previews) await app.supervisor.stopPreview(preview.id).catch(() => {});
      app.db.close();
    });

    // --- registration + discovery ------------------------------------------
    const project = await app.addWorkspace(workspace);
    assert.equal(project.config.project.id, 'fixture');
    app.agents.adapters.set('fake', fakeAdapter());
    await until(async () => (await previewRow(app, '__primary__')) !== null, 10_000, 'primary preview discovered');
    const primary = (await previewRow(app, '__primary__'))!;
    assert.equal(primary.status, 'discovered', 'discovered previews stay stopped until used');

    // --- ticket + queued start ---------------------------------------------
    const ticket = app.tickets.create('fixture', { title: 'Build the thing', status: 'in_progress', scope: 'both' }, project.config.scopes.map((scope) => scope.id), project.config.project.branchPrefix);
    assert.equal(ticket.branch, 'codex/build-the-thing');
    const job = app.jobs.enqueue('start-ticket', {
      payload: { agentId: 'fake' },
      projectId: 'fixture',
      ticketId: ticket.id,
      dedupeKey: `start-ticket:${ticket.id}`,
    });
    app.jobs.start(25);
    await until(() => app.jobs.get(job.id)?.state === 'succeeded', 15_000, `start job should succeed: ${JSON.stringify(app.jobs.get(job.id))}`);

    // --- worktrees + run record --------------------------------------------
    const worktreeFrontend = path.join(workspace, '.worktrees', 'codex--build-the-thing', 'frontend');
    const worktreeBackend = path.join(workspace, '.worktrees', 'codex--build-the-thing', 'backend');
    await until(async () => (await fs.stat(path.join(worktreeFrontend, 'server.mjs')).then(() => true, () => false)), 5_000, 'frontend worktree created');
    await until(async () => (await fs.stat(path.join(worktreeBackend, 'package.json')).then(() => true, () => false)), 5_000, 'backend worktree created');

    const run = app.db.prepare('SELECT * FROM runs WHERE ticket_id=?').get(ticket.id) as { id: string; state: string; pid: number | null; pgid: number | null; pid_claim: string | null; session_id: string | null };
    assert.ok(run, 'run row exists');
    assert.equal(run.state, 'running');
    assert.ok(run.pid && run.pgid && run.pid_claim, 'pid/pgid/claim recorded');
    assert.equal(run.pgid, run.pid, 'detached child is its own process-group leader');
    trackedPids.push({ pid: run.pid!, pgid: run.pgid! });
    await until(() => (app.db.prepare('SELECT session_id FROM runs WHERE id=?').get(run.id) as { session_id: string | null }).session_id === 'sess-fixture-1', 5_000, 'session id parsed from agent output');
    assert.equal((app.tickets.get(ticket.id)!).active_run_id, run.id, 'ticket claims the run');

    // --- duplicate start is rejected by the atomic lock --------------------
    const duplicate = app.jobs.enqueue('start-ticket', { payload: { agentId: 'fake' }, projectId: 'fixture', ticketId: ticket.id, dedupeKey: `start-ticket:${ticket.id}` });
    await until(() => app.jobs.get(duplicate.id)?.state === 'failed', 10_000, 'duplicate start job fails');
    assert.match(app.jobs.get(duplicate.id)?.error ?? '', /already has an active agent run/);
    const runCount = (app.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE ticket_id=?').all(ticket.id) as { n: number }[])[0]!.n;
    assert.ok(runCount <= 2, `no extra run rows from the duplicate (got ${runCount})`);
    const processCount = trackedPids.length;
    assert.equal(processCount, 1, 'only one agent process was spawned');

    // --- preview services become ready on real ports -----------------------
    const services = await waitUntilReady(app, primary.id);
    const frontendPort = services['frontend']!.port!;
    const backendPort = services['backend']!.port!;
    assert.notEqual(frontendPort, backendPort);
    const frontendHealth = await (await fetch(`http://127.0.0.1:${frontendPort}/health`)).json() as { role: string; port: number };
    assert.deepEqual(frontendHealth, { ok: true, role: 'frontend', port: frontendPort, backend: `http://127.0.0.1:${backendPort}` });
    const backendHealth = await (await fetch(`http://127.0.0.1:${backendPort}/health`)).json() as { role: string; port: number };
    assert.deepEqual(backendHealth, { ok: true, role: 'backend', port: backendPort, frontend: `http://127.0.0.1:${frontendPort}` });

    // Managed runtimes must retain their process across discovery passes.
    const backendBefore = app.db.prepare("SELECT pid FROM preview_services WHERE preview_id=? AND service_id='backend'").get(primary.id) as { pid: number };
    await delay(1200);
    await waitUntilReady(app, primary.id);
    const backendAfter = app.db.prepare("SELECT pid FROM preview_services WHERE preview_id=? AND service_id='backend'").get(primary.id) as { pid: number };
    assert.equal(backendAfter.pid, backendBefore.pid, 'managed Node process is reused instead of duplicated');

    // An imported validator changes without restarting Gantry or the frontend.
    const frontendBefore = app.db.prepare("SELECT pid FROM preview_services WHERE preview_id=? AND service_id='frontend'").get(primary.id) as { pid: number };
    const validator = path.join(workspace, 'backend', 'validator.cjs');
    await write(validator + '.tmp', 'module.exports = false;');
    await fs.rename(validator + '.tmp', validator); // Editors often save via atomic replacement.
    await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${backendPort}/health`)).json() as {ok:boolean}).ok === false; }
      catch { return false; }
    }, 10_000, 'backend reloads imported source on the same port');
    const frontendAfter = app.db.prepare("SELECT pid FROM preview_services WHERE preview_id=? AND service_id='frontend'").get(primary.id) as { pid: number };
    assert.equal(frontendAfter.pid, frontendBefore.pid, 'source reload leaves frontend running');
    // The HTTP listener can be ready before Node's watch parent has processed
    // the restarted child's dependency subscriptions.
    await delay(1000);
    await write(validator, 'module.exports = true;');
    await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${backendPort}/health`)).json() as {ok:boolean}).ok === true; }
      catch { return false; }
    }, 10_000, 'subsequent source edits reload too');

    // Completing a ticket stops its branch services and removes its preview;
    // discovery must not restart it, while reopening makes it available again.
    const ticketPreview = await previewRow(app, ticket.branch);
    assert.ok(ticketPreview);
    await waitUntilReady(app, ticketPreview.id);
    app.tickets.update(ticket.id, { status: 'done' }, project.config.scopes.map(scope => scope.id), 'codex');
    await app.supervisor.stopDonePreviews();
    await app.supervisor.tick();
    await delay(1200);
    const stopped = app.db.prepare('SELECT pid FROM preview_services WHERE preview_id=?').all(ticketPreview.id) as { pid: number | null }[];
    assert.equal(stopped.length, 0, 'completed ticket has no supervised services');
    const completedStatus = await buildStatus(app);
    assert.ok(!(completedStatus['previews'] as { id: string }[]).some(preview => preview.id === ticketPreview.id));
    app.tickets.update(ticket.id, { status: 'in_progress' }, project.config.scopes.map(scope => scope.id), 'codex');
    await app.supervisor.tick();
    await waitUntilReady(app, ticketPreview.id);

    // Sticky ports across restarts.
    await app.supervisor.restartPreview(primary.id);
    const again = await waitUntilReady(app, primary.id);
    assert.equal(again['frontend']!.port, frontendPort, 'ports persist across restarts');

    // Main is always available, including after migrating old paused state.
    await assert.rejects(app.supervisor.setPaused(primary.id, true), /main preview/);
    await assert.rejects(app.supervisor.setArchived(primary.id, true), /main preview/);
    app.db.prepare('UPDATE previews SET paused=1, archived=1, retired=1 WHERE id=?').run(primary.id);
    await waitUntilReady(app, primary.id);
    await until(async () => {
      // This fixture has no discovery timer. A tick can be skipped while the
      // previous discovery is still running, even when services are ready.
      await app.supervisor.tick();
      const row = app.db.prepare('SELECT paused, archived, retired FROM previews WHERE id=?').get(primary.id) as {paused:number;archived:number;retired:number};
      return !row.paused && !row.archived && !row.retired;
    });

    // --- takeover interrupts the agent process group -----------------------
    const takeover = await app.agents.takeover(run.id, 1_500);
    assert.equal(takeover.ok, true, `takeover should succeed: ${takeover.error ?? ''}`);
    assert.equal(takeover.sessionId, 'sess-fixture-1');
    assert.equal(takeover.deepLink, null);
    const interrupted = app.db.prepare('SELECT state FROM runs WHERE id=?').get(run.id) as { state: string };
    assert.equal(interrupted.state, 'ready', 'run is ready for handoff after takeover');
    await until(() => {
      try {
        process.kill(run.pid!, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000, 'agent process group is dead after takeover');
    assert.equal((app.tickets.get(ticket.id)!).active_run_id, null, 'ticket lock released');
    // Takeover is idempotent once the run is finished.
    const second = await app.agents.takeover(run.id, 500);
    assert.equal(second.ok, true);

    // --- resume + restart the preview --------------------------------------
    await app.supervisor.setPaused(primary.id, false);
    const resumed = await waitUntilReady(app, primary.id);
    assert.equal(resumed['frontend']!.port, frontendPort, 'resume keeps the same port');

    // --- restart recovery: a fresh app adopts the running agent ------------
    const secondTicket = app.tickets.create('fixture', { title: 'Second run for recovery', status: 'in_progress' }, project.config.scopes.map((scope) => scope.id), 'codex');
    const job2 = app.jobs.enqueue('start-ticket', { payload: { agentId: 'fake', prompt: 'quiet run' }, projectId: 'fixture', ticketId: secondTicket.id, dedupeKey: `start-ticket:${secondTicket.id}` });
    await until(() => app.jobs.get(job2.id)?.state === 'succeeded', 15_000, `second start should succeed: ${JSON.stringify(app.jobs.get(job2.id))}`);
    const run2 = app.db.prepare('SELECT * FROM runs WHERE ticket_id=?').get(secondTicket.id) as { id: string; pid: number | null; pgid: number | null; state: string };
    trackedPids.push({ pid: run2.pid!, pgid: run2.pgid! });

    const app2 = makeApp(dataDir);
    await app2.agents.recoverAfterRestart();
    const recovered = app2.db.prepare('SELECT state FROM runs WHERE id=?').get(run2.id) as { state: string };
    assert.equal(recovered.state, 'running', 'live agent process is adopted after restart');

    // Kill the adopted agent externally; the next poll finalizes the run.
    await killGroup(run2.pgid!, run2.pid!);
    await app2.agents.pollAdopted();
    const finalized = app2.db.prepare('SELECT state FROM runs WHERE id=?').get(run2.id) as { state: string };
    assert.ok(['finished', 'failed', 'ready'].includes(finalized.state), `adopted run finalized, got ${finalized.state}`);
    assert.equal((app2.tickets.get(secondTicket.id)!).active_run_id, null, 'lock released for finalized adopted run');
    app2.db.close();

    // The new ticket's worktrees were created by the second start.
    await until(async () => (await fs.stat(path.join(workspace, '.worktrees', 'codex--second-run-for-recovery', 'frontend', 'package.json')).then(() => true, () => false)), 5_000, 'second ticket worktree exists');
  }, 90_000);
});
