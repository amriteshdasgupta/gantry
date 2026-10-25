import { test, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

test('desktop preload exposes only the folder picker and ships with the app', async () => {
  const exposed: Record<string, Record<string, () => unknown>> = {};
  const invoked: unknown[][] = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (key: string, api: Record<string, () => unknown>) => { exposed[key] = api; } },
    ipcRenderer: { invoke: (...args: unknown[]) => { invoked.push(args); return Promise.resolve('/path/to/workspace'); } },
  };
  const require = (id: string) => { if (id !== 'electron') throw new Error(`unexpected require ${id}`); return electron; };
  vm.runInNewContext(fs.readFileSync('desktop/electron/preload.cjs', 'utf8'), { require });

  expect(Object.keys(exposed)).toEqual(['gantryDesktop']);
  expect(Object.keys(exposed.gantryDesktop)).toEqual(['pickFolder']);
  await expect(exposed.gantryDesktop.pickFolder()).resolves.toBe('/path/to/workspace');
  expect(invoked).toEqual([['pick-folder']]);

  const files = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8')).build.files;
  expect(files).toContain('electron/preload.cjs');
});
