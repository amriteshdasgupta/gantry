import { ticketWorkflow } from './tickets/workflow.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { redactEnv, ticketServiceScopes, ticketScopeDescription } from '@gantry/shared';
import type { GantryApp } from './app.js';
import { repositoryPath } from './prompts/engine.js';
import { findInstructionFiles } from './prompts/instructions.js';

/**
 * API view assembly: one snapshot of everything the dashboard renders.
 * Private environment values are reduced to key names + lengths; secrets
 * never appear here or anywhere downstream.
 */

interface PreviewServiceView {
  id: string;
  state: string;
  port: number | null;
  healthUrl: string | null;
  openUrl: string | null;
  openLink: string | null;
  pid: number | null;
  error: string | null;
  startedAt: string | null;
  logUrl: string | null;
}

export async function buildStatus(app: GantryApp): Promise<Record<string, unknown>> {
  const projects = await app.projects();
  const projectViews = [] as Record<string, unknown>[];
  const previewsView: Record<string, unknown>[] = [];
  const pullsView: Record<string, unknown>[] = [];
  const ticketsView: Record<string, unknown>[] = [];
  const jobsView: Record<string, unknown>[] = [];
  const remoteView: Record<string, unknown>[] = [];

  for (const project of projects) {
    const projectId = project.config.project.id;
    const agents = await app.agents.describe(project);
    const instructionFiles = await findInstructionFiles(project);
    const environments = project.config.environments.map((env) => ({ id: env.id, label: env.label, default: env.default }));
    projectViews.push({
      id: projectId,
      name: project.config.project.name,
      workspace: project.workspace,
      configPath: project.configPath,
      defaultAgent: project.config.project.defaultAgent,
      defaultPromptTemplate: project.config.project.defaultPromptTemplate,
      branchPrefix: project.config.project.branchPrefix,
      scopes: project.config.services.map((service) => ({ id: service.id, label: service.id, description: service.id })),
      environments,
      agents,
      repositories: project.config.repositories.map((repo) => ({ ...repo, absolutePath: repositoryPath(project, repo.id) })),
      services: project.config.services.map((service) => ({ id: service.id, repository: service.repository, openUrl: service.openUrl ?? null, dependsOn: service.dependsOn })),
      promptTemplates: [
        { id: 'builtin:default', label: 'Default' },
        { id: 'builtin:paper-setter-legacy', label: 'Paper Setter legacy' },
        ...project.config.promptTemplates.map((template) => ({ id: template.id, label: template.label })),
      ],
      promptTemplateValid: project.config.project.defaultPromptTemplate,
      instructionFiles,
    });

    const previewRows = app.db.prepare('SELECT * FROM previews WHERE project_id=?').all(projectId) as Record<string, unknown>[];
    for (const row of previewRows) {
      const previewId = String(row['id']);
      if (app.supervisor.isDonePreview(previewId)) continue;
      const serviceRows = app.db.prepare('SELECT * FROM preview_services WHERE preview_id=?').all(previewId) as Record<string, unknown>[];
      const checkouts = app.db.prepare('SELECT * FROM preview_checkouts WHERE preview_id=?').all(previewId) as Record<string, unknown>[];
      const services: PreviewServiceView[] = [];
      for (const serviceConfig of project.config.services) {
        const runtime = serviceRows.find((candidate) => candidate['service_id'] === serviceConfig.id);
        const port = (runtime?.['port'] as number | null) ?? null;
        const openUrl = port ? (serviceConfig.openUrl ?? `http://127.0.0.1:${port}`).replace('${port}', String(port)) : null;
        services.push({
          id: serviceConfig.id,
          state: (runtime?.['state'] as string) ?? 'stopped',
          port,
          healthUrl: port && serviceConfig.healthUrl ? serviceConfig.healthUrl.replace('${port}', String(port)) : null,
          openUrl,
          openLink: openUrl,
          pid: (runtime?.['pid'] as number | null) ?? null,
          error: (runtime?.['error'] as string | null) ?? null,
          startedAt: (runtime?.['started_at'] as string | null) ?? null,
          logUrl: runtime ? `/logs/preview/${previewId}/${serviceConfig.id}` : null,
        });
      }
      previewsView.push({
        id: previewId,
        projectId,
        branch: row['branch'],
        isPrimary: Boolean(row['is_primary']),
        status: row['status'],
        environment: row['environment'],
        paused: Boolean(row['paused']),
        archived: Boolean(row['archived']),
        retired: Boolean(row['retired']),
        removed: Boolean(row['removed']),
        ticketId: row['ticket_id'],
        evidence: safeParse(row['merge_evidence']),
        checkouts: checkouts.map((checkout) => ({
          repositoryId: checkout['repository_id'],
          path: checkout['path'],
          head: checkout['head'],
          branch: checkout['branch'],
          isFallback: Boolean(checkout['is_fallback']),
          isPrimary: Boolean(checkout['is_primary']),
        })),
        services,
      });
    }

    // The first explicitly exposed service is the workspace's primary preview.
    const previewServiceId = project.config.services.find((service) => service.openUrl)?.id ?? project.config.services[0]?.id;
    pullsView.push(...app.remote.pullsFor(projectId).map((group) => {
      const preview = previewsView.find((candidate) => candidate['projectId'] === projectId && candidate['branch'] === group.branch && !candidate['retired'] && !candidate['archived']);
      const blockers = [...new Set(Object.values(group.pulls).flatMap((pull) => pull.blockers))];
      return {
        id: `pull:${projectId}:${group.branch}`,
        projectId,
        branch: group.branch,
        pulls: group.pulls,
        previewId: (preview?.['id'] as string) ?? null,
        previewUrl: (Object.values(preview?.['services'] ?? {}).find((service) => (service as PreviewServiceView).id === previewServiceId) as PreviewServiceView | undefined)?.openUrl ?? null,
        ready: Object.values(group.pulls).every((pull) => pull.ready) && Object.keys(group.pulls).length > 0,
        blockers,
      };
    }));

    const remoteErrors: Record<string, unknown> = {};
    for (const repo of project.config.repositories) {
      const snapshot = app.remote.snapshotFor(projectId, repo.id);
      if (snapshot) remoteErrors[`${projectId}:${repo.id}`] = { checkedAt: snapshot.checkedAt, error: snapshot.error };
    }
    remoteView.push({ projectId, repositories: remoteErrors, lastSyncAt: app.remote.lastSyncAt });

    const tickets = app.tickets.all(projectId);
    for (const ticket of tickets) {
      const run = app.agents.activeRunForTicket(ticket.id) ?? latestRun(app, ticket.id);
      const preview = previewsView.find((candidate) => candidate['projectId'] === projectId && candidate['branch'] === ticket.branch);
      const artifacts = await appListArtifacts(app, ticket.id);
      const adapter = run ? app.agents.get(run.agent) : null;
      ticketsView.push({
        id: ticket.id,
        projectId,
        title: ticket.title,
        assistantName: ticket.assistant_name,
        description: ticket.description,
        status: ticket.status,
        scope: ticket.scope,
        scopes: ticketServiceScopes(ticket, project.config.services),
        scopeDescription: ticketScopeDescription(ticket, project.config.services),
        branch: ticket.branch,
        additions: ticket.additions,
        outcome: ticket.outcome ?? null,
        awaitingReview: !!ticket.awaiting_review,
        workflow: ticketWorkflow(ticket),
        position: ticket.position,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
        run: run
          ? {
              id: run.id,
              agent: run.agent,
              state: run.state,
              sessionId: run.session_id,
              deepLink: run.session_id && adapter ? adapter.deepLink(run.session_id) : null,
              startedAt: run.started_at,
              endedAt: run.ended_at,
              error: run.error,
              processAlive: ['running', 'starting', 'interrupting'].includes(run.state),
              logUrl: `/logs/run/${run.id}`,
            }
          : null,
        previewUrl: ((preview?.['services'] as PreviewServiceView[]) ?? []).find((service) => service.id === previewServiceId)?.openUrl ?? null,
        previewStatus: (preview?.['status'] as string) ?? null,
        pullRequests: pullsView
          .filter((group) => group['projectId'] === projectId && group['branch'] === ticket.branch)
          .flatMap((group) => Object.entries(group['pulls'] as Record<string, { number: number; url: string; title: string }>))
          .map(([repositoryId, pull]) => ({ role: repositoryId, ...pickPullFields(pull) })),
        artifacts,
      });
    }
  }

  const activeJobs = app.db.prepare("SELECT id, kind, project_id, ticket_id, state, phase, progress, detail, error, created_at, updated_at FROM jobs WHERE state IN ('queued','running') ORDER BY created_at DESC LIMIT 50").all() as Record<string, unknown>[];
  jobsView.push(...activeJobs);

  return {
    version: '0.1.0',
    checkedAt: Date.now(),
    dataDirName: path.basename(app.ctx.dataDir),
    host: { port: app.ctx.settings.port, loopback: app.ctx.settings.host === '127.0.0.1' || app.ctx.settings.host === 'localhost' },
    remoteSync: { lastSyncAt: app.remote.lastSyncAt, error: app.remote.lastError },
    projects: projectViews,
    tickets: ticketsView,
    previews: previewsView,
    pulls: pullsView,
    remote: remoteView,
    jobs: jobsView,
    env: redactEnv({}), // explicit: no environment values are ever included
  };
}

function latestRun(app: GantryApp, ticketId: string): ReturnType<GantryApp['agents']['activeRunForTicket']> {
  return (app.db.prepare('SELECT * FROM runs WHERE ticket_id=? ORDER BY started_at DESC LIMIT 1').get(ticketId) as never) ?? null;
}

async function appListArtifacts(app: GantryApp, ticketId: string) {
  const { listTicketArtifacts } = await import('./artifacts/artifacts.js');
  return listTicketArtifacts(app.ctx.artifactsDir, ticketId);
}

function pickPullFields(pull: { number: number; url: string; title: string }): { number: number; url: string; title: string } {
  return { number: pull.number, url: pull.url, title: pull.title };
}

function safeParse(raw: unknown): Record<string, { evidence: string; number: number | null; url: string | null }> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { evidence: string; number: number | null; url: string | null }>;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, { evidence: value.evidence, number: value.number ?? null, url: value.url ?? null }]));
  } catch {
    return {};
  }
}

export async function readLogTail(file: string, maxBytes = 80_000): Promise<string> {
  try {
    const content = await fs.readFile(file, 'utf8');
    return content.slice(-maxBytes) || 'No logs yet.';
  } catch {
    return 'No logs yet.';
  }
}
