import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type ProjectConfig,
  parseProjectConfig,
  validateConfigReferences,
  validateManagedPath,
  normalizeDir,
  PathError,
} from '@gantry/shared';
import type { Database } from '../db/db.js';

/**
 * Project registry: discovers and loads `gantry.yaml` files.
 *
 * A project is registered by pointing Gantry at a workspace directory
 * containing a `gantry.yaml`. Registered workspaces are remembered in the
 * database; the YAML file itself stays the source of truth and is reloaded
 * on every discovery pass so edits apply without a restart.
 */

export const CONFIG_FILE_NAME = 'gantry.yaml';

export interface LoadedProject {
  config: ProjectConfig;
  workspace: string; // realpath
  configPath: string;
}

export class ProjectError extends Error {}

export async function findConfigFile(workspace: string): Promise<string | null> {
  for (const name of [CONFIG_FILE_NAME, 'gantry.yml', '.gantry.yaml']) {
    const candidate = path.join(workspace, name);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Load and validate a project from a workspace directory. Throws ProjectError with a readable message. */
export async function loadProject(workspaceInput: string): Promise<LoadedProject> {
  let workspace: string;
  try {
    workspace = await fs.realpath(path.resolve(workspaceInput));
  } catch {
    throw new ProjectError(`Workspace directory does not exist: ${workspaceInput}`);
  }
  const stat = await fs.stat(workspace).catch(() => null);
  if (!stat?.isDirectory()) throw new ProjectError(`Not a directory: ${workspace}`);
  const configPath = await findConfigFile(workspace);
  if (!configPath) {
    throw new ProjectError(`No ${CONFIG_FILE_NAME} found in ${workspace}. Run "gantry init" to create one.`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    throw new ProjectError(`${path.basename(configPath)} is not valid YAML: ${(error as Error).message}`);
  }
  const parsed = parseProjectConfig(raw);
  if (!parsed.ok) {
    throw new ProjectError(`Invalid ${CONFIG_FILE_NAME}:\n${parsed.errors.map((line) => `  - ${line}`).join('\n')}`);
  }
  const referenceErrors = validateConfigReferences(parsed.config);
  if (referenceErrors.length) {
    throw new ProjectError(`Invalid ${CONFIG_FILE_NAME}:\n${referenceErrors.map((line) => `  - ${line}`).join('\n')}`);
  }
  // Every repository path must resolve inside the workspace (path traversal guard).
  for (const repo of parsed.config.repositories) {
    const resolved = validateManagedPath(workspace, repo.path);
    if (!path.isAbsolute(repo.path)) repo.path = path.relative(workspace, resolved) || '.';
  }
  if (parsed.config.project.worktreeRoot.includes('..')) {
    throw new ProjectError('project.worktreeRoot must stay inside the workspace');
  }
  return { config: parsed.config, workspace, configPath };
}

export interface RegistryDeps {
  db: Database;
}

export interface RegisteredProject {
  id: string;
  workspace: string;
}

/** Remember a workspace in the database (idempotent per id). */
export function registerProjectRow(db: Database, project: LoadedProject): RegisteredProject {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(project.config.project.id) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE projects SET name=?, workspace=?, config_path=?, default_agent=?, default_prompt_template=?, updated_at=?, removed_at=NULL WHERE id=?').run(
      project.config.project.name,
      project.workspace,
      project.configPath,
      project.config.project.defaultAgent,
      project.config.project.defaultPromptTemplate,
      now,
      project.config.project.id,
    );
  } else {
    db.prepare(
      'INSERT INTO projects (id, name, workspace, config_path, default_agent, default_prompt_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      project.config.project.id,
      project.config.project.name,
      project.workspace,
      project.configPath,
      project.config.project.defaultAgent,
      project.config.project.defaultPromptTemplate,
      now,
      now,
    );
  }
  return { id: project.config.project.id, workspace: project.workspace };
}

export function listRegisteredWorkspaces(db: Database): string[] {
  return (db.prepare('SELECT workspace FROM projects WHERE removed_at IS NULL ORDER BY created_at').all() as { workspace: string }[]).map((row) => row.workspace);
}

export function getRegisteredProject(db: Database, id: string): { workspace: string } | null {
  const row = db.prepare('SELECT workspace FROM projects WHERE id = ?').get(id) as { workspace: string } | undefined;
  return row ?? null;
}

/** Absolute path of a repository inside its project workspace. */
export function repositoryPath(project: LoadedProject, repositoryId: string): string {
  const repo = project.config.repositories.find((candidate) => candidate.id === repositoryId);
  if (!repo) throw new ProjectError(`Unknown repository "${repositoryId}"`);
  return normalizeDir(path.resolve(project.workspace, repo.path));
}

export function worktreeRootPath(project: LoadedProject): string {
  return path.resolve(project.workspace, project.config.project.worktreeRoot);
}

export { PathError };
