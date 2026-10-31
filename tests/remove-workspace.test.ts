import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GantryApp } from '../packages/server/src/app.js';
import { createAppContext } from '../packages/server/src/config/app.js';
import { initializeWorkspace } from '../packages/server/src/projects/initialize.js';
import { removeWorkspace } from '../packages/server/src/projects/remove.js';
import { initFixtureRepo, tempDir } from './helpers.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function fixture() {
  const temp = await tempDir('gantry-remove-');
  const workspace = path.join(temp.dir, 'workspace');
  await initFixtureRepo(workspace);
  const previous = process.env.GANTRY_DATA_DIR;
  process.env.GANTRY_DATA_DIR = path.join(temp.dir, 'data');
  const app = new GantryApp(createAppContext());
  vi.spyOn(app.supervisor, 'tick').mockResolvedValue();
  await initializeWorkspace(workspace);
  const project = await app.addWorkspace(workspace);
  const projectId = project.config.project.id;
  const ticket = app.tickets.create(projectId, { title: 'TEST_remove' }, [], 'ticket');
  const now = new Date().toISOString();
  app.db.prepare("INSERT INTO runs (id, ticket_id, project_id, agent, state) VALUES ('run-1', ?, ?, 'generic', 'finished')").run(ticket.id, projectId);
  const previewId = 'a'.repeat(16);
  app.db.prepare("INSERT INTO previews (id, project_id, branch, created_at, updated_at) VALUES (?, ?, 'ticket/x', ?, ?)").run(previewId, projectId, now, now);
  app.db.prepare("INSERT INTO port_allocations (project_id, preview_id, service_id, port) VALUES (?, ?, 'web', 6100)").run(projectId, previewId);
  const artifacts = path.join(app.ctx.artifactsDir, ticket.id);
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'final.png'), 'x');
  const runLog = path.join(app.ctx.logsDir, 'run-run-1.log');
  const serviceLog = path.join(app.ctx.logsDir, `${previewId}-web.log`);
  const otherLog = path.join(app.ctx.logsDir, `${'b'.repeat(16)}-web.log`);
  for (const file of [runLog, serviceLog, otherLog]) await fs.writeFile(file, 'x');
  app.remote.vcs.setProvider(projectId, 'repo', 'gitlab');
  app.remote.vcs.setProvider('other', 'repo', 'gitlab');
  closers.push(async () => {
    app.db.close();
    if (previous === undefined) delete process.env.GANTRY_DATA_DIR;
    else process.env.GANTRY_DATA_DIR = previous;
    await temp.cleanup();
  });
  return { app, workspace, projectId, ticket, artifacts, runLog, serviceLog, otherLog };
}
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

test('keeping data hides the workspace and adding it again restores everything', async () => {
  const f = await fixture();
  expect(await removeWorkspace(f.app, f.projectId, false)).toBe(true);
  expect(await f.app.projects()).toEqual([]);
  expect(f.app.tickets.get(f.ticket.id)?.title).toBe('TEST_remove');
  expect(await exists(f.artifacts)).toBe(true);
  expect(await removeWorkspace(f.app, f.projectId, false)).toBe(false);

  await f.app.addWorkspace(f.workspace);
  expect((await f.app.projects()).map(p => p.config.project.id)).toEqual([f.projectId]);
  expect(f.app.tickets.get(f.ticket.id)?.title).toBe('TEST_remove');
});

test('deleting data erases this workspace only and leaves its folder alone', async () => {
  const f = await fixture();
  expect(await removeWorkspace(f.app, f.projectId, true)).toBe(true);
  expect(await f.app.projects()).toEqual([]);
  for (const table of ['tickets', 'previews', 'port_allocations', 'runs', 'projects']) {
    const column = table === 'projects' ? 'id' : 'project_id';
    expect(f.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`).get(f.projectId)).toEqual({ n: 0 });
  }
  for (const file of [f.artifacts, f.runLog, f.serviceLog]) expect(await exists(file)).toBe(false);
  expect(await exists(f.otherLog)).toBe(true);
  expect(await exists(path.join(f.workspace, 'gantry.yaml'))).toBe(true);
  expect(f.app.remote.vcs.isChosen(f.projectId, 'repo')).toBe(false);
  expect(f.app.remote.vcs.isChosen('other', 'repo')).toBe(true);
});

test('refuses while an agent is running', async () => {
  const f = await fixture();
  f.app.db.prepare("UPDATE runs SET state='running' WHERE id='run-1'").run();
  await expect(removeWorkspace(f.app, f.projectId, true)).rejects.toMatchObject({ statusCode: 409 });
  expect((await f.app.projects()).length).toBe(1);
  expect(f.app.tickets.get(f.ticket.id)).toBeTruthy();
});
