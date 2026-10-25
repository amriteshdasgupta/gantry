import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '', calls: [] as string[][], spawn: vi.fn(), busy: false }));
vi.mock('server-only', () => ({}));
vi.mock('../desktop/src/lib/server/exec', () => ({
  get HOME() { return mocks.home; },
  withLock: (_: string, fn: () => unknown) => fn(),
}));
vi.mock('../desktop/src/lib/server/stage-sessions', () => ({ sessionOpenInTerminal: async () => false }));
vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFile: (bin: string, args: string[], options: unknown, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === 'function' ? options as typeof callback : callback;
    mocks.calls.push([bin, ...args]);
    let result: unknown = {};
    // The promisified execFile resolves an object, rather than just stdout.
    if (args[0] === '--version') return cb(null, { stdout: 'herdr test' });
    if (bin === 'ps') return cb(null, { stdout: '' });
    if (bin === 'pgrep') return cb(null, { stdout: '' });
    if (args[0] === 'workspace' && args[1] === 'create') result = { workspace: { workspace_id: 'w1' }, tab: { tab_id: 'w1:t1' } };
    if (args[0] === 'pane' && args[1] === 'list') result = { panes: [{ pane_id: 'p1', tab_id: 'w1:t1', agent: 'test', agent_status: mocks.busy ? 'blocked' : 'idle' }] };
    cb(null, { stdout: JSON.stringify({ result }) });
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(mocks.home, { recursive: true, force: true });
});

describe.each(['darwin', 'linux'] as const)('herdr ticket spaces on %s', (platform) => {
  it('launches the host terminal and closes only an idle completed ticket space', async () => {
    mocks.home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-herdr-'));
    mocks.calls = [];
    mocks.busy = false;
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const exists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => String(file).endsWith('/ghostty') || String(file).endsWith('Ghostty.app') || exists(file));
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    vi.resetModules();
    const { openInHerdrChat, closeDoneTickets } = await import('../desktop/src/lib/server/terminal-launcher');
    vi.useFakeTimers();
    const opening = openInHerdrChat({ workspace: { id: 'project', name: 'Project', path: mocks.home }, ticket: { id: 'ticket', title: 'Ticket' }, sessionId: 'session', cwd: mocks.home, command: 'true' });
    await vi.runAllTimersAsync();
    await opening;
    expect(mocks.calls).toContainEqual(expect.arrayContaining(['workspace', 'create', '--label', 'Project · Ticket']));
    expect(mocks.calls).toContainEqual(expect.arrayContaining(['tab', 'rename', 'w1:t1', 'Master']));
    if (platform === 'linux') expect(mocks.spawn).toHaveBeenCalledWith('ghostty', ['-e', expect.any(String)], expect.objectContaining({ detached: true }));
    else expect(mocks.calls.some((c) => c[0] === 'osascript')).toBe(true);
    mocks.busy = true;
    await closeDoneTickets(() => 'done');
    expect(mocks.calls.some((c) => c[1] === 'workspace' && c[2] === 'close')).toBe(false);
    mocks.busy = false;
    await closeDoneTickets(() => 'done');
    expect(mocks.calls).toContainEqual(expect.arrayContaining(['workspace', 'close', 'w1']));
    expect(JSON.parse(fs.readFileSync(path.join(mocks.home, 'terminal-launcher-state.json'), 'utf8')).herdr.tickets).toEqual({});
  });
});
