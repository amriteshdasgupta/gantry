'use client';
import { useEffect, useState } from 'react';
import { PlayIcon, PauseIcon, RotateCcwIcon, MessageSquareIcon, GitPullRequestIcon, ShieldCheckIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { TicketView } from '@/lib/client/gantry';
import type { Execution } from '@/lib/server/workflow-state';
import { runNow, runTimeline, type NowTone } from '@/lib/client/workflow-timeline';
import { permissionLabel } from '@/lib/opencode-permissions';

const formatDeliverable = (d: { repo: string; url: string; title: string }) => `${d.repo}:${d.url} ${d.title}`;
const toneDot: Record<NowTone, string> = {
  running: 'bg-sky-500',
  waiting: 'bg-amber-500',
  blocked: 'bg-red-500',
  failed: 'bg-red-500',
  paused: 'bg-zinc-400',
  done: 'bg-emerald-500',
};
const time = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Tools this workspace's Claude stages may use without asking. */
function StagePermissions({ projectId, refreshKey }: { projectId: string; refreshKey: unknown }) {
  const [allow, setAllow] = useState<string[]>([]);
  const [common, setCommon] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/stage-permissions?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d) => {
        setAllow(d.allow ?? []);
        setCommon(d.common ?? []);
      })
      .catch(() => {});
  }, [projectId, refreshKey]);
  async function update(add: string[], remove: string[] = []) {
    setError('');
    const r = await fetch('/api/stage-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, add, remove }),
    });
    const d = await r.json();
    if (!r.ok) return setError(d.error || 'Could not save.');
    setAllow(d.allow);
    setDraft('');
  }
  const missingCommon = common.filter((c) => !allow.includes(c));
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">Tools Claude stages may use in this workspace · {allow.length}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          Every Claude stage and stage chat in this workspace gets these without asking. Codex stages already run with full access.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {allow.map((rule) => (
            <span key={rule} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs">
              {rule}
              <button type="button" aria-label={`Remove ${rule}`} className="text-muted-foreground hover:text-foreground" onClick={() => void update([], [rule])}>
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
          {!allow.length && <span className="text-xs text-muted-foreground">Nothing yet.</span>}
        </div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void update([draft.trim()]);
          }}
        >
          <input
            aria-label="Tool rule to allow"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 font-mono text-xs"
            placeholder="e.g. Bash(mix test *), mcp__github, WebFetch(domain:shopify.dev)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button size="xs" type="submit" variant="outline" disabled={!draft.trim()}>
            Allow
          </Button>
        </form>
        {missingCommon.length > 0 && (
          <Button size="xs" variant="ghost" onClick={() => void update(missingCommon)} title={missingCommon.join(', ')}>
            Add common tools (git, gh, mix, npm, web, edits)
          </Button>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </details>
  );
}

export function ExecutionControls({
  ticket,
  selected,
  refresh,
  onSelect,
}: {
  ticket: TicketView;
  selected: string;
  refresh: () => Promise<unknown>;
  onSelect?: (nodeId: string) => void;
}) {
  const [run, setRun] = useState<Execution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [unchecked, setUnchecked] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`/api/workflow-execution?ticketId=${encodeURIComponent(ticket.id)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error('Could not load workflow execution.');
          return r.json();
        })
        .then((data) => {
          if (live) setRun(data);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ticket.id]);
  async function action(name: string, opts: { nodeId?: string; optionId?: string; rules?: string[] } = {}) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/workflow-execution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId: ticket.id,
          action: name,
          nodeId: opts.nodeId ?? selected,
          message: reply,
          ...(opts.optionId ? { optionId: opts.optionId } : {}),
          ...(opts.rules ? { rules: opts.rules } : {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (name !== 'open') setRun(data);
      await refresh();
      setReply('');
      setUnchecked([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const attempts = run?.attempts.filter((a) => a.nodeId === selected) ?? [];
  const active = run?.state === 'running';
  const now = run ? runNow(run) : null;
  const timeline = run ? runTimeline(run) : [];
  const canAct = !busy && ticket.status === 'in_progress';
  // The person is needed when a stage waits on them or the coordinator paused routing.
  const waitingOnYou =
    !!run && !active && run.state !== 'complete' && (Object.values(run.steps).includes('waiting') || (!!run.routing && run.state === 'waiting'));
  const decision = run?.decision;
  const decisionNode = decision ? run?.graph.nodes.find((n) => n.id === decision.nodeId) : undefined;
  const blocked = !active ? run?.blocked : undefined;
  const blockedNode = blocked ? run?.graph.nodes.find((n) => n.id === blocked.nodeId) : undefined;
  const chosenRules = blocked ? blocked.rules.filter((r) => !unchecked.includes(r)) : [];
  const lastChat = attempts.at(-1)?.chatOpenedAt;
  const nodeLabel = (id?: string) => run?.graph.nodes.find((n) => n.id === id)?.label ?? id ?? '';
  return (
    <div className="space-y-3 border-y py-4" aria-label="Workflow execution">
      {now && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-3 py-2" aria-label="Where the workflow is now">
          <span className={`size-2 shrink-0 rounded-full ${toneDot[now.tone]} ${now.tone === 'running' ? 'animate-pulse' : ''}`} />
          <span className="text-sm font-medium">Now: {now.text}</span>
          {now.nodeId && now.nodeId !== selected && onSelect && (
            <button type="button" className="text-xs text-muted-foreground underline underline-offset-4" onClick={() => onSelect(now.nodeId!)}>
              Show in graph
            </button>
          )}
          {now.action && ['retry', 'resume'].includes(now.action.kind) && (
            <Button
              size="xs"
              className="ml-auto"
              disabled={!canAct}
              onClick={() => void action(now.action!.kind, { nodeId: now.action!.nodeId ?? now.nodeId })}
            >
              {now.action.kind === 'retry' ? <RotateCcwIcon /> : <PlayIcon />}
              {now.action.label}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm font-medium">{run ? `Automation · ${run.state}` : 'Run the graph automatically'}</span>
        {!run ? (
          <Button size="sm" disabled={!canAct} onClick={() => void action('start')}>
            <PlayIcon />
            Start workflow
          </Button>
        ) : (
          <>
            {active ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void action('pause')}>
                <PauseIcon />
                Pause
              </Button>
            ) : (
              run.state !== 'complete' && (
                <Button size="sm" disabled={!canAct} onClick={() => void action('resume')}>
                  <PlayIcon />
                  Resume
                </Button>
              )
            )}
            {!active && selected && (
              <Button size="sm" variant="outline" disabled={!canAct} onClick={() => void action('retry')}>
                <RotateCcwIcon />
                Retry from this step
              </Button>
            )}
          </>
        )}
      </div>
      {attempts.at(-1)?.sessionId && attempts.at(-1)?.providerKind !== 'openai' && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Advanced: individual stage chat</summary>
          <p className="my-2">For work on this stage alone. Use Open master chat at the top for the whole ticket.</p>
              <Button
                size="sm"
                variant="ghost"
                // The chat resumes the stage's own session in herdr, so the headless stage must stop first.
                disabled={busy || active}
                onClick={() => void action('open')}
                title={active ? 'Pause the graph to open this stage in herdr.' : lastChat ? `Opened ${time(lastChat)}. Opening again reuses its herdr pane when it is free.` : undefined}
              >
                <MessageSquareIcon />
                {lastChat ? 'Open stage chat again' : 'Open stage chat'}
              </Button>
        </details>
      )}
      <p className={`text-xs text-muted-foreground ${(decision || blocked) && !active ? 'line-clamp-3' : ''}`}>
        {run?.message ||
          'Each stage gets its own agent session and handovers. Up to ten tickets execute at once; stages within a ticket run sequentially to protect its worktrees.'}
      </p>
      {!run && ticket.conversation && (
        <Button size="sm" variant="outline" disabled={!canAct} onClick={() => void action('handoff')}>
          I stopped the existing agent · Start after handoff
        </Button>
      )}
      {blocked && blockedNode && (
        <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/5 p-3" role="group" aria-label="Allow tools for this workspace">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheckIcon className="size-4" />
            {blockedNode.label} needs access
          </p>
          <p className="text-xs text-muted-foreground">{blocked.provider === 'opencode'
            ? 'OpenCode requested these permissions. Allowing them applies to OpenCode workflow stages in this workspace.'
            : 'Claude Code refused these. Allowing them applies to every Claude stage and stage chat in this workspace.'}</p>
          <div className="space-y-1">
            {blocked.rules.map((rule) => (
              <label key={rule} className="flex items-center gap-2 font-mono text-xs">
                <input
                  type="checkbox"
                  checked={!unchecked.includes(rule)}
                  onChange={(e) => setUnchecked((u) => (e.target.checked ? u.filter((r) => r !== rule) : [...u, rule]))}
                />
                {permissionLabel(rule)}
                {blocked.alreadyAllowed.includes(rule) && <span className="font-sans text-muted-foreground">already allowed here</span>}
              </label>
            ))}
          </div>
          {blocked.alreadyAllowed.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {blocked.provider === 'opencode'
                ? 'These requests were already granted in Gantry. Check OpenCode settings and provider policy before retrying.'
                : 'Anything marked “already allowed here” is being blocked by your Claude Code settings or your organization’s policy. Approve it in the stage chat (choose “don’t ask again”), then Resume: Gantry picks up those approvals.'}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!canAct} onClick={() => void action('allow', { nodeId: blocked.nodeId, rules: chosenRules })}>
              {chosenRules.length ? `Allow and retry ${blockedNode.label}` : `Retry ${blockedNode.label}`}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action('open', { nodeId: blocked.nodeId })}>
              <MessageSquareIcon />
              Approve in the stage chat instead
            </Button>
          </div>
        </div>
      )}
      {run?.deliverables && run.deliverables.length > 0 && (
        <div className="space-y-1.5 rounded-md border p-3" aria-label="Delivered pull requests">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <GitPullRequestIcon className="size-3.5" />
            {run.state === 'complete' ? 'Final output' : 'Pull requests so far'}
          </p>
          {run.deliverables.map((d) => (
            <p key={d.url} className="break-all font-mono text-xs">
              {d.repo}:
              <a href={d.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                {d.url}
              </a>{' '}
              <span className="font-sans">{d.title}</span>
            </p>
          ))}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigator.clipboard?.writeText(run.deliverables!.map(formatDeliverable).join('\n')).catch(() => {})}
          >
            Copy
          </Button>
        </div>
      )}
      {decision && !active && (
        <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3" role="group" aria-label="Choose how to continue">
          <p className="text-xs font-medium text-muted-foreground">{decision.source === 'attempt-limit' ? `${decisionNode?.label ?? 'Stage'} · attempt limit reached` : decisionNode ? `${decisionNode.label} · your call` : 'Your call'}</p>
          {decision.question.length > 400 ? (
            <details className="text-sm">
              <summary className="cursor-pointer line-clamp-4 whitespace-pre-wrap">{decision.question}</summary>
              <p className="mt-2 whitespace-pre-wrap">{decision.question}</p>
            </details>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{decision.question}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {decision.options.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant="outline"
                disabled={!canAct}
                onClick={() => void action('decide', { optionId: option.id })}
                title={option.edgeId ? `Follows the “${run?.graph.edges?.find((e) => e.id === option.edgeId)?.label ?? option.edgeId}” connection` : undefined}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Anything you type below is sent with your choice.</p>
        </div>
      )}
      {waitingOnYou && (
        <div className="space-y-2">
          <Textarea
            aria-label="Workflow reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={decision ? 'Optional note, or answer in your own words…' : 'Answer the question or explain what changed…'}
          />
          <Button size="sm" disabled={!canAct || !reply.trim()} onClick={() => void action('confirm')}>
            Reply and continue
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <StagePermissions projectId={ticket.projectId} refreshKey={run?.blocked?.at ?? run?.updatedAt} />
      {timeline.length > 0 && (
        <details open={!active} className="text-sm">
          <summary className="cursor-pointer">Timeline · {timeline.length} events</summary>
          <ol className="mt-2 space-y-2" aria-label="Workflow timeline">
            {timeline.slice(0, 80).map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-2">
                <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">{time(e.at)}</span>
                <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${e.tone ? toneDot[e.tone] : e.kind === 'you' ? 'bg-violet-500' : 'bg-zinc-300'}`} />
                <div className="min-w-0">
                  {e.nodeId && onSelect ? (
                    <button type="button" className="text-left text-xs font-medium hover:underline" onClick={() => onSelect(e.nodeId!)} title={`Show ${nodeLabel(e.nodeId)}`}>
                      {e.title}
                    </button>
                  ) : (
                    <p className="text-xs font-medium">{e.title}</p>
                  )}
                  {e.detail && <p className="line-clamp-2 text-xs text-muted-foreground">{e.detail}</p>}
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
      {attempts.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">
            Stage history · {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
          </summary>
          <div className="mt-3 space-y-4">
            {[...attempts].reverse().map((a, i) => (
              <div key={a.id} className="space-y-2">
                <p className="text-xs font-medium">
                  Attempt {attempts.length - i} · {a.state} · {a.model || a.providerKind}
                </p>
                <p className="whitespace-pre-wrap text-sm">{a.summary}</p>
                {a.denials?.length ? (
                  <p className="text-xs text-muted-foreground">Refused: {a.denials.map((d) => `${d.rule}${d.detail ? ` (${d.detail})` : ''}`).join('; ')}</p>
                ) : null}
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                  {a.output || 'Waiting for agent output…'}
                </pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
