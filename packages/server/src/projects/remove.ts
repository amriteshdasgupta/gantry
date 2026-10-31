import fs from 'node:fs/promises';
import path from 'node:path';
import type { GantryApp } from '../app.js';
import { artifactDirectory } from '../artifacts/artifacts.js';

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

/**
 * Remove a workspace from Gantry. Its services stop either way. By default its
 * data stays and returns when the workspace is added again; `deleteData` erases
 * it instead. The workspace's own folder, repositories and worktrees are never touched.
 */
export async function removeWorkspace(app: GantryApp, projectId: string, deleteData: boolean): Promise<boolean> {
  const { db } = app;
  if (!db.prepare('SELECT 1 FROM projects WHERE id=? AND removed_at IS NULL').get(projectId)) return false;
  return app.supervisor.withIdleProject(projectId, async () => {
    if (db.prepare("SELECT 1 FROM runs WHERE project_id=? AND state IN ('starting','running','interrupting') LIMIT 1").get(projectId)) {
      throw conflict('An agent is still running in this workspace. Stop it and retry.');
    }
    if (db.prepare("SELECT 1 FROM jobs WHERE project_id=? AND kind='start-ticket' AND state IN ('queued','running') LIMIT 1").get(projectId)) {
      throw conflict('A ticket is still starting in this workspace. Retry when it has started.');
    }
    const previewIds = (db.prepare('SELECT id FROM previews WHERE project_id=?').all(projectId) as { id: string }[]).map((row) => row.id);
    for (const id of previewIds) await app.supervisor.stopPreview(id);

    if (!deleteData) {
      db.prepare('UPDATE projects SET removed_at=? WHERE id=?').run(new Date().toISOString(), projectId);
      return true;
    }
    const ticketIds = (db.prepare('SELECT id FROM tickets WHERE project_id=?').all(projectId) as { id: string }[]).map((row) => row.id);
    const runIds = (db.prepare('SELECT id FROM runs WHERE project_id=?').all(projectId) as { id: string }[]).map((row) => row.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM artifact_files WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=?)').run(projectId);
      db.prepare('DELETE FROM jobs WHERE project_id=?').run(projectId);
      db.prepare('DELETE FROM port_allocations WHERE project_id=?').run(projectId);
      // Tickets, runs, previews and their checkouts and services cascade from here.
      db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    app.remote.vcs.forgetProject(projectId);
    await removeFiles(app, ticketIds, runIds, previewIds);
    return true;
  });
}

/** The records are already gone, so a file that cannot be removed is logged and does not fail the removal. */
async function removeFiles(app: GantryApp, ticketIds: string[], runIds: string[], previewIds: string[]): Promise<void> {
  const remove = (target: string) => fs.rm(target, { recursive: true, force: true }).catch((error: Error) => app.log.warn(`Could not remove ${target}: ${error.message}`));
  const { logsDir, artifactsDir, dataDir } = app.ctx;
  for (const id of ticketIds) await remove(artifactDirectory(artifactsDir, id));
  for (const id of runIds) await remove(path.join(logsDir, `run-${id}.log`));
  // Service logs and ready files are named <previewId>-<serviceId>; preview ids are fixed-length hashes.
  for (const dir of [logsDir, path.join(dataDir, 'ready')]) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (previewIds.some((id) => name.startsWith(`${id}-`))) await remove(path.join(dir, name));
  }
}
