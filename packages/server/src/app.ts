import path from 'node:path';
import { createAppContext, type AppContext } from './config/app.js';
import { openDatabase, type Database } from './db/db.js';
import { createLogger, type Logger } from './log.js';
import { GANTRY_VERSION } from './version.js';
import { loadProject, listRegisteredWorkspaces, registerProjectRow, type LoadedProject } from './projects/registry.js';
import { Supervisor } from './supervisor/supervisor.js';
import { RemoteSync } from './discover/remote-sync.js';
import { VcsStore } from './discover/vcs.js';
import { JobQueue } from './jobs/queue.js';
import { TicketStore } from './tickets/store.js';
import { AgentRegistry } from './agents/registry.js';
import { PortAllocator } from './ports/ports.js';
import { createStartTicketHandler } from './jobs/handlers/start-ticket.js';
import { createHttpServer } from './http/server.js';

/**
 * Gantry application core: owns the database, the project registry, the
 * supervisor, the agent registry, the job queue and the remote sync loop.
 * The HTTP layer is a thin consumer of this object.
 */

export class GantryApp {
  readonly ctx: AppContext;
  readonly db: Database;
  readonly log: Logger;
  readonly supervisor: Supervisor;
  readonly agents: AgentRegistry;
  readonly tickets: TicketStore;
  readonly jobs: JobQueue;
  readonly ports: PortAllocator;
  readonly remote: RemoteSync;
  readonly startedAt = Date.now();
  readonly cleanupProjects = new Set<string>();

  private discoverTimer: NodeJS.Timeout | null = null;
  private remoteTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private adoptedTimer: NodeJS.Timeout | null = null;

  constructor(ctx?: AppContext) {
    this.ctx = ctx ?? createAppContext();
    this.log = createLogger({ level: 'info', file: `${this.ctx.logDir}/../server.log` });
    this.db = openDatabase(this.ctx.dbFile);
    this.supervisor = new Supervisor(this.ctx, this.db, () => this.projects(), this.log);
    this.agents = new AgentRegistry(this.ctx, this.db, this.log);
    this.tickets = new TicketStore(this.db);
    this.ports = new PortAllocator(this.db);
    this.jobs = new JobQueue(this.db, this.log);
    this.remote = new RemoteSync(this.db, () => this.projects(), this.log, (branches) => this.completeTickets(branches), new VcsStore(path.join(this.ctx.dataDir, 'vcs-credentials.json')));
    this.registerJobHandlers();
  }

  /** Load every registered workspace's current config (YAML is the source of truth). */
  async projects(): Promise<LoadedProject[]> {
    const workspaces = listRegisteredWorkspaces(this.db);
    const loaded: LoadedProject[] = [];
    for (const workspace of workspaces) {
      try {
        loaded.push(await loadProject(workspace));
      } catch (error) {
        this.log.warn(`project at ${workspace} failed to load: ${(error as Error).message}`);
      }
    }
    return loaded;
  }

  async loadProjectById(projectId: string): Promise<LoadedProject> {
    const projects = await this.projects();
    const project = projects.find((candidate) => candidate.config.project.id === projectId);
    if (!project) throw Object.assign(new Error(`Unknown project "${projectId}"`), { statusCode: 404 });
    return project;
  }

  async addWorkspace(workspace: string): Promise<LoadedProject> {
    const project = await loadProject(workspace);
    registerProjectRow(this.db, project);
    this.log.info(`Registered project ${project.config.project.id} at ${project.workspace}`);
    await this.supervisor.tick();
    return project;
  }

  async removeWorkspace(projectId: string): Promise<boolean> {
    const { removeProjectRow } = await import('./projects/registry.js');
    return removeProjectRow(this.db, projectId);
  }

  private registerJobHandlers(): void {
    this.jobs.register(
      'start-ticket',
      createStartTicketHandler({
        ctx: this.ctx,
        db: this.db,
        log: this.log,
        loadProject: (projectId) => this.loadProjectById(projectId),
        tickets: this.tickets,
        agents: this.agents,
        ports: this.ports,
        enqueuePreviewPrep: (projectId) => {
          this.jobs.enqueue('sync-previews', { projectId, dedupeKey: `sync-previews:${projectId}` });
        },
      }),
    );
    this.jobs.register('sync-previews', async (context) => {
      const projectId = String(context.payload['projectId'] ?? context.job.project_id);
      await this.loadProjectById(projectId);
      await this.supervisor.tick();
      context.progress('previews', 60, 'Reconciling previews');
      return { ok: true };
    });
    this.jobs.register('remote-sync', async () => {
      await this.remote.sync();
      await this.supervisor.tick();
      return { ok: true, checkedAt: this.remote.lastSyncAt };
    });
  }

  private async completeTickets(branches: Map<string, Set<string>>): Promise<void> {
    for (const [projectId, branchSet] of branches) {
      const completed = this.tickets.completeMergedBranches(projectId, branchSet);
      for (const ticket of completed) this.log.info(`${ticket.branch}: ticket "${ticket.title}" moved to Done after merge confirmation`);
    }
  }

  async start(): Promise<void> {
    await this.supervisor.recoverAfterRestart();
    await this.agents.recoverAfterRestart();
    this.jobs.start();
    // First pass immediately, then on intervals. Fast discovery never
    // performs network operations; remote sync is a separate, slower loop.
    await this.supervisor.tick();
    void this.remote.sync();
    this.discoverTimer = setInterval(() => void this.supervisor.tick(), this.ctx.settings.discoverIntervalMs);
    this.discoverTimer.unref();
    this.remoteTimer = setInterval(() => void this.remote.sync(), this.ctx.settings.remoteSyncIntervalMs);
    this.remoteTimer.unref();
    this.healthTimer = setInterval(() => void this.supervisor.healthPass(), 2_000);
    this.healthTimer.unref();
    this.adoptedTimer = setInterval(() => void this.agents.pollAdopted(), 2_000);
    this.adoptedTimer.unref();
    this.log.info(`Gantry ${GANTRY_VERSION} started (data: ${this.ctx.dataDir})`);
  }

  async shutdown(): Promise<void> {
    for (const timer of [this.discoverTimer, this.remoteTimer, this.healthTimer, this.adoptedTimer]) {
      if (timer) clearInterval(timer);
    }
    this.jobs.stop();
    await this.supervisor.shutdown();
    this.db.close();
  }

  /** Serve the HTTP API + dashboard. Resolves once listening. */
  async serve(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = await createHttpServer(this);
    await server.listen({ port: this.ctx.settings.port, host: this.ctx.settings.host });
    await this.start();
    return { port: this.ctx.settings.port, close: async () => { await server.close(); await this.shutdown(); } };
  }
}
