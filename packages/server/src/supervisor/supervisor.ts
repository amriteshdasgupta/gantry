import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { idFor, interpolate, type ServiceConfig, type EnvironmentConfig } from '@gantry/shared';
import type { Database } from '../db/db.js';
import type { AppContext } from '../config/app.js';
import type { LoadedProject } from '../projects/registry.js';
import type { Logger } from '../log.js';
import { run, shellCommand, spawnDetached, type SpawnHandle } from '../util/exec.js';
import { PortAllocator } from '../ports/ports.js';
import { ensureMainCheckouts, discoverGroups, type PreviewGroup } from '../discover/discover.js';
import { buildServiceEnv, resolveServiceCommand } from './env.js';
import { ownsProcess, processAlive, interruptProcessGroup } from './processes.js';

/**
 * Service supervision. Desired state (which previews should run, with which
 * services on which ports) is reconciled from the database on every tick:
 *
 *  - previews that are merely discovered stay stopped
 *  - active previews get their services started in dependency order
 *  - services whose signature changed (command, env files, port, checkout,
 *    environment) are restarted
 *  - dead services restart with bounded backoff
 *  - paused/archived/retired previews are stopped and left alone
 *
 * The supervisor never deletes worktrees, never discards changes, and never
 * checks out different branches into existing worktrees.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export function packageRoot(): string {
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return path.dirname(here);
}

const runnersDir = (): string => path.join(packageRoot(), 'runners');

export type ServiceState = 'stopped' | 'installing' | 'starting' | 'ready' | 'failed';

interface ServiceRow {
  preview_id: string;
  service_id: string;
  state: ServiceState;
  pid: number | null;
  pgid: number | null;
  pid_claim: string | null;
  signature: string | null;
  port: number | null;
  started_at: string | null;
  error: string | null;
  retry_after: string | null;
}

interface PreviewRow {
  id: string;
  project_id: string;
  branch: string;
  is_primary: number;
  status: string;
  environment: string | null;
  paused: number;
  archived: number;
  retired: number;
  removed: number;
  ticket_id: string | null;
  merge_evidence: string | null;
}

export class Supervisor {
  private readonly log: Logger;
  private readonly allocator: PortAllocator;
  private readonly ticking = new Set<string>();

  async withIdleProject<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    if (this.ticking.has(projectId)) throw Object.assign(new Error('Preview discovery is busy. Retry shortly.'), { statusCode: 409 });
    this.ticking.add(projectId);
    try {
      return await action();
    } finally {
      this.ticking.delete(projectId);
    }
  }

  constructor(
    private readonly ctx: AppContext,
    private readonly db: Database,
    private readonly projects: () => Promise<LoadedProject[]>,
    parentLog: Logger,
  ) {
    this.log = parentLog.child('supervisor');
    this.allocator = new PortAllocator(db);
  }

  private serviceRow(previewId: string, serviceId: string): ServiceRow | null {
    return (this.db.prepare('SELECT * FROM preview_services WHERE preview_id=? AND service_id=?').get(previewId, serviceId) as ServiceRow | undefined) ?? null;
  }

  previewRow(previewId: string): PreviewRow | null {
    return (this.db.prepare('SELECT * FROM previews WHERE id=?').get(previewId) as PreviewRow | undefined) ?? null;
  }

  private saveServiceRow(previewId: string, serviceId: string, values: Partial<ServiceRow>): void {
    const current = this.serviceRow(previewId, serviceId);
    const merged = {
      state: values.state ?? current?.state ?? 'stopped',
      pid: values.pid ?? null,
      pgid: values.pgid ?? null,
      pid_claim: values.pid_claim ?? null,
      signature: values.signature ?? null,
      port: values.port ?? current?.port ?? null,
      started_at: values.started_at ?? null,
      error: values.error ?? null,
      retry_after: values.retry_after ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO preview_services (preview_id, service_id, state, pid, pgid, pid_claim, signature, port, started_at, error, retry_after, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(preview_id, service_id) DO UPDATE SET
           state=excluded.state, pid=excluded.pid, pgid=excluded.pgid, pid_claim=excluded.pid_claim,
           signature=excluded.signature, port=COALESCE(excluded.port, preview_services.port),
           started_at=excluded.started_at, error=excluded.error, retry_after=excluded.retry_after, updated_at=excluded.updated_at`,
      )
      .run(
        previewId,
        serviceId,
        merged.state,
        merged.pid,
        merged.pgid,
        merged.pid_claim,
        merged.signature,
        merged.port,
        merged.started_at,
        merged.error,
        merged.retry_after,
        new Date().toISOString(),
      );
  }

  // ---------------------------------------------------------------- stop paths

  async stopService(previewId: string, serviceId: string): Promise<void> {
    const key = `${previewId}:${serviceId}`;
    const row = this.serviceRow(previewId, serviceId);
    if (row?.pid && row?.pgid !== null && row.pid_claim) {
      if (await ownsProcess(row.pid, row.pgid, row.pid_claim)) {
        await interruptProcessGroup(row.pid, row.pgid, row.pid_claim, 3_000);
        this.log.info(`Stopped ${key}`);
      } else {
        this.log.warn(`${key}: recorded pid ${row.pid} is no longer ours; leaving it alone`);
      }
    } else if (row?.pid) {
      if (await processAlive(row.pid)) {
        this.log.warn(`${key}: recorded pid ${row.pid} has no ownership claim; leaving it alone`);
      }
    }
    this.db.prepare('DELETE FROM preview_services WHERE preview_id=? AND service_id=?').run(previewId, serviceId);
  }

  async stopPreview(previewId: string): Promise<void> {
    const rows = this.db.prepare('SELECT service_id FROM preview_services WHERE preview_id=?').all(previewId) as { service_id: string }[];
    for (const row of rows) await this.stopService(previewId, row.service_id);
  }

  isDonePreview(previewId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM previews p JOIN tickets t
      ON t.project_id=p.project_id AND (t.id=p.ticket_id OR t.branch=p.branch)
      WHERE p.id=? AND p.is_primary=0 AND t.status='done' LIMIT 1`).get(previewId));
  }

  async stopDonePreviews(): Promise<void> {
    const rows = this.db.prepare('SELECT id FROM previews WHERE is_primary=0').all() as { id: string }[];
    for (const row of rows) if (this.isDonePreview(row.id)) await this.stopPreview(row.id);
  }

  // ---------------------------------------------------------------- main tick

  async tick(): Promise<void> {
    for (const project of await this.projects()) {
      if (this.ticking.has(project.config.project.id)) continue;
      this.ticking.add(project.config.project.id);
      void this.tickProject(project).finally(() => this.ticking.delete(project.config.project.id));
    }
  }

  private async tickProject(project: LoadedProject): Promise<void> {
    let groups: PreviewGroup[];
    try {
      await ensureMainCheckouts(project);
      groups = await discoverGroups(project);
    } catch (error) {
      this.log.warn(`${project.config.project.id}: discovery failed: ${(error as Error).message}`);
      return;
    }
    const seen = new Set<string>();
    for (const group of groups) {
      seen.add(group.id);
      await this.reconcilePreview(project, group);
    }
    const rows = this.db.prepare('SELECT id, branch FROM previews WHERE project_id=?').all(project.config.project.id) as { id: string; branch: string }[];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const active = this.db.prepare('SELECT COUNT(*) AS n FROM preview_services WHERE preview_id=?').get(row.id) as { n: number };
      if (Number(active.n) > 0) {
        await this.stopPreview(row.id);
        this.db.prepare("UPDATE previews SET status='gone', updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
        this.log.info(`${row.branch}: worktree no longer exists; services stopped`);
      } else {
        this.db.prepare("UPDATE previews SET status='gone', updated_at=? WHERE id=? AND status NOT IN ('gone')").run(new Date().toISOString(), row.id);
      }
    }
  }

  private async reconcilePreview(project: LoadedProject, group: PreviewGroup): Promise<void> {
    const config = project.config;
    const now = new Date().toISOString();
    const existing = this.previewRow(group.id);
    if (!existing) {
      this.db
        .prepare(`INSERT INTO previews (id, project_id, branch, is_primary, status, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)`)
        .run(group.id, group.projectId, group.branchKey, group.isPrimary ? 1 : 0, now, now, now);
    } else if (existing.status === 'gone') {
      this.db.prepare("UPDATE previews SET status='discovered', last_seen_at=?, updated_at=? WHERE id=?").run(now, now, group.id);
    } else {
      this.db.prepare('UPDATE previews SET last_seen_at=?, updated_at=updated_at WHERE id=?').run(now, group.id);
    }
    if (group.isPrimary) await this.restorePreview(group.id);
    const row = this.previewRow(group.id)!;
    this.syncCheckouts(group);

    if (this.isDonePreview(row.id) || row.paused || row.archived || row.removed || row.retired) {
      await this.stopPreview(group.id);
      const status = this.isDonePreview(row.id) ? 'Done' : row.retired ? 'Merged' : row.removed ? 'Removed' : row.archived ? 'Archived' : 'Paused';
      this.db.prepare('UPDATE previews SET status=?, updated_at=? WHERE id=?').run(status, now, group.id);
      return;
    }

    const available = config.services.filter((service) => group.checkouts.some((checkout) => checkout.repositoryId === service.repository));
    // Reserve every address before starting services. URL references may point
    // back to a caller without creating a readiness dependency cycle.
    for (const service of available) {
      const current = this.serviceRow(group.id, service.id);
      if (current?.port && current.pid && current.pgid !== null && current.pid_claim && await ownsProcess(current.pid, current.pgid, current.pid_claim)) continue;
      try {
        await this.allocator.allocate(project.config.project.id, group.id, service.id, config.project.portBase, config.project.portRange, service.port);
      } catch (error) {
        this.saveServiceRow(group.id, service.id, { state: 'failed', error: (error as Error).message });
      }
    }
    const desired = available.filter(service => !service.whenFile || fs.existsSync(path.resolve(group.checkouts.find(c => c.repositoryId === service.repository)!.path, service.whenFile)));
    for (const service of topologicalOrder(desired)) {
      const checkout = group.checkouts.find((candidate) => candidate.repositoryId === service.repository)!;
      await this.reconcileService(project, row, service, checkout);
    }
    for (const current of this.db.prepare('SELECT service_id FROM preview_services WHERE preview_id=?').all(group.id) as { service_id: string }[]) {
      if (!desired.some((service) => service.id === current.service_id)) await this.stopService(group.id, current.service_id);
    }
    const states = desired.map((service) => this.serviceRow(group.id, service.id)?.state ?? 'stopped');
    const status = states.length && states.every((state) => state === 'ready') ? 'Running' : states.some((state) => state === 'failed') ? 'Needs attention' : 'Starting';
    this.db.prepare('UPDATE previews SET status=?, updated_at=? WHERE id=?').run(status, now, group.id);
  }

  private syncCheckouts(group: PreviewGroup): void {
    const now = new Date().toISOString();
    for (const checkout of group.checkouts) {
      this.db
        .prepare(
          `INSERT INTO preview_checkouts (preview_id, repository_id, path, head, branch, is_fallback, is_primary, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(preview_id, repository_id) DO UPDATE SET path=excluded.path, head=excluded.head, branch=excluded.branch,
             is_fallback=excluded.is_fallback, is_primary=excluded.is_primary, updated_at=excluded.updated_at`,
        )
        .run(group.id, checkout.repositoryId, checkout.path, checkout.head, checkout.branch, checkout.isFallback ? 1 : 0, checkout.isPrimary ? 1 : 0, now);
    }
  }

  // ---------------------------------------------------------------- services

  private environmentFor(config: LoadedProject['config'], row: PreviewRow): EnvironmentConfig | null {
    const id = row.environment ?? config.environments.find((env) => env.default)?.id ?? config.environments[0]?.id ?? null;
    if (!id) return null;
    return config.environments.find((env) => env.id === id) ?? null;
  }

  private dependencyVars(previewId: string, service: ServiceConfig): Record<string, string> {
    const vars: Record<string, string> = {};
    const references = new Set(service.dependsOn);
    for (const value of Object.values(service.env)) {
      for (const match of value.matchAll(/\$\{(?:origin|port)\.([a-z][a-z0-9-]*)\}/g)) references.add(match[1]!);
    }
    for (const id of references) {
      const allocation = this.db.prepare('SELECT port FROM port_allocations WHERE preview_id=? AND service_id=?').get(previewId, id) as { port: number } | undefined;
      const port = allocation?.port;
      if (!port) continue;
      vars[`port.${id}`] = String(port);
      vars[`origin.${id}`] = `http://127.0.0.1:${port}`;
    }
    return vars;
  }

  private async serviceSignature(
    project: LoadedProject,
    previewId: string,
    checkoutPath: string,
    service: ServiceConfig,
    port: number,
    environment: EnvironmentConfig | null,
  ): Promise<string> {
    const hash = createHash('sha256');
    if (service.runtime === 'vite') {
      for (const file of ['vite-runner.cjs', 'preview-diagnostics.js']) hash.update(await fsp.readFile(path.join(runnersDir(), file)));
    }
    if (service.runtime === 'node') {
      hash.update('node-watch-v1');
      hash.update(await fsp.readFile(path.join(runnersDir(), 'node-runner.cjs')));
    }
    hash.update(JSON.stringify({ service, port, environment, dependencies: this.dependencyVars(previewId, service) }));
    const repoPath = path.resolve(project.workspace, project.config.repositories.find((repo) => repo.id === service.repository)?.path ?? '.');
    for (const dir of new Set([checkoutPath, repoPath])) {
      for (const file of service.envFiles) {
        try {
          const stat = await fsp.stat(path.resolve(dir, file));
          hash.update(`${dir}/${file}:${stat.mtimeMs}:${stat.size}`);
        } catch {
          /* file absent */
        }
      }
    }
    if (environment) {
      for (const envFile of Object.values(environment.envFiles)) {
        try {
          const stat = await fsp.stat(path.resolve(project.workspace, envFile));
          hash.update(`${envFile}:${stat.mtimeMs}:${stat.size}`);
        } catch {
          /* private env file absent */
        }
      }
    }
    return idFor(hash.digest('hex'));
  }

  private async reconcileService(project: LoadedProject, preview: PreviewRow, service: ServiceConfig, checkout: { repositoryId: string; path: string; head: string }): Promise<void> {
    const now = new Date().toISOString();
    const row = this.serviceRow(preview.id, service.id);
    const environment = this.environmentFor(project.config, preview);

    let ownedPort: number | null = null;
    // Healthy and current: nothing to do. This must run BEFORE port
    // allocation — the service's own listener would make its sticky port
    // look "occupied", causing a reallocation, a signature change, and an
    // endless restart loop.
    if (row?.port && row.pid && row.pgid !== null && row.pid_claim && (await ownsProcess(row.pid, row.pgid, row.pid_claim))) {
      ownedPort = row.port;
      const signatureAtCurrentPort = await this.serviceSignature(project, preview.id, checkout.path, service, row.port, environment);
      if (row.signature === signatureAtCurrentPort) return;
    }

    let port: number;
    try {
      port = ownedPort ?? await this.allocator.allocate(project.config.project.id, preview.id, service.id, project.config.project.portBase, project.config.project.portRange, service.port);
    } catch (error) {
      this.saveServiceRow(preview.id, service.id, { state: 'failed', error: (error as Error).message, pid: null, pgid: null, pid_claim: null });
      return;
    }

    const signature = await this.serviceSignature(project, preview.id, checkout.path, service, port, environment);

    // Exited moments after starting: back off instead of thrashing.
    if (row?.retry_after && Date.parse(row.retry_after) > Date.now()) return;

    // Dependencies must be ready before this service starts (or restarts).
    const depsReady = service.dependsOn.every((dep) => this.serviceRow(preview.id, dep)?.state === 'ready');
    if (!depsReady) {
      if (row?.signature !== signature) {
        // Stop the stale instance only when its configuration changed; a
        // healthy service waits for its dependency instead of flapping.
        await this.stopService(preview.id, service.id);
        this.saveServiceRow(preview.id, service.id, { state: 'stopped', error: `waiting for ${service.dependsOn.join(', ')}`, signature });
      }
      return;
    }

    if (row) await this.stopService(preview.id, service.id);
    try {
      const install = resolveServiceCommand(service, 'install', { port: String(port) });
      if (install) {
        this.saveServiceRow(preview.id, service.id, { state: 'installing', error: null, port, signature });
        await this.runInstall(project, preview.id, service, checkout, install);
      }
      await this.spawnService(project, preview, service, checkout, port, environment, signature);
    } catch (error) {
      this.log.warn(`${preview.id}:${service.id}: ${(error as Error).message}`);
      this.saveServiceRow(preview.id, service.id, {
        state: 'failed',
        error: (error as Error).message,
        retry_after: new Date(Date.now() + 60_000).toISOString(),
        pid: null,
        pgid: null,
        pid_claim: null,
      });
    }
    void now;
  }

  private async runInstall(
    project: LoadedProject,
    previewId: string,
    service: ServiceConfig,
    checkout: { repositoryId: string; path: string },
    install: { kind: 'shell'; value: string } | { kind: 'argv'; value: string[] },
  ): Promise<void> {
    const stampFile = path.join(this.ctx.dataDir, 'installs', `${idFor(`${checkout.path}:${service.id}`)}.json`);
    if (await fsp.stat(stampFile).then(
      () => true,
      () => false,
    )) {
      return; // already installed for this checkout + service
    }
    // Never run an install underneath a live service that shares the checkout.
    const sharers = this.db
      .prepare(
        `SELECT ps.preview_id, ps.service_id FROM preview_services ps
         JOIN preview_checkouts pc ON pc.preview_id = ps.preview_id AND pc.path = ?
         WHERE ps.state IN ('starting','ready','installing')`,
      )
      .all(checkout.path) as { preview_id: string; service_id: string }[];
    const live = sharers.find((sharer) => sharer.preview_id !== previewId);
    if (live) {
      throw new Error(`Dependencies for ${checkout.path} changed while ${live.service_id} (preview ${live.preview_id}) is running. Stop that preview first, then retry.`);
    }
    const started = Date.now();
    const commandText = install.kind === 'shell' ? install.value : (install.value as string[]).join(' ');
    this.log.info(`${previewId}:${service.id}: installing (${commandText})`);
    if (install.kind === 'shell') await run(...shellCommand(install.value), { cwd: checkout.path, timeoutMs: 900_000 });
    else await run(String((install.value as string[])[0]), (install.value as string[]).slice(1), { cwd: checkout.path, timeoutMs: 900_000 });
    await fsp.mkdir(path.dirname(stampFile), { recursive: true, mode: 0o700 });
    await fsp.writeFile(stampFile, JSON.stringify({ installedAt: new Date().toISOString(), ms: Date.now() - started }), { mode: 0o600 });
    this.log.info(`${previewId}:${service.id}: install finished in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  private async spawnService(
    project: LoadedProject,
    preview: PreviewRow,
    service: ServiceConfig,
    checkout: { repositoryId: string; path: string },
    port: number,
    environment: EnvironmentConfig | null,
    signature: string,
  ): Promise<void> {
    if (this.isDonePreview(preview.id)) return;
    const workDir = path.resolve(checkout.path, service.workDir);
    const logFile = path.join(this.ctx.logsDir, `${preview.id}-${service.id}.log`);
    await fsp.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
    await rotateLog(logFile);
    const vars: Record<string, string> = {
      ...this.dependencyVars(preview.id, service),
      workspace: project.workspace,
      'project.id': project.config.project.id,
      branch: preview.branch,
      port: String(port),
      [`repo.${checkout.repositoryId}`]: checkout.path,
      [`path.${service.id}`]: checkout.path,
    };

    for (const hook of service.hooks.preStart) {
      const command = hook.kind === 'argv' ? hook : { kind: 'shell' as const, value: interpolate(hook.value, vars) };
      if (command.kind === 'shell') await run(...shellCommand(command.value), { cwd: workDir, timeoutMs: 120_000 });
      else await run(String((command.value as string[])[0]), (command.value as string[]).slice(1), { cwd: workDir, timeoutMs: 120_000 });
    }

    const env = await buildServiceEnv({
      project: project.config,
      workspace: project.workspace,
      checkoutPath: checkout.path,
      primaryPath: primaryPathOf(project, checkout.repositoryId),
      service,
      port,
      environment,
      vars,
    });
    const readyFile = path.join(this.ctx.dataDir, 'ready', `${preview.id}-${service.id}.json`);
    await fsp.mkdir(path.dirname(readyFile), { recursive: true, mode: 0o700 });
    await fsp.rm(readyFile, { force: true });

    const runtimeEnv: NodeJS.ProcessEnv = {
      ...env,
      GANTRY_CHECKOUT: checkout.path,
      GANTRY_PREVIEW_ID: preview.id,
      GANTRY_DATA_DIR: this.ctx.dataDir,
      GANTRY_READY_FILE: readyFile,
      GANTRY_BANNER: service.banner?.enabled ? '1' : '0',
      GANTRY_BANNER_TITLE: preview.branch === '__primary__' ? 'Main preview' : preview.branch.split('/').pop() ?? preview.branch,
      GANTRY_BANNER_BRANCH: preview.branch,
      GANTRY_BANNER_WARNING: 'Shared data',
    };
    if (service.banner?.autoLogin) {
      const credentialsFile = path.join(this.ctx.dataDir, 'preview-login.json');
      if (fs.existsSync(credentialsFile) && service.entry) {
        runtimeEnv.GANTRY_LOGIN_CREDENTIALS_FILE = credentialsFile;
        runtimeEnv.GANTRY_LOGIN_MODULE = path.resolve(checkout.path, service.entry as string);
      }
    }

    const runners = runnersDir();
    let argv: string[];
    if (service.runtime === 'vite') {
      argv = [process.execPath, path.join(runners, 'vite-runner.cjs')];
    } else if (service.runtime === 'node') {
      if (!service.entry) throw new Error(`service ${service.id}: runtime "node" requires an "entry" module`);
      runtimeEnv.GANTRY_ENTRY = service.entry;
      argv = [process.execPath, ...(service.watch === false ? [] : ['--watch', '--watch-preserve-output']), path.join(runners, 'node-runner.cjs')];
    } else if (service.runtime === 'python') {
      if (!service.entry) throw new Error(`service ${service.id}: runtime "python" requires an "entry" module name`);
      runtimeEnv.GANTRY_ENTRY = service.entry;
      const python = await pythonFor(checkout.path, primaryPathOf(project, service.repository));
      argv = [python, '-u', path.join(runners, 'flask-runner.py')];
    } else {
      const command = resolveServiceCommand(service, 'start', vars);
      if (!command) throw new Error(`service ${service.id} has no start command`);
      argv = command.kind === 'argv' ? [String((command.value as string[])[0]), ...(command.value as string[]).slice(1)] : (() => { const [bin, args] = shellCommand(String(command.value)); return [bin, ...args]; })();
    }

    const fd = fs.openSync(logFile, 'a', 0o600);
    let handle: SpawnHandle;
    try {
      handle = spawnDetached(argv[0]!, argv.slice(1), { cwd: workDir, env: runtimeEnv, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }

    // Detect instant death (bad binary, syntax error) so the UI can show it now.
    const earlyExit = await Promise.race([handle.exited.then((code) => ({ code })), new Promise<null>((resolve) => setTimeout(() => resolve(null), 400))]);
    if (earlyExit && earlyExit.code !== 0) {
      throw new Error(`${service.id} exited immediately with code ${earlyExit.code}. Check ${path.basename(logFile)}`);
    }

    // Claim = the command text ps will show after `sh -c` execs into the real
    // process (or for argv form, the argv itself). Verification matches
    // pgid + this text, so recorded pids can never be mistaken for ours.
    const startCommand = resolveServiceCommand(service, 'start', vars);
    const claim = (service.runtime === 'command'
      ? (startCommand?.kind === 'argv' ? startCommand.value.join(' ') : String(startCommand?.value ?? ''))
      : argv.join(' ')).slice(0, 200);
    void this.runPostStartHooks(service, workDir, vars).catch((error) => this.log.warn(`${preview.id}:${service.id}: postStart hook failed: ${(error as Error).message}`));
    this.saveServiceRow(preview.id, service.id, {
      state: 'starting',
      pid: handle.pid,
      pgid: handle.pgid,
      pid_claim: handle.claim ?? claim,
      signature,
      port,
      started_at: new Date().toISOString(),
      error: null,
      retry_after: null,
    });
    this.log.info(`Started ${project.config.project.name} ${service.id} (${preview.branch}) on port ${port}`);
    void this.watchChild(preview, service, handle);
    if (this.isDonePreview(preview.id)) await this.stopPreview(preview.id);
  }

  private async watchChild(preview: PreviewRow, service: ServiceConfig, handle: SpawnHandle): Promise<void> {
    const code = await handle.exited;
    const row = this.serviceRow(preview.id, service.id);
    if (!row || row.pid !== handle.pid) return; // replaced or stopped intentionally
    const live = this.previewRow(preview.id);
    if (live && !this.isDonePreview(live.id) && !live.paused && !live.archived && !live.removed && !live.retired) {
      const lifetime = row.started_at ? Date.now() - Date.parse(row.started_at) : Number.MAX_SAFE_INTEGER;
      const startup = lifetime < 60_000;
      this.saveServiceRow(preview.id, service.id, {
        state: 'failed',
        error: startup ? `${service.id} exited during startup (code ${code}). Check its logs; retrying within a minute.` : `${service.id} exited (code ${code}).`,
        pid: null,
        pgid: null,
        pid_claim: null,
        retry_after: startup ? new Date(Date.now() + 60_000).toISOString() : null,
      });
      this.log.warn(`${preview.id}:${service.id}: exited with code ${code}`);
    }
  }

  private async runPostStartHooks(service: ServiceConfig, cwd: string, vars: Record<string, string>): Promise<void> {
    for (const hook of service.hooks.postStart) {
      const command = hook.kind === 'argv' ? hook : { kind: 'shell' as const, value: interpolate(hook.value, vars) };
      if (command.kind === 'shell') await run(...shellCommand(command.value), { cwd, timeoutMs: 120_000 });
      else await run(String((command.value as string[])[0]), (command.value as string[]).slice(1), { cwd, timeoutMs: 120_000 });
    }
  }

  // ---------------------------------------------------------------- health

  /** Fast readiness pass for `starting` services (runs every couple seconds). */
  async healthPass(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM preview_services WHERE state='starting'").all() as unknown as ServiceRow[];
    for (const row of rows) {
      const alive =
        row.pid && row.pgid !== null && row.pid_claim ? await ownsProcess(row.pid, row.pgid, row.pid_claim) : row.pid ? await processAlive(row.pid) : false;
      if (!alive) continue; // watchChild handles exit transitions
      const preview = this.previewRow(row.preview_id);
      const service = preview ? await this.serviceConfigFor(preview, row) : null;
      const readyFile = path.join(this.ctx.dataDir, 'ready', `${row.preview_id}-${row.service_id}.json`);
      const marked = await fsp
        .stat(readyFile)
        .then(
          () => true,
          () => false,
        )
        .catch(() => false);
      let ready = marked;
      if (!ready && service?.healthUrl && row.port) {
        ready = await probe(interpolate(service.healthUrl, { port: String(row.port) }));
      }
      if (!ready && !service?.healthUrl && row.started_at) {
        // No probe configured: ready once the process has survived 5 seconds.
        ready = Date.now() - Date.parse(row.started_at) > 5_000;
      }
      if (ready) {
        this.db.prepare("UPDATE preview_services SET state='ready', error=NULL, updated_at=? WHERE preview_id=? AND service_id=?").run(new Date().toISOString(), row.preview_id, row.service_id);
      } else if (row.started_at && Date.now() - Date.parse(row.started_at) > this.ctx.settings.serviceReadinessTimeoutMs) {
        this.saveServiceRow(row.preview_id, row.service_id, {
          state: 'failed',
          error: `${row.service_id} did not become ready within ${Math.round(this.ctx.settings.serviceReadinessTimeoutMs / 1000)}s — check its logs`,
        });
      }
    }
  }

  private async serviceConfigFor(preview: PreviewRow, row: ServiceRow): Promise<ServiceConfig | null> {
    for (const project of await this.projects()) {
      if (project.config.project.id !== preview.project_id) continue;
      return project.config.services.find((service) => service.id === row.service_id) ?? null;
    }
    return null;
  }

  // ---------------------------------------------------------------- actions

  async setEnvironment(previewId: string, environmentId: string): Promise<void> {
    this.db.prepare('UPDATE previews SET environment=?, updated_at=? WHERE id=?').run(environmentId, new Date().toISOString(), previewId);
    await this.stopPreview(previewId);
    this.db.prepare('UPDATE preview_services SET signature=NULL, updated_at=? WHERE preview_id=?').run(new Date().toISOString(), previewId);
  }

  async restartPreview(previewId: string): Promise<void> {
    await this.stopPreview(previewId);
    this.db.prepare('UPDATE preview_services SET signature=NULL, retry_after=NULL, updated_at=? WHERE preview_id=?').run(new Date().toISOString(), previewId);
  }

  async setPaused(previewId: string, paused: boolean): Promise<void> {
    if (paused && this.previewRow(previewId)?.is_primary) throw new Error("The main preview stays running while Gantry is open.");
    this.db.prepare('UPDATE previews SET paused=?, updated_at=? WHERE id=?').run(paused ? 1 : 0, new Date().toISOString(), previewId);
    if (paused) await this.stopPreview(previewId);
  }

  async setArchived(previewId: string, archived: boolean): Promise<void> {
    if (archived && this.previewRow(previewId)?.is_primary) throw new Error("The main preview cannot be archived.");
    this.db.prepare('UPDATE previews SET archived=?, removed=0, updated_at=? WHERE id=?').run(archived ? 1 : 0, new Date().toISOString(), previewId);
    if (archived) {
      await this.stopPreview(previewId);
      this.allocator.release(previewId);
    }
  }

  async setRetired(previewId: string, retired: boolean): Promise<void> {
    if (retired && this.previewRow(previewId)?.is_primary) return;
    this.db.prepare('UPDATE previews SET retired=?, updated_at=? WHERE id=?').run(retired ? 1 : 0, new Date().toISOString(), previewId);
    if (retired) await this.stopPreview(previewId);
  }

  async restorePreview(previewId: string): Promise<void> {
    this.db.prepare('UPDATE previews SET archived=0, removed=0, paused=0, retired=0, updated_at=? WHERE id=?').run(new Date().toISOString(), previewId);
  }

  async retryDependencies(previewId: string): Promise<void> {
    const checkouts = this.db.prepare('SELECT path, repository_id FROM preview_checkouts WHERE preview_id=?').all(previewId) as { path: string; repository_id: string }[];
    const services = this.db.prepare('SELECT service_id FROM preview_services WHERE preview_id=?').all(previewId) as { service_id: string }[];
    for (const checkout of checkouts) {
      for (const service of services) {
        await fsp.rm(path.join(this.ctx.dataDir, 'installs', `${idFor(`${checkout.path}:${service.service_id}`)}.json`), { force: true });
      }
    }
    await this.restartPreview(previewId);
  }

  /** Startup recovery: keep managed processes we can verify, forget the rest. */
  async recoverAfterRestart(): Promise<void> {
    const rows = this.db.prepare('SELECT * FROM preview_services').all() as unknown as ServiceRow[];
    for (const row of rows) {
      const owned = row.pid && row.pgid !== null && row.pid_claim !== null && (await ownsProcess(row.pid, row.pgid, row.pid_claim));
      if (owned) {
        this.log.info(`Recovered ${row.preview_id}:${row.service_id} (pid ${row.pid} still running)`);
        this.db.prepare("UPDATE preview_services SET state='starting', updated_at=? WHERE preview_id=? AND service_id=?").run(new Date().toISOString(), row.preview_id, row.service_id);
      } else {
        this.db.prepare('DELETE FROM preview_services WHERE preview_id=? AND service_id=?').run(row.preview_id, row.service_id);
      }
    }
  }

  /** Managed services intentionally survive a Gantry restart (detached groups, re-verified on start). */
  async shutdown(): Promise<void> {}
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function rotateLog(file: string): Promise<void> {
  try {
    const stat = await fsp.stat(file);
    if (stat.size > 5_000_000) {
      await fsp.copyFile(file, `${file}.previous`);
      await fsp.truncate(file, 0); // preserve open O_APPEND descriptors in running children
    }
  } catch {
    /* first run */
  }
}

function primaryPathOf(project: LoadedProject, repositoryId: string): string | null {
  const repo = project.config.repositories.find((candidate) => candidate.id === repositoryId);
  if (!repo) return null;
  return path.resolve(project.workspace, repo.path);
}

async function pythonFor(checkoutPath: string, primaryPath: string | null): Promise<string> {
  const candidates = [checkoutPath, primaryPath].filter(Boolean) as string[];
  for (const dir of candidates) {
    const python = path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (
      await fsp.stat(python).then(
        () => true,
        () => false,
      )
    ) {
      return python;
    }
  }
  throw new Error(`Python services need a virtual environment: create .venv in ${checkoutPath}`);
}

/** Topological order honoring dependsOn; cycles are rejected by config validation. */
export function topologicalOrder(services: ServiceConfig[]): ServiceConfig[] {
  const byId = new Map(services.map((service) => [service.id, service]));
  const done = new Set<string>();
  const order: ServiceConfig[] = [];
  const visit = (service: ServiceConfig, stack: Set<string>): void => {
    if (done.has(service.id) || stack.has(service.id)) return;
    stack.add(service.id);
    for (const dep of service.dependsOn) {
      const target = byId.get(dep);
      if (target) visit(target, stack);
    }
    stack.delete(service.id);
    done.add(service.id);
    order.push(service);
  };
  for (const service of services) visit(service, new Set());
  return order;
}
