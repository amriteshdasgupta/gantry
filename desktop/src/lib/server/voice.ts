import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './exec';
import { httpError } from './http';

const file = path.join(HOME, 'voice.json');
export interface VoiceSettings {
  transcriptionUrl: string;
  model: string;
}

export function voiceSettings(): VoiceSettings {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { transcriptionUrl: '', model: 'parakeet' };
  }
}

export function localTranscriptionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, 'Enter a local transcription URL.');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || url.search) {
    throw httpError(400, 'Transcription must use an HTTP loopback URL without credentials, query or fragment.');
  }
  return url.href;
}

export function saveVoiceSettings(input: VoiceSettings) {
  if (typeof input.transcriptionUrl !== 'string' || typeof input.model !== 'string' || input.model.length > 100)
    throw httpError(400, 'Invalid voice settings.');
  const next = { transcriptionUrl: input.transcriptionUrl.trim() ? localTranscriptionUrl(input.transcriptionUrl.trim()) : '', model: input.model.trim() };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return next;
}

export async function transcribe(audio: File, signal: AbortSignal) {
  if (!audio.type.startsWith('audio/') || !audio.size || audio.size > 15 * 1024 * 1024) throw httpError(400, 'Send an audio recording of at most 15 MB.');
  const settings = voiceSettings();
  const url = localTranscriptionUrl(settings.transcriptionUrl);
  const form = new FormData();
  form.set('file', audio, 'speech.webm');
  if (settings.model) form.set('model', settings.model);
  const response = await fetch(url, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
  if (!response.ok) throw httpError(502, `Local transcription failed (${response.status}). Check the service and model.`);
  const result = await response.json();
  if (typeof result.text !== 'string' || result.text.length > 8000)
    throw httpError(502, 'The local service must return JSON with a text field of at most 8000 characters.');
  return { text: result.text.trim() };
}
