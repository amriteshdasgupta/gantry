import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const home = path.resolve('e2e/.tmp/home');
const masterFile = path.join(home, 'ticket-conversations/master/ticket-1.json');
const runFile = path.join(home, 'workflow-runs/ticket-1.json');

async function mockRecording(page: Page, deferPermission = false) {
  await page.addInitScript((defer) => {
    let grant: (() => void) | undefined;
    const recordings: { stop: () => void }[] = [];
    const fixture = {
      started: 0,
      stoppedTracks: 0,
      finish: () => recordings.at(-1)?.stop(),
      grant: () => grant?.(),
    };
    Object.defineProperty(window, 'voiceReview', { value: fixture });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => {
          if (defer) {
            defer = false;
            await new Promise<void>((resolve) => {
              grant = resolve;
            });
          }
          return {
            getTracks: () => [
              {
                stop: () => {
                  fixture.stoppedTracks++;
                },
              },
            ],
          };
        },
      },
    });
    Object.defineProperty(window, 'MediaRecorder', {
      value: class {
        state = 'inactive';
        mimeType = 'audio/webm';
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;

        start() {
          this.state = 'recording';
          fixture.started++;
          recordings.push(this);
        }

        stop() {
          if (this.state !== 'recording') return;
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: this.mimeType }) });
          setTimeout(() => this.onstop?.(), 0);
        }
      },
    });
  }, deferPermission);
}

async function finishRecording(page: Page) {
  await page.evaluate(() => (window as unknown as { voiceReview: { finish: () => void } }).voiceReview.finish());
}

for (const kind of ['codex', 'opencode'] as const) {
  test(`${kind} master replies retain their checkout-scoped session on follow-up`, async ({ request }) => {
    const agent = await (
      await request.post('/api/agents', { data: { kind, name: `Speaking ${kind}`, model: kind === 'opencode' ? 'openai/fixture' : '' } })
    ).json();
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    fs.writeFileSync(runFile, JSON.stringify({ ...run, defaultProviderId: agent.id }));
    try {
      const first = await (await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'Status please' } })).json();
      expect(first.messages.at(-1).error).toBeUndefined();
      expect(first.conversation.sessionId).toBeTruthy();
      const second = await (await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'Follow up please' } })).json();
      expect(second.messages.at(-1).error).toBeUndefined();
      expect(second.conversation.sessionId).toBe(first.conversation.sessionId);
      expect(second.messages.at(-1).text).toContain(kind === 'codex' ? 'Codex again' : 'OpenCode following up');
    } finally {
      await request.delete(`/api/agents?id=${agent.id}`);
    }
  });
}

test('a master session already open interactively cannot receive a second writer', async ({ request }) => {
  await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'Status please' } });
  const record = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
  const terminal = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'codex', 'resume', record.sessionId]);
  await new Promise<void>((resolve) => terminal.once('spawn', resolve));
  try {
    const response = await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'Second writer' } });
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toContain('only one writer');
  } finally {
    terminal.kill();
    await new Promise<void>((resolve) => terminal.once('exit', () => resolve()));
  }
});

test.beforeEach(async ({ request }) => {
  fs.rmSync(masterFile, { force: true });
  const graph = { nodes: [{ id: 'plan', label: 'Plan', kind: 'agent', instructions: 'Plan', dependsOn: [] }] };
  await request.post('/api/gantry/api/projects/fixture/workflow', { data: graph });
  await request.post('/api/gantry/api/projects/fixture/tickets', { data: { title: 'Speaking fixture', assistantName: 'Maya Reed' } });
  await request.post('/api/gantry/api/tickets/ticket-1/update', { data: { status: 'in_progress' } });
  await request.patch('/api/agents', { data: { id: 'claude', current: true } });
  fs.mkdirSync(path.dirname(runFile), { recursive: true });
  fs.writeFileSync(
    runFile,
    JSON.stringify({
      ticketId: 'ticket-1',
      projectId: 'fixture',
      graph,
      state: 'paused',
      message: 'Paused by you.',
      steps: { plan: 'pending' },
      defaultProviderId: 'claude',
      updatedAt: 1,
      attempts: [],
    }),
  );
});

test.afterEach(async ({ request }) => {
  await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'stop-master' } });
  await request.post('/api/voice', { data: { action: 'save', transcriptionUrl: '', model: 'parakeet' } });
  fs.rmSync(runFile, { force: true });
});

test('master messages resume the saved provider session without advancing a paused graph', async ({ request }) => {
  const plainFile = path.join(home, 'ticket-conversations/ticket-1.json');
  const plainBefore = fs.existsSync(plainFile) ? fs.readFileSync(plainFile, 'utf8') : null;
  const first = await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'What needs me?' } });
  expect(first.ok(), await first.text()).toBe(true);
  const reply = await first.json();
  expect(reply.messages.at(-1).text).toContain('Reading the change');
  expect(reply.messages.at(-1).error).toBeUndefined();
  const second = await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'And now?' } });
  const next = await second.json();
  expect(next.messages).toHaveLength(4);
  expect(next.messages.at(-1).text).toContain('Following up');
  expect(next.conversation.sessionId).toBe(reply.conversation.sessionId);
  const loaded = await (await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'load-master' } })).json();
  expect(loaded.messages).toEqual(next.messages);
  expect(loaded.busy).toBe(false);
  expect(JSON.parse(fs.readFileSync(runFile, 'utf8')).state).toBe('paused');
  expect(fs.existsSync(plainFile) ? fs.readFileSync(plainFile, 'utf8') : null).toBe(plainBefore);
});

test('concurrent turns and terminal opens are refused and a stopped turn stays in history', async ({ request }) => {
  const pending = request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'SLOW question' } });
  await expect
    .poll(async () => (await (await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'load-master' } })).json()).busy)
    .toBe(true);
  expect((await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'send-master', text: 'Another question' } })).status()).toBe(409);
  expect((await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'open' } })).status()).toBe(409);
  await request.post('/api/ticket-chat', { data: { ticketId: 'ticket-1', action: 'stop-master' } });
  expect((await (await pending).json()).messages.at(-1).error).toBe('Stopped.');
});

test('speech settings reject remote servers and cross-origin calls; local multipart transcription works', async ({ request }) => {
  expect(
    (
      await request.post('/api/voice', { data: { action: 'save', transcriptionUrl: 'https://example.com/v1/audio/transcriptions', model: 'parakeet' } })
    ).status(),
  ).toBe(400);
  expect((await request.post('/api/voice', { headers: { Origin: 'https://example.com' }, data: { action: 'load' } })).status()).toBe(403);
  let upload = '';
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) upload += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: 'Hey Maya Reed, what needs me?' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const settings = await request.post('/api/voice', {
      data: { action: 'save', transcriptionUrl: `http://127.0.0.1:${address.port}/v1/audio/transcriptions`, model: 'parakeet' },
    });
    expect(settings.ok()).toBe(true);
    const result = await request.post('/api/voice', {
      multipart: { file: { name: 'speech.webm', mimeType: 'audio/webm', buffer: Buffer.from('fixture audio') } },
    });
    expect(await result.json()).toEqual({ text: 'Hey Maya Reed, what needs me?' });
    expect(upload).toContain('name="model"');
    expect(upload).toContain('parakeet');
    expect(upload).toContain('fixture audio');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('workspace console routes dictated text, shows replies and reloads persisted history', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
  const console = page.getByRole('region', { name: 'Workspace voice control' });
  await expect(console.getByRole('combobox', { name: 'Ticket assistant' })).toContainText('Maya Reed');
  await console.getByRole('textbox', { name: 'Message your ticket assistant' }).fill('Hey Maya Reed, what needs me?');
  await console.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(console.getByRole('log')).toContainText('Reading the change');
  await expect(console.getByRole('log')).toContainText('what needs me?');
  await page.reload();
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
  await expect(console.getByRole('log')).toContainText('Reading the change');
  await console.getByRole('button', { name: 'Everyone’s status' }).click();
  await expect(console.getByRole('log')).toContainText('Maya Reed: Speaking fixture. paused.');
});

test('microphone input routes a local transcript, uses a local speaking voice, and releases recording on close', async ({ page, request }) => {
  await request.post('/api/voice', { data: { action: 'save', transcriptionUrl: 'http://127.0.0.1:9999/v1/audio/transcriptions', model: 'parakeet' } });
  await page.addInitScript(() => {
    const fixture = { stoppedTracks: 0, spokenVoice: '', spokenText: '' };
    Object.defineProperty(window, 'voiceFixture', { value: fixture });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({
          getTracks: () => [
            {
              stop: () => {
                fixture.stoppedTracks++;
              },
            },
          ],
        }),
      },
    });
    Object.defineProperty(window, 'MediaRecorder', {
      value: class {
        state = 'inactive';
        mimeType = 'audio/webm';
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        start() {
          this.state = 'recording';
        }
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: this.mimeType }) });
          setTimeout(() => this.onstop?.(), 0);
        }
      },
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
    });
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        getVoices: () => [
          { name: 'Remote', localService: false, lang: 'en-US' },
          { name: 'Local', localService: true, lang: 'en-US' },
        ],
        cancel: () => {},
        speak: (utterance: { voice: { name: string }; text: string; onend: () => void }) => {
          fixture.spokenVoice = utterance.voice.name;
          fixture.spokenText = utterance.text;
          setTimeout(() => utterance.onend(), 0);
        },
      },
    });
  });
  await page.route('**/api/voice', async (route) => {
    if (route.request().headers()['content-type']?.startsWith('multipart/form-data')) {
      await route.fulfill({ json: { text: 'Hey Maya Reed, what needs me?' } });
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
  const console = page.getByRole('region', { name: 'Workspace voice control' });
  await console.getByRole('checkbox', { name: 'Speak replies locally' }).check();
  await console.getByRole('button', { name: 'Talk', exact: true }).click();
  await expect(console.getByRole('status')).toContainText('Microphone on');
  await console.getByRole('button', { name: 'Finish recording' }).click();
  await expect(console.getByRole('log')).toContainText('Reading the change');
  const state = () =>
    page.evaluate(() => (window as unknown as { voiceFixture: { stoppedTracks: number; spokenVoice: string; spokenText: string } }).voiceFixture);
  await expect.poll(async () => (await state()).spokenVoice).toBe('Local');
  expect((await state()).spokenText).toContain('Reading the change');
  await expect(console.getByRole('button', { name: 'Listen for names' })).toBeEnabled();
  await console.getByRole('button', { name: 'Listen for names' }).click();
  await expect(console.getByRole('status')).toContainText('Microphone on');
  const beforeClose = (await state()).stoppedTracks;
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
  await expect.poll(async () => (await state()).stoppedTracks).toBeGreaterThan(beforeClose);
});

for (const removeOriginal of [false, true]) {
  test(`pending audio ${removeOriginal ? 'is discarded when its ticket leaves progress' : 'keeps its original ticket when the list changes'}`, async ({
    page,
    request,
  }) => {
    await mockRecording(page);
    await request.post('/api/voice', { data: { action: 'save', transcriptionUrl: 'http://127.0.0.1:9999/transcribe', model: 'parakeet' } });
    const status = await (await request.get('/api/gantry/api/status')).json();
    const original = status.tickets[0];
    const other = { ...original, id: 'ticket-2', title: 'Other ticket', assistantName: 'Theo Ellis', execution: undefined };
    let visibleTickets = [original, other];
    await page.route('**/api/gantry/api/status', (route) => route.fulfill({ json: { ...status, tickets: visibleTickets } }));
    const sent: { ticketId: string; text: string }[] = [];
    await page.route('**/api/ticket-chat', (route) => {
      const body = route.request().postDataJSON();
      if (body.action === 'send-master') sent.push(body);
      return route.fulfill({ json: { messages: body.action === 'send-master' ? [{ role: 'assistant', text: 'Paused.' }] : [], busy: false } });
    });
    let release!: () => void;
    const transcriptReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transcribing = false;
    await page.route('**/api/voice', async (route) => {
      if (!route.request().headers()['content-type']?.startsWith('multipart/form-data')) return route.continue();
      transcribing = true;
      await transcriptReady;
      await route.fulfill({ json: { text: 'Pause the workflow' } });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Voice control', exact: true }).click();
    const console = page.getByRole('region', { name: 'Workspace voice control' });
    const selector = console.getByRole('combobox', { name: 'Ticket assistant' });
    await expect(selector).toHaveValue('ticket-1');
    await console.getByRole('button', { name: 'Talk', exact: true }).click();
    await expect(selector).toBeDisabled();
    await console.getByRole('button', { name: 'Finish recording' }).click();
    await expect.poll(() => transcribing).toBe(true);
    await expect(selector).toBeDisabled();

    // The selected fallback can change during a refresh even while its control is disabled.
    visibleTickets = removeOriginal ? [other] : [other, original];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(selector).toHaveValue('ticket-2');
    release();

    if (removeOriginal) {
      await expect(console.getByRole('alert')).toContainText('recorded ticket is no longer in progress');
      expect(sent).toEqual([]);
      await expect(selector).toHaveValue('ticket-2');
    } else {
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]).toMatchObject({ ticketId: 'ticket-1', text: 'Pause the workflow' });
    }
    await expect(console.getByRole('button', { name: 'Talk', exact: true })).toBeEnabled();
  });
}

test('recording modes serialize permission and transcription, then recover after cancelling ambient audio', async ({ page, request }) => {
  await mockRecording(page, true);
  await request.post('/api/voice', { data: { action: 'save', transcriptionUrl: 'http://127.0.0.1:9999/transcribe', model: 'parakeet' } });
  let uploads = 0;
  let releaseAmbient!: () => void;
  const ambientReady = new Promise<void>((resolve) => {
    releaseAmbient = resolve;
  });
  let releaseTalk!: () => void;
  const talkReady = new Promise<void>((resolve) => {
    releaseTalk = resolve;
  });
  await page.route('**/api/voice', async (route) => {
    if (!route.request().headers()['content-type']?.startsWith('multipart/form-data')) return route.continue();
    uploads++;
    await (uploads === 1 ? talkReady : ambientReady);
    await route.fulfill({ json: { text: '' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
  const console = page.getByRole('region', { name: 'Workspace voice control' });
  const listen = console.getByRole('button', { name: 'Listen for names' });
  const talk = console.getByRole('button', { name: 'Talk', exact: true });
  await talk.click();
  await expect(listen).toBeDisabled();
  await page.evaluate(() => (window as unknown as { voiceReview: { grant: () => void } }).voiceReview.grant());
  await expect(console.getByRole('status')).toContainText('Microphone on');
  await expect(listen).toBeDisabled();
  await console.getByRole('button', { name: 'Finish recording' }).click();
  await expect.poll(() => uploads).toBe(1);
  await expect(listen).toBeDisabled();
  releaseTalk();
  await expect(listen).toBeEnabled();
  await listen.click();
  await expect(console.getByRole('status')).toContainText('Microphone on');
  await finishRecording(page);
  await expect.poll(() => uploads).toBe(2);
  await console.getByRole('button', { name: 'Stop listening' }).click();
  await expect(talk).toBeEnabled();
  await talk.click();
  await expect(console.getByRole('status')).toContainText('Microphone on');
  releaseAmbient();
  // A late result from the cancelled mode must not clear or restart the new recording.
  await expect.poll(() => page.evaluate(() => (window as unknown as { voiceReview: { started: number } }).voiceReview.started)).toBe(3);
  await expect(console.getByRole('button', { name: 'Finish recording' })).toBeEnabled();
  await expect(console.getByRole('status')).toContainText('Microphone on');
  await finishRecording(page);
  await expect(listen).toBeEnabled();
  await listen.click();
  await expect(console.getByRole('status')).toContainText('Microphone on');
  await finishRecording(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { voiceReview: { started: number } }).voiceReview.started)).toBe(5);
  await expect(console.getByRole('status')).toContainText('Microphone on');
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
});

test('stopping name listening while microphone permission is pending allows a fresh recording after permission settles', async ({ page, request }) => {
  await mockRecording(page, true);
  await request.post('/api/voice', { data: { action: 'save', transcriptionUrl: 'http://127.0.0.1:9999/transcribe', model: 'parakeet' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
  const console = page.getByRole('region', { name: 'Workspace voice control' });
  const talk = console.getByRole('button', { name: 'Talk', exact: true });
  await console.getByRole('button', { name: 'Listen for names' }).click();
  await console.getByRole('button', { name: 'Stop listening' }).click();
  await expect(talk).toBeDisabled();
  await page.evaluate(() => (window as unknown as { voiceReview: { grant: () => void } }).voiceReview.grant());
  await expect(talk).toBeEnabled();
  await talk.click();
  await expect(console.getByRole('status')).toContainText('Microphone on');
  await expect.poll(() => page.evaluate(() => (window as unknown as { voiceReview: { started: number } }).voiceReview.started)).toBe(1);
  await page.getByRole('button', { name: 'Voice control', exact: true }).click();
});
