import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('standalone external-module aliases survive flattening and installation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-package-'));
  try {
    const desktop = path.join(root, 'desktop');
    const out = path.join(desktop, '.next/standalone');
    const app = path.join(out, '.worktrees/feature/gantry/desktop');
    await fs.mkdir(path.join(desktop, 'scripts'), { recursive: true });
    await fs.copyFile('desktop/scripts/bundle-server.mjs', path.join(desktop, 'scripts/bundle-server.mjs'));
    await fs.mkdir(path.join(app, '.next/node_modules'), { recursive: true });
    await fs.mkdir(path.join(app, 'node_modules/shiki'), { recursive: true });
    await fs.writeFile(path.join(app, 'node_modules/shiki/package.json'), '{"name":"shiki"}');
    await fs.symlink(path.join(app, 'node_modules/shiki'), path.join(app, '.next/node_modules/shiki-hash'));
    await fs.writeFile(path.join(app, 'server.js'), '');
    await fs.mkdir(path.join(desktop, '.next/static'), { recursive: true });
    execFileSync(process.execPath, [path.join(desktop, 'scripts/bundle-server.mjs')]);
    execFileSync(process.execPath, [path.join(desktop, 'scripts/bundle-server.mjs')]);
    const installed = path.join(root, 'installed');
    await fs.rename(out, installed);
    expect(JSON.parse(await fs.readFile(path.join(installed, '.next/node_modules/shiki-hash/package.json'), 'utf8')).name).toBe('shiki');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
