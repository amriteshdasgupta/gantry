import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const home = path.resolve('e2e/.tmp/home');
const herdr = path.resolve('e2e/bin/herdr');
const launches = () => fs.readFileSync(path.join(home, 'external-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// The terminal stand-ins in e2e/bin. Ghostty is first in the launcher's list, so it is the default
// and shadows a real Ghostty on this machine.
const stand_in = { id: 'ghostty', label: 'Ghostty' };
const stand_ins = [stand_in, { id: 'kitty', label: 'kitty' }, { id: 'alacritty', label: 'Alacritty' }];

test.describe.configure({ mode: 'serial' });
test.skip(process.platform !== 'linux', 'covers the Linux terminal apps only');

test('Settings lists the installed terminal apps and saves the choice', async ({ page, request }) => {
  const settings = await (await request.get('/api/terminal-launcher')).json();
  // Real terminals on this machine are listed too, so only the stand-ins and their order are checked.
  expect(settings.available.filter((t: { id: string }) => stand_ins.some((s) => s.id === t.id))).toEqual(stand_ins);
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

// Each terminal takes the program to run in its own form.
for (const [id, args] of [['ghostty', ['-e', herdr]], ['kitty', [herdr]], ['alacritty', ['-e', herdr]]] as const) {
  test(`opening a chat with no herdr window shows herdr in ${id}`, async ({ request }) => {
    // Gantry finds herdr windows from every process on the machine, so a real herdr client counts as one.
    const clients = execFileSync('ps', ['-axo', 'comm=,args=']).toString().split('\n').filter((l) => /^herdr\s/.test(l) && !l.includes('herdr server'));
    test.skip(clients.length > 0, 'a real herdr window is open on this machine');
    expect((await request.post('/api/terminal-launcher', { data: { terminalApp: id } })).ok()).toBe(true);
    const before = launches().length;
    const opened = await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'open' } });
    expect(opened.ok()).toBe(true);
    const shown = launches().slice(before).filter((c) => c.command !== 'herdr');
    expect(shown).toEqual([{ command: id, args }]);
  });
}

// Later specs share this home, so they get the default stand-in back.
test.afterAll(async ({ request }) => {
  await request.post('/api/terminal-launcher', { data: { terminalApp: stand_in.id } });
});
