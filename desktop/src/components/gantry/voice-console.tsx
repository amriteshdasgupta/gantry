'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { gantry, type TicketView } from '@/lib/client/gantry';
import { routeVoice, workspaceVoiceCommand } from '@/lib/client/voice-routing';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  error?: string;
}

interface AudioTarget {
  active: TicketView[];
  selectedId: string;
}

async function request(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

export function VoiceConsole({ tickets, refresh }: { tickets: TicketView[]; refresh: () => Promise<void> }) {
  const active = tickets.filter((ticket) => ticket.status === 'in_progress');
  const [selected, setSelected] = useState('');
  const selectedId = active.some((ticket) => ticket.id === selected) ? selected : active[0]?.id || '';
  const owner = active.find((ticket) => ticket.id === selectedId);
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [audioPending, setAudioPending] = useState(false);
  const [ambient, setAmbient] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [settings, setSettings] = useState({ transcriptionUrl: '', model: 'parakeet' });
  const [configured, setConfigured] = useState(false);
  const [name, setName] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const listening = useRef(false);
  const answering = useRef(false);
  const answeringMaster = useRef(false);
  const capturing = useRef(false);
  const audioGeneration = useRef(0);
  const audioRequest = useRef<AbortController | null>(null);
  const finishSpeech = useRef<(() => void) | null>(null);
  const current = useRef({ active, selectedId, speak });
  useEffect(() => {
    current.current = { active, selectedId, speak };
  });
  const generation = useRef(0);

  function stopListening() {
    audioGeneration.current++;
    audioRequest.current?.abort();
    listening.current = false;
    setAmbient(false);
    if (timer.current) clearTimeout(timer.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    microphone.current?.getTracks().forEach((track) => track.stop());
    microphone.current = null;
    setRecording(false);
  }

  useEffect(() => {
    alive.current = true;
    const invalidateAudio = () => {
      audioGeneration.current++;
    };
    window.speechSynthesis?.getVoices();
    void request('/api/voice', { action: 'load' })
      .then((result) => {
        if (alive.current) {
          setSettings(result);
          setConfigured(Boolean(result.transcriptionUrl));
        }
      })
      .catch((error) => {
        if (alive.current) setError(error.message);
      });
    const hide = () => {
      if (document.hidden) {
        audioGeneration.current++;
        audioRequest.current?.abort();
        listening.current = false;
        setAmbient(false);
        if (timer.current) clearTimeout(timer.current);
        microphone.current?.getTracks().forEach((track) => track.stop());
        microphone.current = null;
        if (recorder.current?.state === 'recording') recorder.current.stop();
        setRecording(false);
        window.speechSynthesis?.cancel();
        finishSpeech.current?.();
      }
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      alive.current = false;
      invalidateAudio();
      audioRequest.current?.abort();
      listening.current = false;
      if (timer.current) clearTimeout(timer.current);
      microphone.current?.getTracks().forEach((track) => track.stop());
      if (recorder.current?.state === 'recording') recorder.current.stop();
      window.speechSynthesis?.cancel();
      finishSpeech.current?.();
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  useEffect(() => {
    const version = ++generation.current;
    queueMicrotask(() => {
      if (alive.current && generation.current === version) {
        setName(owner?.assistantName || '');
        setMessages([]);
      }
    });
    if (!selectedId) return;
    void request('/api/ticket-chat', { action: 'load-master', ticketId: selectedId })
      .then((result) => {
        if (alive.current && generation.current === version) {
          setMessages(result.messages);
          setBusy(result.busy || answering.current);
        }
      })
      .catch((error) => {
        if (alive.current && generation.current === version) setError(error.message);
      });
  }, [selectedId, owner?.assistantName]);

  useEffect(() => {
    if (!selectedId || !busy) return;
    const interval = setInterval(() => {
      if (answering.current && !answeringMaster.current) return;
      const version = generation.current;
      void request('/api/ticket-chat', { action: 'load-master', ticketId: selectedId })
        .then((result) => {
          if (alive.current && generation.current === version) {
            setMessages(result.messages);
            setBusy(result.busy || answering.current);
          }
        })
        .catch((error) => {
          if (alive.current) setError(error.message);
        });
    }, 2000);
    return () => clearInterval(interval);
  }, [selectedId, busy]);

  async function readAloud(value: string) {
    if (!current.current.speak || !window.speechSynthesis || document.hidden) return;
    const voice = window.speechSynthesis.getVoices().find((voice) => voice.localService && voice.lang.startsWith('en'));
    if (!voice) {
      setError('No local English speaking voice is available. Install a system voice to enable spoken replies.');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(value.replace(/[`#*]/g, '').slice(0, 1800));
    utterance.voice = voice;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        window.speechSynthesis.cancel();
        finish();
      }, 60000);
      const finish = () => {
        clearTimeout(timeout);
        finishSpeech.current = null;
        resolve();
      };
      finishSpeech.current = finish;
      utterance.onend = finish;
      utterance.onerror = finish;
      window.speechSynthesis.speak(utterance);
    });
  }

  async function send(value: string, background = false, audioTarget?: AudioTarget) {
    if (answering.current || !value.trim()) return;
    const workspaceCommand = workspaceVoiceCommand(value);
    if (workspaceCommand && (!background || /^hey gantry\b/i.test(value.trim()))) {
      if (workspaceCommand === 'status') await workspaceStatus();
      else await controlEveryone(workspaceCommand);
      return;
    }
    const target = audioTarget ?? current.current;
    const routed = routeVoice(value, target.active, target.selectedId, background);
    if (!routed || !routed.ticketId) return;
    if (!current.current.active.some((ticket) => ticket.id === routed.ticketId)) {
      throw new Error('The recorded ticket is no longer in progress. Select a ticket and record again.');
    }
    answering.current = true;
    answeringMaster.current = true;
    audioGeneration.current++;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    setBusy(true);
    setError('');
    setSelected(routed.ticketId);
    setText('');
    try {
      const result = await request('/api/ticket-chat', { action: 'send-master', ticketId: routed.ticketId, text: routed.text });
      if (!alive.current) return;
      if (current.current.selectedId === routed.ticketId) setMessages(result.messages);
      const answer = result.messages.at(-1) as Message;
      if (answer.error) setError(answer.error);
      else await readAloud(answer.text);
      await refresh();
    } finally {
      answering.current = false;
      answeringMaster.current = false;
      if (alive.current) setBusy(false);
      if (alive.current && listening.current && !capturing.current) void record(true);
    }
  }

  async function record(background = false) {
    if (answering.current || capturing.current || document.hidden || !alive.current) return;
    capturing.current = true;
    setAudioPending(true);
    const version = audioGeneration.current;
    const target: AudioTarget = { active: [...current.current.active], selectedId: current.current.selectedId };
    const controller = new AbortController();
    audioRequest.current = controller;
    let stream: MediaStream | undefined;
    let capture: MediaRecorder | undefined;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    let released = false;

    const valid = () =>
      alive.current && !document.hidden && version === audioGeneration.current && !controller.signal.aborted && (!background || listening.current);

    const release = () => {
      if (released) return;
      released = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (microphone.current === stream) microphone.current = null;
      if (recorder.current === capture) recorder.current = null;
      if (captureTimer) clearTimeout(captureTimer);
      if (timer.current === captureTimer) timer.current = null;
      if (audioRequest.current === controller) audioRequest.current = null;
      capturing.current = false;
      if (alive.current) {
        setRecording(false);
        setAudioPending(false);
        if (listening.current && !answering.current) void record(true);
      }
    };

    window.speechSynthesis?.cancel();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!valid()) {
        release();
        return;
      }
      microphone.current = stream;
      capture = new MediaRecorder(stream);
      recorder.current = capture;
      const chunks: Blob[] = [];
      capture.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      capture.onstop = () => {
        stream?.getTracks().forEach((track) => track.stop());
        if (captureTimer) clearTimeout(captureTimer);
        if (!valid()) {
          release();
          return;
        }
        setRecording(false);
        let dispatched = false;
        void (async () => {
          const form = new FormData();
          form.set('file', new Blob(chunks, { type: capture!.mimeType }), 'speech.webm');
          const response = await fetch('/api/voice', { method: 'POST', body: form, signal: controller.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Transcription failed.');
          if (!valid()) return;
          if (result.text) {
            setText(result.text);
            dispatched = true;
            await send(result.text, background, target);
          }
        })()
          .catch((error) => {
            if (valid() || (dispatched && alive.current && !document.hidden && !controller.signal.aborted)) {
              setError(error.message);
              stopListening();
            }
          })
          .finally(release);
      };
      capture.start();
      setRecording(true);
      captureTimer = setTimeout(
        () => {
          if (capture?.state === 'recording') capture.stop();
        },
        background ? 6000 : 30000,
      );
      timer.current = captureTimer;
    } catch (error) {
      if (valid()) {
        setError((error as Error).message);
        stopListening();
      }
      release();
    }
  }

  async function workspaceStatus() {
    answering.current = true;
    setBusy(true);
    audioGeneration.current++;
    audioRequest.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    try {
      const fresh = await gantry.status();
      const ids = new Set(current.current.active.map((ticket) => ticket.id));
      const summary = fresh.tickets
        .filter((ticket) => ids.has(ticket.id))
        .map((ticket) => `${ticket.assistantName}: ${ticket.title}. ${ticket.execution?.state || ticket.status}. ${ticket.execution?.message || ''}`)
        .join('\n\n');
      if (!alive.current) return;
      setMessages([{ role: 'assistant', text: summary || 'No tickets are in progress.' }]);
      await readAloud(summary);
    } finally {
      answering.current = false;
      if (alive.current) setBusy(false);
      if (alive.current && listening.current && !capturing.current) void record(true);
    }
  }

  async function controlEveryone(action: 'pause' | 'resume') {
    answering.current = true;
    setBusy(true);
    audioGeneration.current++;
    audioRequest.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    try {
      const results: string[] = [];
      for (const ticket of current.current.active.filter(
        (ticket) => ticket.execution && (action === 'pause' ? ticket.execution.state === 'running' : ticket.execution.state === 'paused'),
      )) {
        try {
          await request('/api/workflow-execution', { ticketId: ticket.id, action });
          results.push(`${ticket.assistantName}: ${action === 'pause' ? 'paused' : 'resumed'}.`);
        } catch (error) {
          results.push(`${ticket.assistantName}: ${(error as Error).message}`);
        }
      }
      const text = results.join('\n') || `No workflows can ${action} right now.`;
      setMessages([{ role: 'assistant', text }]);
      await refresh();
      await readAloud(text);
    } finally {
      answering.current = false;
      if (alive.current) setBusy(false);
      if (alive.current && listening.current && !capturing.current) void record(true);
    }
  }

  return (
    <section aria-label="Workspace voice control" className="max-h-[65dvh] space-y-3 overflow-y-auto border-b bg-muted/20 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Talk to your tickets</strong>
        <select
          aria-label="Ticket assistant"
          value={selectedId}
          onChange={(event) => setSelected(event.target.value)}
          disabled={busy || ambient || audioPending}
          className="max-w-96 rounded-lg border bg-background p-2 text-sm"
        >
          {active.map((ticket) => (
            <option key={ticket.id} value={ticket.id}>
              {ticket.assistantName} · {ticket.title}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void workspaceStatus().catch((error) => setError(error.message))}>
          Everyone’s status
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void controlEveryone('pause').catch((error) => setError(error.message))}>
          Pause everyone
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void controlEveryone('resume').catch((error) => setError(error.message))}>
          Resume everyone
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={speak}
            onChange={(event) => {
              setSpeak(event.target.checked);
              if (!event.target.checked) {
                window.speechSynthesis?.cancel();
                finishSpeech.current?.();
              }
            }}
          />
          Speak replies locally
        </label>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            window.speechSynthesis?.cancel();
            finishSpeech.current?.();
          }}
        >
          Silence
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Say “Hey {owner?.assistantName || 'Maya'}, what needs me?” or select a ticket. Wispr Flow and system dictation work in the message field. Listening uses
        your local transcription service and stops when Gantry is hidden.
      </p>
      {messages.length > 0 && (
        <div role="log" aria-label="Master conversation" className="max-h-56 space-y-3 overflow-y-auto rounded-lg border bg-background p-3 text-sm">
          {messages.map((message, index) => (
            <div key={index}>
              <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
              <p className="whitespace-pre-wrap">{message.text}</p>
              {message.error && <p className="text-destructive">{message.error}</p>}
            </div>
          ))}
        </div>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(text).catch((error) => setError(error.message));
        }}
      >
        <Textarea
          aria-label="Message your ticket assistant"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Hey Maya, pause the workflow and tell me what’s blocked…"
          disabled={!owner || busy || audioPending}
          className="min-h-16"
        />
        <Button type="submit" disabled={!owner || busy || audioPending || !text.trim()}>
          Send
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!owner || busy || !configured || ambient || (audioPending && !recording)}
          onClick={() => (recording ? recorder.current?.stop() : void record())}
        >
          {recording ? 'Finish recording' : 'Talk'}
        </Button>
        <Button
          type="button"
          variant={ambient ? 'default' : 'outline'}
          disabled={!owner || (!ambient && (busy || !configured || audioPending))}
          onClick={() => {
            if (ambient) stopListening();
            else {
              listening.current = true;
              setAmbient(true);
              void record(true);
            }
          }}
        >
          {ambient ? 'Stop listening' : 'Listen for names'}
        </Button>
        {busy && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void request('/api/ticket-chat', { action: 'stop-master', ticketId: selectedId }).catch((error) => setError(error.message))}
          >
            Stop reply
          </Button>
        )}
      </form>
      <p role="status" className="text-xs">
        {recording
          ? 'Microphone on — recording locally'
          : ambient
            ? 'Listening paused while transcribing or answering'
            : busy
              ? 'Assistant is answering…'
              : audioPending
                ? 'Preparing microphone or transcribing locally…'
                : 'Microphone off'}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm">Voice and assistant settings</summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs">
            Local transcription URL
            <Input
              aria-label="Local transcription URL"
              placeholder="http://127.0.0.1:8000/v1/audio/transcriptions"
              value={settings.transcriptionUrl}
              onChange={(event) => setSettings({ ...settings, transcriptionUrl: event.target.value })}
              className="w-96 max-w-full"
            />
          </label>
          <label className="space-y-1 text-xs">
            Model
            <Input aria-label="Transcription model" value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void request('/api/voice', { action: 'save', ...settings })
                .then((result) => {
                  setConfigured(Boolean(result.transcriptionUrl));
                  setError('');
                })
                .catch((error) => setError(error.message))
            }
          >
            Save voice settings
          </Button>
          <label className="space-y-1 text-xs">
            Assistant name
            <Input aria-label="Assistant name" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!owner || busy}
            onClick={() =>
              void gantry
                .updateTicket(selectedId, { assistantName: name })
                .then(refresh)
                .catch((error) => setError(error.message))
            }
          >
            Rename assistant
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Parakeet, Whisper or another local service must accept multipart file/model and return JSON with text. No remote speech fallback. Model conversations
          use your configured coding provider. Name listening transcribes six-second clips; only “Hey name” starts an assistant turn.
        </p>
      </details>
    </section>
  );
}
