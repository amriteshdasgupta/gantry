import { ticketServiceScopes, workflowSchema } from '@gantry/shared';
import { ZodError } from 'zod';
import { workspaceWorkflow, saveWorkspaceWorkflow, workspaceWorkflowTemplates, saveWorkspaceWorkflowTemplate } from '../projects/workflow.js';
import { ticketWorkflow, changeStep, replaceGraph, saveTicketWorkflow } from '../tickets/workflow.js';
import { workspacePrompt, saveWorkspacePrompt } from '../projects/prompt.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { GantryApp } from '../app.js';
import { buildStatus, readLogTail } from '../status.js';
import { applySecurityHeaders, artifactHeaders, hostAllowed, sameOriginMutation } from './security.js';
import { resolveArtifact } from '../artifacts/artifacts.js';
import { templateBody, buildPromptVars, renderPrompt, repositoryPath } from '../prompts/engine.js';
import { findInstructionFiles } from '../prompts/instructions.js';
import { readPreviewLoginEmail } from '../supervisor/preview-login.js';
import { initializeWorkspace } from '../projects/initialize.js';
import { removeWorkspace } from '../projects/remove.js';
import { ticketWorkspace } from '../tickets/workspace.js';
import { TicketError, validateTicketInput, type TicketInput } from '../tickets/store.js';
import { assessTicketCleanup, cleanupTicketWorktrees } from '../tickets/cleanup.js';
import { PROVIDERS, detectProvider, testCredentials, type Provider } from '../discover/vcs.js';
import { git } from '../git/git.js';

/**
 * HTTP API + dashboard host. Routes are grouped by concern in ./routes/*;
 * this file wires them and applies the security gate.
 */

export async function createHttpServer(app: GantryApp) {
  const fastify = Fastify({ logger: false, bodyLimit: 2_000_000 });
  const mutations = new Map<string, number>();
  const mutationProjects = new WeakMap<object, string>();
  const cleanupReservations = new Set<string>();

  // ---- security gate -------------------------------------------------------
  fastify.addHook('onRequest', async (request, reply) => {
    if (!hostAllowed(request, app.ctx.settings)) {
      return reply.code(403).send({ error: 'Local access only' });
    }
    const isMutation = request.method !== 'GET' && request.method !== 'HEAD';
    if (isMutation && !sameOriginMutation(request, app.ctx.settings)) {
      return reply.code(403).send({ error: 'Same-origin requests only' });
    }
  });

  fastify.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not found' });
  });
  fastify.addHook('preHandler', async request => {
    if (request.method === 'GET') return;
    const params = request.params as { ticketId?: string; projectId?: string; previewId?: string };
    const projectId = params.projectId
      ?? (params.ticketId ? app.tickets.get(params.ticketId)?.project_id : undefined)
      ?? (params.previewId ? app.supervisor.previewRow(params.previewId)?.project_id : undefined);
    if (projectId && (cleanupReservations.has(projectId) || app.cleanupProjects?.has(projectId))) throw Object.assign(new Error('Worktree cleanup is in progress. Retry shortly.'), { statusCode: 409 });
    if (!projectId) return;
    const cleanup = request.routeOptions.url?.endsWith('/worktree-cleanup');
    if (cleanup && mutations.get(projectId)) throw Object.assign(new Error('Workspace operations are in progress. Retry cleanup shortly.'), { statusCode: 409 });
    if (cleanup) cleanupReservations.add(projectId);
    mutationProjects.set(request, projectId);
    mutations.set(projectId, (mutations.get(projectId) ?? 0) + 1);
  });
  fastify.addHook('onResponse', async request => {
    const projectId = mutationProjects.get(request);
    if (projectId) {
      mutations.set(projectId, Math.max(0, (mutations.get(projectId) ?? 1) - 1));
      if (request.routeOptions.url?.endsWith('/worktree-cleanup')) cleanupReservations.delete(projectId);
    }
  });
  fastify.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 400;
    reply.code([404, 409].includes(statusCode) ? statusCode : 400).send({ error: error instanceof ZodError ? error.issues.map(issue => issue.message).join(' ') : (error as Error).message });
  });

  // ---- static dashboard ----------------------------------------------------
  const uiDir = app.ctx.uiDir;
  if (uiDir && fs.existsSync(path.join(uiDir, 'index.html'))) {
    await fastify.register(fastifyStatic, { root: path.resolve(uiDir), prefix: '/' });
  }

  // ---- status --------------------------------------------------------------
  fastify.get('/api/status', async (_request, reply) => {
    applySecurityHeaders(reply, 'application/json; charset=utf-8');
    return buildStatus(app);
  });

  fastify.get('/api/version', async () => ({ version: '0.1.0' }));

  // Request authoritative merge reconciliation; callers cannot mark tickets done.
  fastify.post('/api/pulls/reconcile', async () => {
    await app.remote.sync(true);
    if (app.remote.lastError) throw new Error(app.remote.lastError);
    return { ok: true, checkedAt: app.remote.lastSyncAt };
  });


  // ---- version control provider (Reviews) ----------------------------------
  // Tokens are write-only: the API reports whether one is saved, never its value.
  fastify.get('/api/vcs', async () => {
    const vcs = app.remote.vcs;
    const repositories = [];
    for (const project of await app.projects()) {
      for (const repo of project.config.repositories) {
        const remoteUrl = await git(path.resolve(project.workspace, repo.path), 'remote', 'get-url', repo.remote).catch(() => '');
        repositories.push({
          projectId: project.config.project.id,
          projectName: project.config.project.name,
          repositoryId: repo.id,
          remoteUrl: remoteUrl.replace(/\/\/[^@/]+@/, '//'),
          detected: detectProvider(remoteUrl),
          provider: vcs.providerFor(project.config.project.id, repo.id, remoteUrl),
          chosen: vcs.isChosen(project.config.project.id, repo.id),
          error: app.remote.pullErrors.get(`${project.config.project.id}:${repo.id}`) ?? null,
        });
      }
    }
    return {
      providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, { hasToken: vcs.hasToken(provider) }])),
      gitlabUrl: vcs.gitlabUrl ?? '',
      repositories,
    };
  });

  fastify.post('/api/vcs', async (request) => {
    const body = (request.body ?? {}) as {
      repository?: { projectId: string; repositoryId: string; provider: string | null };
      credentials?: { provider: string; token?: string | null; gitlabUrl?: string | null };
    };
    const isProvider = (value: unknown): value is Provider => PROVIDERS.includes(value as Provider);
    if (body.repository) {
      const { projectId, repositoryId, provider } = body.repository;
      const project = (await app.projects()).find((candidate) => candidate.config.project.id === projectId);
      if (!project?.config.repositories.some((repo) => repo.id === repositoryId)) throw Object.assign(new Error('Unknown repository'), { statusCode: 404 });
      if (provider !== null && !isProvider(provider)) throw new Error('Unknown provider');
      app.remote.vcs.setProvider(projectId, repositoryId, provider);
    }
    if (body.credentials) {
      if (!isProvider(body.credentials.provider)) throw new Error('Unknown provider');
      app.remote.vcs.setCredentials(body.credentials.provider, body.credentials.token, body.credentials.gitlabUrl);
    }
    void app.remote.sync(true);
    return { ok: true };
  });

  fastify.post('/api/vcs/test', async (request) => {
    const { provider } = (request.body ?? {}) as { provider?: string };
    if (!PROVIDERS.includes(provider as Provider)) throw new Error('Unknown provider');
    return { ok: true, user: await testCredentials(app.remote.vcs, provider as Provider) };
  });

  // ---- projects ------------------------------------------------------------
  fastify.post('/api/projects', async (request, reply) => {
    const body = request.body as { workspace?: string; initialize?: boolean };
    if (!body.workspace || typeof body.workspace !== 'string') throw new Error('Provide a workspace directory containing gantry.yaml');
    if (body.initialize) await initializeWorkspace(body.workspace);
    const project = await app.addWorkspace(body.workspace);
    return reply.code(201).send({ ok: true, projectId: project.config.project.id });
  });

  fastify.delete('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const body = (request.body ?? {}) as { confirm?: unknown; deleteData?: unknown };
    if (body.confirm !== true) throw new Error('Removing a workspace requires confirm: true.');
    if (typeof body.deleteData !== 'boolean') throw new Error('Choose whether to delete the workspace data (deleteData).');
    const removed = await removeWorkspace(app, projectId, body.deleteData);
    if (!removed) throw Object.assign(new Error('Unknown project'), { statusCode: 404 });
    return { ok: true };
  });

  fastify.post('/api/projects/:projectId/refresh', async (request) => {
    const { projectId } = request.params as { projectId: string };
    await app.loadProjectById(projectId); // 404 when unknown
    app.jobs.enqueue('remote-sync', { projectId, dedupeKey: 'remote-sync' });
    await app.supervisor.tick();
    return { ok: true };
  });

  fastify.get('/api/projects/:projectId/chat-prompt', async request => {
    return workspacePrompt(await app.loadProjectById((request.params as { projectId: string }).projectId));
  });
  fastify.post('/api/projects/:projectId/chat-prompt', async request => {
    return saveWorkspacePrompt(await app.loadProjectById((request.params as { projectId: string }).projectId), (request.body as { prompt?: unknown })?.prompt);
  });

  fastify.get('/api/projects/:projectId/workflow', async request => {
    return workspaceWorkflow(await app.loadProjectById((request.params as { projectId: string }).projectId));
  });
  fastify.post('/api/projects/:projectId/workflow', async request => {
    return saveWorkspaceWorkflow(await app.loadProjectById((request.params as { projectId: string }).projectId), request.body);
  });
  fastify.get('/api/tickets/:ticketId/workflow', async request => {
    const ticket = app.tickets.get((request.params as { ticketId: string }).ticketId);
    if (!ticket) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });
    return ticketWorkflow(ticket);
  });
  fastify.get('/api/projects/:projectId/workflow-templates', async request => {
    return workspaceWorkflowTemplates(await app.loadProjectById((request.params as { projectId: string }).projectId));
  });
  fastify.post('/api/projects/:projectId/workflow-templates', async (request, reply) => {
    const template = saveWorkspaceWorkflowTemplate(await app.loadProjectById((request.params as { projectId: string }).projectId), request.body);
    return reply.code(201).send(template);
  });
  fastify.post('/api/projects/:projectId/workflow-templates/:templateId', async request => {
    const { projectId, templateId } = request.params as { projectId: string; templateId: string };
    return saveWorkspaceWorkflowTemplate(await app.loadProjectById(projectId), request.body, templateId);
  });
  for (const action of ['workflow', 'workflow-progress'] as const) {
    fastify.post(`/api/tickets/:ticketId/${action}`, async request => {
      const ticket = app.tickets.get((request.params as { ticketId: string }).ticketId);
      if (!ticket) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });
      const current = ticketWorkflow(ticket);
      const body = request.body as { graph?: unknown; revision?: number };
      if (!body || body.revision !== (current?.revision ?? -1)) throw Object.assign(new Error('Graph changed. Reload and try again.'), { statusCode: 409 });
      if (ticket.status === 'done') throw new Error('Reopen this ticket before changing its graph.');
      if (action === 'workflow-progress' && !current) throw new Error('Add a ticket graph first.');
      const next = action === 'workflow' ? replaceGraph(current, body.graph) : changeStep(current!, body);
      return saveTicketWorkflow(app.db, ticket, next);
    });
  }

  // ---- prompt preview ------------------------------------------------------
  fastify.post('/api/projects/:projectId/prompt-preview', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { templateId?: string; title?: string; description?: string; scope?: string; scopes?: string[]; branch?: string; additions?: string | null; agentId?: string };
    const project = await app.loadProjectById(projectId);
    const input = validateTicketInput(ticketScopeInput({ ...body, title: body.title ?? 'Example ticket' }, project.config.services, true));
    for (const id of input.scopes ?? []) {
      if (!project.config.services.some((service) => service.id === id)) throw new TicketError(`Unknown service scope "${id}".`);
    }
    const templateId = body.templateId ?? project.config.project.defaultPromptTemplate;
    const body_ = templateBody(project.config, templateId);
    const ticket = {
      id: 'preview-only',
      project_id: projectId,
      title: body.title ?? 'Example ticket',
      description: body.description ?? '',
      status: 'backlog' as const,
      scope: input.scope,
      scopes: input.scopes,
      branch: body.branch ?? `${project.config.project.branchPrefix}/example`,
      additions: body.additions ?? null,
      position: 0,
      active_run_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const vars = buildPromptVars(project, ticket, {
      artifactDir: path.join(app.ctx.artifactsDir, ticket.id),
      previewUrl: null,
      previewLoginEmail: await readPreviewLoginEmail(app.ctx.dataDir),
      urls: Object.fromEntries(project.config.services.map((service) => [service.id, (service.openUrl ?? 'http://127.0.0.1:PORT').replace('${port}', 'PORT')])),
      paths: Object.fromEntries(project.config.services.map((service) => [service.id, repositoryPath(project, service.repository)])),
    });
    const rendered = renderPrompt(project, ticket, vars, {
      workflowPort: app.ctx.settings.port,
      ticket,
      project,
      instructionFiles: await findInstructionFiles(project),
      agentNotes: app.agents.get(body.agentId ?? project.config.project.defaultAgent)?.promptNotes ?? '',
      ticketAdditions: ticket.additions,
    });
    return { templateId, templateLabel: body_.label, template: body_.body, rendered: rendered.prompt, layers: rendered.layers };
  });

  // ---- tickets -------------------------------------------------------------
  fastify.post('/api/projects/:projectId/tickets', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await app.loadProjectById(projectId);
    const body = request.body as TicketInput & { workflowTemplateId?: unknown; graph?: unknown };
    const template = workspaceWorkflow(project, body?.workflowTemplateId);
    const graph = body?.graph === undefined ? template : workflowSchema.parse(body.graph);

    const ticket = app.tickets.create(
      projectId,
      ticketScopeInput(body, project.config.services, true),
      project.config.services.map((service) => service.id),
      project.config.project.branchPrefix,
      graph,
    );
    return reply.code(201).send(ticket);
  });

  fastify.post('/api/projects/:projectId/tickets/reorder', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { status?: string; ticketIds?: string[] };
    return app.tickets.reorder(projectId, String(body.status), body.ticketIds ?? []);
  });

  fastify.post('/api/tickets/:ticketId/update', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const ticket = app.tickets.get(ticketId);
    if (!ticket) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });
    const project = await app.loadProjectById(ticket.project_id);
    const validated = ticketScopeInput(request.body as TicketInput, project.config.services);
    const updated = app.tickets.update(ticketId, validated, project.config.services.map((service) => service.id), project.config.project.branchPrefix);
    if (updated.status === 'done') await app.supervisor.stopDonePreviews();
    return updated;
  });

  fastify.post('/api/tickets/:ticketId/outcome', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    return app.tickets.setOutcome(ticketId, (request.body as { outcome?: unknown } | undefined)?.outcome ?? null);
  });

  fastify.post('/api/tickets/:ticketId/awaiting-review', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    return app.tickets.setAwaitingReview(ticketId, (request.body as { awaitingReview?: unknown } | undefined)?.awaitingReview);
  });

  fastify.post('/api/tickets/:ticketId/delete', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    app.tickets.remove(ticketId);
    return { ok: true };
  });

  fastify.post('/api/tickets/:ticketId/prompt', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const body = (request.body ?? {}) as { agentId?: string };
    const ticket = app.tickets.get(ticketId);
    if (!ticket) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });
    const project = await app.loadProjectById(ticket.project_id);
    const agentId = body.agentId ?? project.config.project.defaultAgent;
    const vars = buildPromptVars(project, ticket, {
      artifactDir: path.join(app.ctx.artifactsDir, ticket.id),
      previewUrl: null,
      previewLoginEmail: await readPreviewLoginEmail(app.ctx.dataDir),
      urls: Object.fromEntries(project.config.services.map((service) => [service.id, (service.openUrl ?? 'http://127.0.0.1:PORT').replace('${port}', 'PORT')])),
      paths: Object.fromEntries(project.config.services.map((service) => [service.id, repositoryPath(project, service.repository)])),
    });
    const rendered = renderPrompt(project, ticket, vars, {
      workflowPort: app.ctx.settings.port,
      ticket,
      project,
      instructionFiles: await findInstructionFiles(project),
      agentNotes: app.agents.get(agentId)?.promptNotes ?? '',
      ticketAdditions: ticket.additions,
    });
    return { agentId, prompt: rendered.prompt, layers: rendered.layers };
  });

  const preparing = new Map<string, Promise<unknown>>();
  fastify.get('/api/tickets/:ticketId/worktree-cleanup', async request => {
    return assessTicketCleanup(app, (request.params as { ticketId: string }).ticketId);
  });
  fastify.post('/api/tickets/:ticketId/worktree-cleanup', async request => {
    const { ticketId } = request.params as { ticketId: string };
    const body = request.body as { confirm?: unknown; checkouts?: unknown; ticketIds?: unknown } | undefined;
    if (body?.confirm !== true) throw new Error('Worktree removal requires confirm: true.');
    const ticket = app.tickets.get(ticketId);
    if (!ticket) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });
    const peers = app.tickets.all(ticket.project_id).filter(t => t.branch === ticket.branch).map(t => t.id).sort();
    if (!Array.isArray(body.ticketIds) || JSON.stringify(body.ticketIds) !== JSON.stringify(peers)) {
      throw Object.assign(new Error('Tickets sharing this branch changed. Review a fresh cleanup assessment.'), { statusCode: 409 });
    }
    if ([...preparing.keys()].some(id => app.tickets.get(id)?.project_id === ticket.project_id)) throw Object.assign(new Error('Worktree preparation is in progress. Retry shortly.'), { statusCode: 409 });
    app.cleanupProjects.add(ticket.project_id);
    try {
      return await app.supervisor.withIdleProject(ticket.project_id, () => cleanupTicketWorktrees(app, ticketId, body.checkouts));
    } finally {
      app.cleanupProjects.delete(ticket.project_id);
    }
  });
  fastify.get('/api/tickets/:ticketId/workspace', async request => {
    return ticketWorkspace(app, (request.params as { ticketId: string }).ticketId);
  });
  fastify.post('/api/tickets/:ticketId/prepare', async request => {
    const { ticketId } = request.params as { ticketId: string };
    let task = preparing.get(ticketId);
    if (!task) {
      task = ticketWorkspace(app, ticketId, true).finally(() => preparing.delete(ticketId));
      preparing.set(ticketId, task);
    }
    return task;
  });

  // Start: queues the durable job and returns immediately (202).
  fastify.post('/api/tickets/:ticketId/start', async (request, reply) => {
    const { ticketId } = request.params as { ticketId: string };
    const body = (request.body ?? {}) as { agentId?: string; prompt?: string };
    const ticket = app.tickets.get(ticketId);
    if (!ticket) throw Object.assign(new Error('Ticket not found.'), { statusCode: 404 });
    const active = app.jobs.activeJobFor(`start-ticket:${ticketId}`);
    if (active) return reply.code(202).send({ ok: true, jobId: active.id, deduped: true });
    const job = app.jobs.enqueue('start-ticket', {
      payload: { agentId: body.agentId, prompt: body.prompt },
      projectId: ticket.project_id,
      ticketId,
      dedupeKey: `start-ticket:${ticketId}`,
    });
    return reply.code(202).send({ ok: true, jobId: job.id });
  });

  fastify.post('/api/tickets/:ticketId/handoff', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const run = app.agents.activeRunForTicket(ticketId);
    if (!run) throw Object.assign(new Error('No active agent run for this ticket.'), { statusCode: 409 });
    const result = await app.agents.takeover(run.id, app.ctx.settings.takeoverGraceMs);
    if (!result.ok) throw new Error(result.error ?? 'Takeover failed.');
    return result;
  });

  fastify.post('/api/tickets/:ticketId/resume', async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const run = app.agents.activeRunForTicket(ticketId) ?? latestRun(app, ticketId);
    if (!run?.session_id) throw Object.assign(new Error('This run has no session id to resume.'), { statusCode: 409 });
    const project = await app.loadProjectById(run.project_id);
    const adapter = app.agents.get(run.agent);
    if (!adapter) throw new Error(`Agent "${run.agent}" is not registered.`);
    const config = app.agents.agentConfig(project, run.agent);
    const resolved = await adapter.resolveBinary(config.binary);
    if (!resolved.path) throw new Error(`${adapter.label} is not installed.`);
    const spec = adapter.buildResume(run.session_id, { workspace: run.workspace ?? project.workspace, prompt: '', addDirs: [], binary: resolved.path, args: config.args });
    if (!spec) throw Object.assign(new Error(`${adapter.label} does not support resuming sessions.`), { statusCode: 409 });
    return { terminal: { argv: spec.argv, cwd: spec.cwd } };
  });

  // ---- previews ------------------------------------------------------------
  fastify.post('/api/previews/:previewId/:action', async (request) => {
    const { previewId, action } = request.params as { previewId: string; action: string };
    const body = (request.body ?? {}) as { confirm?: boolean; environmentId?: string };
    const preview = app.supervisor.previewRow(previewId);
    if (!preview) throw Object.assign(new Error('Unknown preview'), { statusCode: 404 });
    if (app.supervisor.isDonePreview(previewId)) throw Object.assign(new Error('Reopen the ticket before using its preview.'), { statusCode: 409 });
    switch (action) {
      case 'pause':
        await app.supervisor.setPaused(previewId, true);
        break;
      case 'resume':
        await app.supervisor.setPaused(previewId, false);
        break;
      case 'restart':
        await app.supervisor.restartPreview(previewId);
        break;
      case 'retry-dependencies':
        await app.supervisor.retryDependencies(previewId);
        break;
      case 'archive':
        if (!body.confirm) throw new Error('Archiving a preview requires confirmation (confirm: true).');
        await app.supervisor.setArchived(previewId, true);
        break;
      case 'restore':
        await app.supervisor.restorePreview(previewId);
        break;
      case 'environment': {
        if (!body.environmentId) throw new Error('Provide environmentId');
        const project = await app.loadProjectById(preview.project_id);
        if (!project.config.environments.some((env) => env.id === body.environmentId)) throw new Error(`Unknown environment "${body.environmentId}"`);
        await app.supervisor.setEnvironment(previewId, body.environmentId);
        break;
      }
      default:
        throw new Error(`Unknown preview action "${action}"`);
    }
    return { ok: true };
  });

  // ---- logs + artifacts ----------------------------------------------------
  fastify.get('/logs/preview/:previewId/:serviceId', async (request, reply) => {
    const { previewId, serviceId } = request.params as { previewId: string; serviceId: string };
    if (!/^[\w-]+$/.test(previewId) || !/^[\w-]+$/.test(serviceId)) throw new Error('Invalid log path');
    applySecurityHeaders(reply, 'text/plain; charset=utf-8');
    return readLogTail(path.join(app.ctx.logsDir, `${previewId}-${serviceId}.log`));
  });

  fastify.get('/logs/run/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!/^[\w-]+$/.test(runId)) throw new Error('Invalid run id');
    applySecurityHeaders(reply, 'text/plain; charset=utf-8');
    return readLogTail(path.join(app.ctx.logsDir, `run-${runId}.log`));
  });

  fastify.get('/artifacts/:ticketId/:file', async (request, reply) => {
    const { ticketId, file } = request.params as { ticketId: string; file: string };
    const artifact = resolveArtifact(app.ctx.artifactsDir, ticketId, file);
    if (!artifact) throw Object.assign(new Error('Artifact not found'), { statusCode: 404 });
    const content = await fsp.readFile(artifact.path).catch(() => null);
    if (!content) throw Object.assign(new Error('Artifact not found'), { statusCode: 404 });
    artifactHeaders(reply, artifact.type, artifact.disposition, artifact.file, content.length);
    return content;
  });

  return fastify;
}

function latestRun(app: GantryApp, ticketId: string) {
  return app.db.prepare('SELECT * FROM runs WHERE ticket_id=? ORDER BY started_at DESC LIMIT 1').get(ticketId) as { session_id: string | null; agent: string; workspace: string | null; project_id: string } | undefined;
}

/** Legacy clients may still submit a category; new clients send service IDs. */
function ticketScopeInput(input: TicketInput, services: { id: string; repository: string }[], creating = false): TicketInput {
  if (input.scopes !== undefined) return input;
  if (input.scope === undefined && !creating) return input;
  const scopes = ticketServiceScopes(input, services);
  if (input.scope && input.scope !== 'both' && !scopes.length) {
    throw new TicketError(`Legacy scope "${input.scope}" has no matching service. Select service scopes instead.`);
  }
  return { ...input, scopes };
}
