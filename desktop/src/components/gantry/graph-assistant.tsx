'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAgents } from '@/lib/client/agents';
import type { Workflow } from '@/lib/client/gantry';
import { graphAssistantResponseSchema, type GraphAssistantResponse } from '@/lib/graph-assistant';

type Message = { role: 'user' | 'assistant'; text: string };
type Proposal = { response: GraphAssistantResponse; base: string };

export function GraphAssistant({ graph, disabled, onApply }: { graph: Workflow; disabled: boolean; onApply: (graph: Workflow) => void }) {
  const agents = useAgents();
  const [providerId, setProviderId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [undo, setUndo] = useState<{ before: Workflow; after: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const current = JSON.stringify(graph);
  const stale = proposal !== null && proposal.base !== current;

  useEffect(() => () => controller.current?.abort(), []);

  async function send() {
    const request = prompt.trim();
    if (!request || busy || disabled) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    setProposal(null);

    try {
      const res = await fetch('/api/graph-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({ graph, prompt: request, providerId: providerId || undefined, history: messages.slice(-12) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'The graph assistant could not respond.');
      const response = graphAssistantResponseSchema.parse(data);
      if (abort.signal.aborted) return;

      setProposal({ response, base: current });
      setMessages((previous) => [...previous, { role: 'user', text: request }, { role: 'assistant', text: response.message }].slice(-12) as Message[]);
      setPrompt('');
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <aside aria-label="Graph assistant" className="flex max-h-[600px] w-80 shrink-0 flex-col gap-3 border-l bg-background p-4">
      <h3 className="font-medium">Graph assistant</h3>
      <p className="text-xs text-muted-foreground">Describe a new graph or a change. Review the proposal, apply it to your draft, then save when ready.</p>
      <label className="space-y-1 text-xs">
        Assistant provider
        <select
          aria-label="Assistant provider"
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={providerId}
          disabled={busy}
          onChange={(e) => setProviderId(e.target.value)}
        >
          <option value="">Default provider</option>
          {agents?.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <div role="log" aria-label="Graph conversation" className="min-h-12 flex-1 space-y-3 overflow-auto text-sm">
        {messages.map((message, index) => (
          <p key={index} className="whitespace-pre-wrap break-words">
            <span className="font-medium">{message.role === 'user' ? 'You' : 'Assistant'}: </span>
            {message.text}
          </p>
        ))}
        {busy && (
          <p role="status" className="text-muted-foreground">
            Designing your graph… You can keep editing the canvas.
          </p>
        )}
      </div>
      {proposal && (
        <div className="space-y-2 rounded-md border p-3 text-xs">
          <p>
            {proposal.response.graph.nodes.length} nodes · {proposal.response.graph.edges?.length ?? 0} connections
          </p>
          {stale && <p role="status">The draft changed. Send your request again to use the latest graph.</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={disabled || stale || busy}
              onClick={() => {
                setUndo({ before: graph, after: JSON.stringify(proposal.response.graph) });
                onApply(proposal.response.graph);
                setProposal(null);
              }}
            >
              Apply proposal
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {undo && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy || current !== undo.after}
          onClick={() => {
            onApply(undo.before);
            setUndo(null);
            setProposal(null);
          }}
        >
          Undo assistant change
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Textarea
          aria-label="Graph request"
          placeholder="Add a review stage that loops back when changes are needed…"
          value={prompt}
          maxLength={10000}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={disabled || busy || !prompt.trim()}>
            Send request
          </Button>
          {busy && (
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => {
                controller.current?.abort();
                setBusy(false);
              }}
            >
              Stop
            </Button>
          )}
        </div>
      </form>
    </aside>
  );
}
