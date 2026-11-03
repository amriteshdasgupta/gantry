import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './exec';
import { isValidRule } from './stage-permission-rules';
import { parseOpenCodeRule } from '../opencode-permissions';

/**
 * Workspace grants chosen by the person in Gantry. Claude rules go to --allowedTools;
 * provider-tagged OpenCode rules go to its inline permission config, never to Claude.
 */
const FILE = path.join(HOME, 'stage-permissions.json');
type Store = Record<string, { allow: string[] }>;

function read(): Store {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' ? (data as Store) : {};
  } catch {
    return {};
  }
}
function write(store: Store) {
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(store, null, 1), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
}

export function forgetAllowedTools(projectId: string) {
  const store = read();
  if (!(projectId in store)) return;
  delete store[projectId];
  write(store);
}

export function allowedTools(projectId: string, provider: 'claude' | 'opencode' = 'claude'): string[] {
  return (read()[projectId]?.allow ?? []).filter(r => isValidRule(r) && (!!parseOpenCodeRule(r) === (provider === 'opencode')));
}

/** Add and remove rules; returns the new list. Invalid rules are refused rather than dropped silently. */
export function updateAllowedTools(projectId: string, add: string[] = [], remove: string[] = []): string[] {
  const bad = add.filter((r) => !isValidRule(r));
  if (bad.length) throw Object.assign(new Error(`Not a valid tool rule: ${bad.join(', ')}`), { status: 400 });
  const store = read();
  const next = [...new Set([...(store[projectId]?.allow ?? []), ...add])].filter((r) => !remove.includes(r));
  store[projectId] = { allow: next };
  write(store);
  return next;
}

/**
 * Rules the person granted with "don't ask again" inside a stage chat are saved by Claude Code
 * in that checkout's .claude/settings.local.json. Copy them into the workspace list so later
 * headless stages get them too. Returns the rules that were new.
 */
export function importChatGrants(projectId: string, checkouts: string[]): string[] {
  const found: string[] = [];
  for (const dir of checkouts) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
      for (const rule of settings?.permissions?.allow ?? []) if (typeof rule === 'string' && isValidRule(rule)) found.push(rule);
    } catch {
      /* No local grants in this checkout. */
    }
  }
  const current = allowedTools(projectId);
  const fresh = [...new Set(found)].filter((r) => !current.includes(r));
  if (fresh.length) updateAllowedTools(projectId, fresh);
  return fresh;
}

/**
 * The Claude settings file every stage and stage chat in a workspace runs with, if one exists:
 * the workspace's own claude-stage-settings.json, else a shared setup/claude-stage-settings.json
 * next to the workspaces, else Gantry's. Its deny rules (force push, reset --hard, merging) hold
 * even though stages skip permission prompts.
 */
export function stageSettingsFile(workspace: string): string | undefined {
  const name = 'claude-stage-settings.json';
  return [path.join(workspace, name), path.join(path.dirname(workspace), 'setup', name), path.join(HOME, name)].find((file) => fs.existsSync(file));
}
