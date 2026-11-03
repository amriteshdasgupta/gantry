'use client';
import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { PlusIcon, MinusIcon, XIcon, Trash2Icon, ArrowRightIcon, PlayIcon, MaximizeIcon, NotebookPenIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAgents } from '@/lib/client/agents';
import { gantry, type Workflow, type ProjectView } from '@/lib/client/gantry';
import { canvasWorkflow, nodePositions } from '@/lib/client/workflow-graph';
import { exportWorkflow, importWorkflow } from '../../../../packages/shared/src/workflow';
import { WorkspacePromptDialog } from './workspace-prompt-dialog';
import { confirmGraphNavigation, useUnsavedGraph } from '@/lib/client/unsaved-graph';
import { GraphAssistant } from './graph-assistant';

type Node = Workflow['nodes'][number];
type Edge = NonNullable<Workflow['edges']>[number];
const selectClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
function EditorDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const d = ref.current!;
    d.showModal();
    d.querySelector<HTMLElement>('input,textarea')?.focus();
    return () => {
      d.close();
      before?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 m-auto max-h-[88dvh] w-[min(36rem,calc(100vw-32px))] max-w-none overflow-auto rounded-xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/35"
    >
      <div className="mb-5 flex items-center gap-3">
        <h2 className="flex-1 text-lg font-semibold">{title}</h2>
        <Button variant="ghost" size="icon" aria-label="Close editor" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {children}
    </dialog>
  );
}
function NodeEditor({
  node,
  start,
  onSave,
  onDelete,
  onClose,
}: {
  node: Node;
  start: boolean;
  onSave: (node: Node, start: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const agents = useAgents();
  const [draft, setDraft] = useState(node);
  const [entry, setEntry] = useState(start);
  const edits = useUnsavedGraph(JSON.stringify(draft) !== JSON.stringify(node) || entry !== start);
  const [models, setModels] = useState<{ id: string; label: string; efforts?: string[] }[]>([]);
  const [custom, setCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const provider = agents?.agents.find((a) => a.id === (draft.providerId || agents.current));
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/agents/models?providerId=${encodeURIComponent(draft.providerId || '')}`, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('Model list unavailable. Use the provider default or enter a model ID.');
        return r.json();
      })
      .then((data) => {
        if (!abort.signal.aborted) {
          setModels(data.models);
          setModelError(data.warning || '');
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setModelError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [draft.providerId]);
  const efforts = models.find((m) => m.id === (draft.model || provider?.model))?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  return (
    <EditorDialog
      title="Edit node"
      onClose={() => {
        if (edits.confirmDiscard()) onClose();
      }}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          edits.markSaved();
          onSave({ ...draft, kind: 'agent' }, entry);
        }}
      >
        <label className="block space-y-2 text-sm font-medium">
          Name
          <Input
            autoFocus
            aria-label="Node name"
            value={draft.label}
            maxLength={100}
            required
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <label className="block space-y-2 text-sm font-medium">
          Instructions
          <Textarea
            aria-label="Node instructions"
            className="min-h-36 font-normal"
            placeholder="What should this agent do?"
            value={draft.instructions}
            maxLength={10000}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm font-medium">
            Provider
            <select
              aria-label="Node provider"
              className={selectClass}
              value={draft.providerId || ''}
              onChange={(e) => {
                setDraft({ ...draft, providerId: e.target.value || undefined, model: undefined, reasoningEffort: undefined });
                setCustom(false);
                setLoading(true);
                setModelError('');
                setModels([]);
              }}
            >
              <option value="">Default{provider ? ` · ${provider.name}` : ''}</option>
              {agents?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium">
            Model
            {provider?.kind === 'openai' || custom ? (
              <Input
                aria-label="Node model"
                placeholder="Model ID"
                value={draft.model || ''}
                onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined })}
              />
            ) : (
              <select
                aria-label="Node model"
                className={selectClass}
                value={draft.model || ''}
                onChange={(e) => {
                  if (e.target.value === '__custom') {
                    setCustom(true);
                    return;
                  }
                  setDraft({ ...draft, model: e.target.value || undefined, reasoningEffort: undefined });
                }}
              >
                <option value="">{loading ? 'Loading models…' : 'Provider default'}</option>
                {draft.model && !models.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                <option value="__custom">Custom model…</option>
              </select>
            )}
          </label>
        </div>
        {modelError && (
          <p role="status" className="text-xs text-muted-foreground">
            {modelError}
          </p>
        )}
        <label className="block space-y-2 text-sm font-medium">
          Reasoning effort
          <select
            aria-label="Node reasoning effort"
            className={selectClass}
            value={draft.reasoningEffort || ''}
            onChange={(e) => setDraft({ ...draft, reasoningEffort: (e.target.value || undefined) as Node['reasoningEffort'] })}
          >
            <option value="">Provider default</option>
            {draft.reasoningEffort && !efforts.includes(draft.reasoningEffort) && <option value={draft.reasoningEffort}>{draft.reasoningEffort}</option>}
            {efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button type="button" variant="ghost" size="sm" disabled={entry} onClick={() => setEntry(true)}>
            <PlayIcon />
            {entry ? 'Starts here' : 'Start here'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
            <Trash2Icon />
            Delete node
          </Button>
          <Button className="ml-auto" type="submit" disabled={!draft.label.trim()}>
            Done
          </Button>
        </div>
      </form>
    </EditorDialog>
  );
}

export function WorkflowCanvas({
  initial,
  onSave,
  onCancel,
  header,
  draftKey,
  portable = false,
  templateProjectId,
  onTemplateAdded,
  onChange,
}: {
  initial: Workflow;
  draftKey?: string;
  portable?: boolean;
  templateProjectId?: string;
  onTemplateAdded?: () => Promise<void>;
  onChange?: (graph: Workflow) => void;
  onSave?: (graph: Workflow) => Promise<void>;
  onCancel?: () => void;
  header?: ReactNode;
}) {
  const [graph, setGraph] = useState(() => {
    try {
      const draft = draftKey && sessionStorage.getItem(draftKey);
      if (draft) return canvasWorkflow(JSON.parse(draft));
    } catch {}
    return canvasWorkflow(initial);
  });
  const [imported, setImported] = useState<Workflow | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(() => JSON.stringify(canvasWorkflow(initial)));
  const [selected, setSelected] = useState<string | null>(null);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [edgeLabel, setEdgeLabel] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(0.85);
  const [busy, setBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [error, setError] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateError, setTemplateError] = useState('');
  const [templateSaved, setTemplateSaved] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id?: string; x: number; y: number; originX: number; originY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const positions = nodePositions(graph);
  const nodes = graph.nodes;
  const edges = graph.edges ?? [];
  const selectedNode = nodes.find((n) => n.id === selected);
  const selectedEdge = edges.find((e) => e.id === edgeId);
  const dirty = JSON.stringify(graph) !== saved;
  const edits = useUnsavedGraph(dirty && !onChange, () => {
    if (draftKey) sessionStorage.removeItem(draftKey);
  });
  const edgeEdits = useUnsavedGraph(!!selectedEdge && edgeLabel !== selectedEdge.label);
  const width = Math.max(1400, ...Object.values(positions).map((p) => p.x + 400));
  const height = Math.max(800, ...Object.values(positions).map((p) => p.y + 300));
  useEffect(() => {
    onChange?.(graph);
  }, [graph, onChange]);

  useEffect(() => {
    if (draftKey) {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify(graph));
      else sessionStorage.removeItem(draftKey);
    }
  }, [graph, dirty, draftKey]);
  function point(e: { clientX: number; clientY: number }) {
    const v = viewport.current!;
    const box = v.getBoundingClientRect();
    return { x: (e.clientX - box.left + v.scrollLeft) / zoom, y: (e.clientY - box.top + v.scrollTop) / zoom };
  }
  function moveNode(id: string, p: { x: number; y: number }) {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === id ? { ...n, position: { x: Math.max(24, Math.min(9600, p.x)), y: Math.max(24, Math.min(9600, p.y)) } } : n)),
    }));
  }
  function editEdge(edge: Edge) {
    setEdgeId(edge.id);
    setEdgeLabel(edge.label);
  }
  function connect(target: string) {
    if (!connecting || connecting === target) return;
    const existing = edges.find((e) => e.source === connecting && e.target === target);
    if (existing) editEdge(existing);
    else {
      const edge = { id: `edge-${crypto.randomUUID().slice(0, 8)}`, source: connecting, target, label: 'When completed successfully' };
      setGraph((g) => ({ ...g, edges: [...(g.edges ?? []), edge] }));
      editEdge(edge);
    }
    setConnecting(null);
    setCursor(null);
  }
  function pointerMove(e: PointerEvent) {
    if (connecting) {
      setCursor(point(e));
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.id) moveNode(d.id, { x: d.originX + dx / zoom, y: d.originY + dy / zoom });
    else if (viewport.current) {
      viewport.current.scrollLeft = d.originX - dx;
      viewport.current.scrollTop = d.originY - dy;
    }
  }
  function pointerUp(e: PointerEvent) {
    if (connecting) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-workflow-node]')?.getAttribute('data-workflow-node');
      if (target && target !== connecting) {
        connect(target);
        suppressClick.current = true;
      }
    } else if (drag.current) {
      suppressClick.current = drag.current.moved;
      drag.current = null;
    }
  }
  function fit() {
    const v = viewport.current;
    if (!v) return;
    const w = Math.max(400, ...Object.values(positions).map((p) => p.x + 280));
    const h = Math.max(250, ...Object.values(positions).map((p) => p.y + 150));
    setZoom(Math.max(0.3, Math.min(1.1, (v.clientWidth - 40) / w, (v.clientHeight - 40) / h)));
    v.scrollTo(0, 0);
  }
  async function readGraph(file: File) {
    setError('');
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('Graph files must be smaller than 8 MB.');
      setImported(canvasWorkflow(importWorkflow(await file.text())));
    } catch {
      setError('Unable to import this graph. Choose a valid Gantry graph JSON file (version 1, under 8 MB).');
    }
  }

  function downloadGraph() {
    setError('');
    try {
      const url = URL.createObjectURL(new Blob([exportWorkflow(graph)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'workspace-graph.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('This graph is invalid. Check its start node and connections before exporting.');
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      await onSave?.(graph);
      edits.markSaved();
      if (draftKey) sessionStorage.removeItem(draftKey);
      setSaved(JSON.stringify(graph));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Workflow canvas editor">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
        {header}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" aria-expanded={assistantOpen} onClick={() => setAssistantOpen((open) => !open)}>
            {assistantOpen ? 'Hide assistant' : 'Ask AI'}
          </Button>
          {templateProjectId && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setTemplateError('');
                setTemplateSaved(false);
                setTemplateOpen(true);
              }}
            >
              Add as workspace graph template
            </Button>
          )}
          {portable && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                aria-label="Import graph file"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void readGraph(file);
                }}
              />
              <Button size="sm" variant="outline" disabled={busy} onClick={downloadGraph}>
                Export graph
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
                Import graph
              </Button>
            </>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              role="switch"
              aria-label="Run automatically"
              checked={graph.autoStart ?? false}
              disabled={!nodes.length || busy}
              onChange={(e) => setGraph((g) => ({ ...g, autoStart: e.target.checked }))}
            />
            Run automatically
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || nodes.length >= 50}
            onClick={() => {
              const id = `step-${crypto.randomUUID().slice(0, 8)}`;
              const v = viewport.current;
              const node: Node = {
                id,
                label: 'New node',
                kind: 'agent',
                instructions: '',
                dependsOn: [],
                position: {
                  x: Math.max(40, (v?.scrollLeft ?? 0) / zoom + 100 + (nodes.length % 3) * 35),
                  y: Math.max(40, (v?.scrollTop ?? 0) / zoom + 140 + (nodes.length % 3) * 35),
                },
              };
              setGraph((g) => ({ ...g, entryNodeId: g.entryNodeId || id, nodes: [...g.nodes, node] }));
              setSelected(id);
            }}
          >
            <PlusIcon />
            Add node
          </Button>
          {onCancel && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (edits.confirmDiscard()) onCancel();
              }}
            >
              Cancel
            </Button>
          )}
          {onSave && (
            <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Saving…' : dirty ? 'Save graph' : 'Saved'}
            </Button>
          )}
        </div>
      </div>
      {templateSaved && (
        <p role="status" className="px-5 py-2 text-sm">
          Workspace graph template added.
        </p>
      )}
      {templateOpen && templateProjectId && (
        <EditorDialog
          title="Add workspace graph template"
          onClose={() => {
            if (!busy) setTemplateOpen(false);
          }}
        >
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setTemplateError('');

              try {
                await gantry.saveWorkspaceWorkflowTemplate(templateProjectId, templateName.trim(), graph);
                setTemplateOpen(false);
                setTemplateName('');
                setTemplateSaved(true);
                await onTemplateAdded?.();
              } catch (error) {
                setTemplateError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="text-sm text-muted-foreground">Save the current graph draft for future tickets. Ticket progress is not included.</p>
            <label className="block space-y-2 text-sm">
              Template name
              <Input required maxLength={80} value={templateName} disabled={busy} onChange={(event) => setTemplateName(event.target.value)} />
            </label>
            {templateError && (
              <p role="alert" className="text-sm text-destructive">
                {templateError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setTemplateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !templateName.trim()}>
                {busy ? 'Adding…' : 'Add template'}
              </Button>
            </div>
          </form>
        </EditorDialog>
      )}
      {imported && (
        <EditorDialog title="Import workspace graph" onClose={() => setImported(null)}>
          <p className="mb-4 text-sm text-muted-foreground">
            Replace the current draft with {imported.nodes.length} nodes and {imported.edges?.length ?? 0} connections? Unsaved edits will be replaced.
            Automatic runs will be off. Review provider and model settings, then save the graph to apply it to future tickets. Shared instructions are not
            included.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setImported(null)}>
              Cancel import
            </Button>
            <Button
              onClick={() => {
                setGraph(imported);
                setImported(null);
                setSelected(null);
                setEdgeId(null);
                setConnecting(null);
                setCursor(null);
                setError('');
              }}
            >
              Replace draft
            </Button>
          </div>
        </EditorDialog>
      )}
      {error && (
        <p role="alert" className="border-b px-5 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex min-h-[420px] flex-1 overflow-x-auto">
        <div className="relative min-h-[420px] min-w-[320px] flex-1 overflow-hidden">
          <div
            ref={viewport}
            aria-label="Workflow canvas"
            className="h-full w-full touch-none overflow-auto bg-muted/15"
            style={{ backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)', backgroundSize: `${24 * zoom}px ${24 * zoom}px` }}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={() => {
              drag.current = null;
              setConnecting(null);
              setCursor(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setConnecting(null);
                setCursor(null);
              }
            }}
          >
            <div
              style={{ width: width * zoom, height: height * zoom }}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('button,[data-workflow-node]')) return;
                drag.current = { x: e.clientX, y: e.clientY, originX: viewport.current!.scrollLeft, originY: viewport.current!.scrollTop, moved: false };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
            >
              <div className="relative origin-top-left pointer-events-none" style={{ width, height, transform: `scale(${zoom})` }}>
                <svg className="pointer-events-none absolute inset-0 overflow-visible text-muted-foreground" width={width} height={height} aria-hidden="true">
                  <defs>
                    <marker id="workflow-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
                      <path d="M 0 0 L 9 4.5 L 0 9" fill="currentColor" />
                    </marker>
                  </defs>
                  {edges.map((edge) => {
                    const a = positions[edge.source],
                      b = positions[edge.target];
                    if (!a || !b) return null;
                    const sx = a.x + 230,
                      sy = a.y + 48,
                      tx = b.x,
                      ty = b.y + 48;
                    const bend = Math.max(70, Math.abs(tx - sx) * 0.45);
                    const d =
                      tx > sx
                        ? `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`
                        : `M ${sx} ${sy} C ${sx + 100} ${sy + 160}, ${tx - 100} ${ty + 160}, ${tx} ${ty}`;
                    return (
                      <g key={edge.id}>
                        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" markerEnd="url(#workflow-arrow)" />
                        <path
                          d={d}
                          fill="none"
                          stroke="transparent"
                          strokeWidth="18"
                          className="pointer-events-auto cursor-pointer"
                          onClick={() => editEdge(edge)}
                        />
                      </g>
                    );
                  })}
                  {connecting && cursor && (
                    <path
                      d={`M ${positions[connecting].x + 230} ${positions[connecting].y + 48} L ${cursor.x} ${cursor.y}`}
                      fill="none"
                      stroke="var(--primary)"
                      strokeWidth="2"
                      strokeDasharray="5 5"
                    />
                  )}
                </svg>
                {edges.map((edge) => {
                  const a = positions[edge.source],
                    b = positions[edge.target];
                  if (!a || !b) return null;
                  const backwards = b.x <= a.x + 230;
                  return (
                    <button
                      key={edge.id}
                      type="button"
                      aria-label={`Edit connection ${nodes.find((n) => n.id === edge.source)?.label} to ${nodes.find((n) => n.id === edge.target)?.label}`}
                      title={edge.label}
                      onClick={() => editEdge(edge)}
                      className="pointer-events-auto absolute max-w-56 -translate-x-1/2 -translate-y-1/2 line-clamp-2 whitespace-normal break-words rounded-md border bg-background px-2.5 py-1 text-xs text-muted-foreground shadow-sm hover:border-primary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      style={{ left: (a.x + 230 + b.x) / 2, top: (a.y + b.y) / 2 + 48 + (backwards ? 120 : 0) }}
                    >
                      {edge.label}
                    </button>
                  );
                })}
                {nodes.map((n) => {
                  const p = positions[n.id];
                  return (
                    <div key={n.id} data-workflow-node={n.id} className="absolute pointer-events-auto" style={{ left: p.x, top: p.y, width: 230 }}>
                      <button
                        type="button"
                        aria-label={`Edit node ${n.label}`}
                        onPointerDown={(e) => {
                          suppressClick.current = false;
                          if (connecting) return;
                          drag.current = { id: n.id, x: e.clientX, y: e.clientY, originX: p.x, originY: p.y, moved: false };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          if (connecting) connect(n.id);
                          else setSelected(n.id);
                        }}
                        onKeyDown={(e) => {
                          const shifts: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
                          if (shifts[e.key]) {
                            e.preventDefault();
                            const [dx, dy] = shifts[e.key];
                            moveNode(n.id, { x: p.x + dx, y: p.y + dy });
                          }
                        }}
                        className={`flex h-24 w-full cursor-grab flex-col justify-center gap-2 rounded-xl border bg-background px-5 text-left shadow-sm active:cursor-grabbing hover:border-primary focus-visible:outline-2 focus-visible:outline-ring ${connecting && connecting !== n.id ? 'border-primary' : ''}`}
                      >
                        <span className="flex w-full items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{n.label}</span>
                          {graph.entryNodeId === n.id && (
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">Start</span>
                          )}
                        </span>
                        <span className="w-full truncate text-xs text-muted-foreground">
                          {n.model || 'Default model'}
                          {n.reasoningEffort ? ` · ${n.reasoningEffort}` : ''}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Connect into ${n.label}`}
                        className="absolute -left-3 top-9 flex size-6 items-center justify-center rounded-full border bg-background hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => connect(n.id)}
                      >
                        <span className="size-2 rounded-full bg-muted-foreground" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Connect from ${n.label}`}
                        aria-pressed={connecting === n.id}
                        className="absolute -right-3 top-9 flex size-6 touch-none items-center justify-center rounded-full border bg-background hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setConnecting(n.id);
                          setCursor(point(e));
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          setConnecting(n.id);
                        }}
                      >
                        <span className="size-2 rounded-full bg-primary" />
                      </button>
                    </div>
                  );
                })}
                {!nodes.length && (
                  <div className="absolute left-16 top-28 max-w-sm">
                    <h2 className="text-xl font-semibold">Start with one agent.</h2>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Add a node, give it instructions, then connect it to the next step.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-4 bottom-4 flex items-end justify-between gap-4">
            <p role="status" className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">
              {connecting ? 'Connect to another node · Esc to cancel' : 'Drag nodes to move · Drag connectors to link · Click an edge to name it'}
            </p>
            <div className="pointer-events-auto flex shrink-0 items-center gap-1 rounded-md border bg-background p-1">
              <Button size="icon" variant="ghost" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))}>
                <MinusIcon />
              </Button>
              <span className="w-10 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
              <Button size="icon" variant="ghost" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}>
                <PlusIcon />
              </Button>
              <Button size="icon" variant="ghost" aria-label="Fit graph" onClick={fit}>
                <MaximizeIcon />
              </Button>
            </div>
          </div>
        </div>
        {assistantOpen && (
          <GraphAssistant
            graph={graph}
            disabled={busy || !!selectedNode || !!selectedEdge || !!imported || templateOpen}
            onApply={(next) => {
              setGraph(next);
              setSelected(null);
              setEdgeId(null);
              setConnecting(null);
              setCursor(null);
            }}
          />
        )}
      </div>
      {selectedNode && (
        <NodeEditor
          key={selectedNode.id}
          node={selectedNode}
          start={graph.entryNodeId === selectedNode.id}
          onClose={() => setSelected(null)}
          onSave={(node, start) => {
            setGraph((g) => ({ ...g, entryNodeId: start ? node.id : g.entryNodeId, nodes: g.nodes.map((n) => (n.id === node.id ? node : n)) }));
            setSelected(null);
          }}
          onDelete={() => {
            setGraph((g) => {
              const nodes = g.nodes.filter((n) => n.id !== selectedNode.id);
              return {
                ...g,
                nodes,
                edges: g.edges?.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id),
                entryNodeId: g.entryNodeId === selectedNode.id ? nodes[0]?.id : g.entryNodeId,
                autoStart: nodes.length ? g.autoStart : false,
              };
            });
            setSelected(null);
          }}
        />
      )}
      {selectedEdge && (
        <EditorDialog
          title="Name this connection"
          onClose={() => {
            if (edgeEdits.confirmDiscard()) setEdgeId(null);
          }}
        >
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              edgeEdits.markSaved();
              setGraph((g) => ({ ...g, edges: g.edges?.map((edge) => (edge.id === edgeId ? { ...edge, label: edgeLabel.trim() } : edge)) }));
              setEdgeId(null);
            }}
          >
            <p className="flex items-center gap-2 text-sm font-medium">
              {nodes.find((n) => n.id === selectedEdge.source)?.label}
              <ArrowRightIcon className="size-4" />
              {nodes.find((n) => n.id === selectedEdge.target)?.label}
            </p>
            <label className="block space-y-2 text-sm">
              When should the coordinator follow this path?
              <Textarea
                autoFocus
                aria-label="Connection condition"
                maxLength={2000}
                value={edgeLabel}
                onChange={(e) => setEdgeLabel(e.target.value)}
                placeholder="For example: If the review finds issues that need fixing"
                className="min-h-28"
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The coordinator reads this condition alongside the agent’s results to choose the next step.
            </p>
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setGraph((g) => ({ ...g, edges: g.edges?.filter((e) => e.id !== edgeId) }));
                  setEdgeId(null);
                }}
              >
                <Trash2Icon />
                Delete connection
              </Button>
              <Button type="submit" disabled={!edgeLabel.trim()}>
                Done
              </Button>
            </div>
          </form>
        </EditorDialog>
      )}
    </section>
  );
}
export function WorkspaceGraphPage({ project }: { project: ProjectView }) {
  const [templates, setTemplates] = useState<{ id: string; name: string; graph: Workflow }[]>([]);
  const [templateId, setTemplateId] = useState('default');
  const graph = templates.find((template) => template.id === templateId)?.graph;
  const [error, setError] = useState('');
  const [promptOpen, setPromptOpen] = useState(false);
  useEffect(() => {
    let live = true;
    gantry
      .workspaceWorkflowTemplates(project.id)
      .then((items) => {
        if (live) setTemplates(items);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [project.id]);
  if (!graph)
    return (
      <p role={error ? 'alert' : 'status'} className="p-6 text-sm">
        {error || 'Loading workspace graph…'}
      </p>
    );
  return (
    <>
      <section aria-label="Shared instructions" className="flex flex-wrap items-center gap-4 border-b border-primary/20 bg-primary/5 px-5 py-4">
        <NotebookPenIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Make this graph yours with shared instructions</h2>
          <p className="mt-1 text-sm text-muted-foreground">Add your project context, coding conventions, and test commands once. Every stage uses them.</p>
        </div>
        <Button variant="outline" onClick={() => setPromptOpen(true)}>
          Edit shared instructions
          <ArrowRightIcon />
        </Button>
      </section>
      <label className="flex items-center gap-3 border-b px-5 py-3 text-sm">
        Workspace graph template
        <select
          aria-label="Workspace graph template"
          className={selectClass}
          value={templateId}
          onChange={(event) => {
            if (confirmGraphNavigation()) setTemplateId(event.target.value);
          }}
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
      <WorkflowCanvas
        key={`${project.id}:${templateId}`}
        portable
        templateProjectId={project.id}
        onTemplateAdded={async () => setTemplates(await gantry.workspaceWorkflowTemplates(project.id))}
        draftKey={templateId === 'default' ? `gantry-graph-draft:${project.id}` : `gantry-graph-draft:${project.id}:${templateId}`}
        initial={graph}
        onSave={async (graph) => {
          if (templateId === 'default') await gantry.saveWorkspaceWorkflow(project.id, graph);
          else await gantry.saveWorkspaceWorkflowTemplate(project.id, templates.find((template) => template.id === templateId)!.name, graph, templateId);
          setTemplates((items) => items.map((template) => (template.id === templateId ? { ...template, graph } : template)));
        }}
        header={
          <div>
            <h1 className="text-base font-semibold">Workspace graph</h1>
            <p className="mt-1 text-xs text-muted-foreground">Customize the steps below, then save your graph.</p>
          </div>
        }
      />
      {promptOpen && <WorkspacePromptDialog project={project} onClose={() => setPromptOpen(false)} />}
    </>
  );
}
