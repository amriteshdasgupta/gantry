import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const home = path.resolve('e2e/.tmp/home');
const herdr = path.resolve('e2e/bin/herdr');
const launches = () => fs.readFileSync(path.join(home, 'external-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// The stand-ins in e2e/bin: Ghostty first on PATH on Linux; Terminal through osascript on macOS, where Ghostty is hidden.
const stand_in = process.platform === 'darwin' ? { id: 'terminal', label: 'Terminal' } : { id: 'ghostty', label: 'Ghostty' };

test.describe.configure({ mode: 'serial' });

test('Settings lists the installed terminal apps and saves the choice', async ({ page, request }) => {
  const settings = await (await request.get('/api/terminal-launcher')).json();
  expect(settings.available).toContainEqual(stand_in);
  expect(settings.terminalApp).toBe(stand_in.id);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Chats open in herdr' })).toBeVisible();
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Chats open in herdr' }) });
  for (const t of settings.available) await expect(section.getByRole('button', { name: t.label, exact: true })).toBeVisible();
  await section.getByRole('button', { name: stand_in.label, exact: true }).click();
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('herdr settings saved')).toBeVisible();
  expect((await (await request.get('/api/terminal-launcher')).json()).terminalApp).toBe(stand_in.id);
});

test('a terminal app that is not installed is refused', async ({ request }) => {
  const res = await request.post('/api/terminal-launcher', { data: { terminalApp: 'not-a-terminal' } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain('Choose a terminal app installed on this computer.');
  expect((await (await request.get('/api/terminal-launcher')).json()).terminalApp).toBe(stand_in.id);
});

test('opening a chat with no herdr window shows herdr in the chosen terminal app', async ({ request }) => {
  // Gantry finds herdr windows from every process on the machine, so a real herdr client counts as one.
  const clients = execFileSync('ps', ['-axo', 'comm=,args=']).toString().split('\n').filter((l) => /^herdr\s/.test(l) && !l.includes('herdr server'));
  test.skip(clients.length > 0, 'a real herdr window is open on this machine');
  const before = launches().length;
  const opened = await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'open' } });
  expect(opened.ok()).toBe(true);
  const shown = launches().slice(before).filter((c) => c.command !== 'herdr');
  if (process.platform === 'darwin') {
    expect(shown).toHaveLength(1);
    expect(shown[0].command).toBe('osascript');
    expect(shown[0].args.slice(2)).toEqual([`'${herdr}'`, expect.any(String)]);
  } else {
    expect(shown).toEqual([{ command: 'ghostty', args: ['-e', herdr] }]);
  }
});
