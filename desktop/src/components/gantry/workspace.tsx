"use client";

import { ticketServiceScopes } from "@/lib/client/gantry";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { ArrowUpRightIcon, FolderOpenIcon, GitBranchIcon, GitPullRequestIcon, LayoutListIcon, NetworkIcon, Loader2Icon, MonitorIcon, PlusIcon, RefreshCwIcon, MessageSquareIcon, CircleDashedIcon, CircleDotIcon, CircleCheckIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { SettingsLink } from "@/components/settings-link";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { canvasWorkflow } from "@/lib/client/workflow-graph";
import { gantry, type ProjectView, type StatusView, type TicketView, type Workflow } from "@/lib/client/gantry";

import { WorkflowCanvas, WorkspaceGraphPage } from "./workflow-canvas";
import { TicketPullRequests } from "./ticket-pull-requests";
import { TicketReviewStatus } from "./ticket-review-status";
import { TicketGraph } from "./ticket-graph";
import { useTicketColors } from "./ticket-colors";
import { Workspace as ReviewWorkspace } from "@/components/space/workspace";
import { PreviewPane } from "./preview-pane";
import { GraphStatus, TicketWorkflow, graphSummary } from "./workflow";
import { SetupCheck } from "./setup-check";
import { DeleteTicketDialog } from "./delete-ticket-dialog";
import { CleanupWorktreesDialog } from "./cleanup-worktrees-dialog";
import { TicketDialog } from "./ticket-dialog";
import { TicketConversation, ticketChatRequest, openTicketChat } from "./ticket-chat";
import { TicketOutcome } from "./ticket-outcome";
import { confirmGraphNavigation, useGraphNavigationGuard, useUnsavedGraph } from "@/lib/client/unsaved-graph";

type Area = "tickets" | "reviews" | "previews" | "workflow";
const labels: Record<string, string> = { backlog: "Backlog", in_progress: "In progress", done: "Done" };
const selectClass = "h-8 rounded-lg border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const bridge = (url: string) => `/api/gantry${url}`;

function State({ value }: { value: string }) {
  return <Badge variant="outline" className={cn("shrink-0 capitalize", /failed|error/.test(value) && "text-destructive")}>{labels[value] || value.replaceAll("_", " ")}</Badge>;
}

function TicketPreview({owner,onChat,onTicketReview,...props}:Omit<ComponentProps<typeof PreviewPane>,'onOpenChat'|'onReview'> & {owner?:TicketView;onChat:(ticket:TicketView)=>Promise<void>;onTicketReview:(urls:string[],ticket?:TicketView)=>Promise<void>}) {
  return <PreviewPane {...props} onOpenChat={owner ? ()=>void onChat(owner) : undefined} onReview={owner ? ()=>void onTicketReview([],owner) : undefined} />;
}

export function GantryWorkspace() {
  useGraphNavigationGuard();
  const [reviewSpace, setReviewSpace] = useState<string | null>(null);
  const [data, setData] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [ticketView, setTicketView] = useState<"board" | "graph">("board");
  const [area, setArea] = useState<Area>("tickets");
  const [selected, setSelected] = useState<string | null>(null);
  const [ticketTab, setTicketTab] = useState<"details" | "preview">("details");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<string | null>(null);
  const [previewTicket, setPreviewTicket] = useState("main");
  const [deleting, setDeleting] = useState<TicketView | null>(null);
  const [cleaning, setCleaning] = useState<TicketView | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingTicket, setEditingTicket] = useState(false);
  const [adding, setAdding] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingMoves = useRef(new Set<string>());
  const [movingTickets, setMovingTickets] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<{ title: string; text: string } | null>(null);
  const loading = useRef(false);
  const mounted = useRef(true);
  const refreshPending = useRef(false);
  const executionNotices = useRef(new Map<string,string>());
  const refresh = useCallback(async () => {
    if (loading.current) { refreshPending.current = true; return; }
    loading.current = true;
    try {
      do {
        refreshPending.current = false;
        try {
          const next = await gantry.status();
          if (mounted.current) { setData(next); setError(null); }
        } catch (e) { if (mounted.current) setError((e as Error).message); }
      } while (refreshPending.current && mounted.current);
    } finally { loading.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      const params = new URLSearchParams(window.location.search);
      setProjectId(params.get("workspace") || localStorage.getItem("gantry-workspace") || "");
      setSelected(params.get("ticket"));
      setTicketView(localStorage.getItem("gantry-ticket-view") === "graph" ? "graph" : "board");
      if (params.get("view") === "workflow") setArea("workflow");
      if (params.get("review")) { setReviewSpace(params.get("review")); setArea("reviews"); }
      void refresh();
    });
    const onMerge = () => { void refresh(); };
    window.addEventListener("gantry:merge-completed", onMerge);
    return () => { mounted.current = false; window.removeEventListener("gantry:merge-completed", onMerge); };
  }, [refresh]);
  useEffect(() => {
    const update = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(update, area === "tickets" && ticketView === "graph" ? 2000 : 10000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [area, ticketView, refresh]);
  useEffect(()=>{
    for(const item of data?.tickets ?? []){
      const execution=item.execution;
      if(!execution)continue;
      const key=execution.state+execution.message;
       const openGraph={label:'Open graph',onClick:()=>{if (!confirmGraphNavigation()) return; setProjectId(item.projectId);setSelected(item.id);setTicketTab('details');}};
      const seen=executionNotices.current.has(item.id);
      if(executionNotices.current.get(item.id)!==key && execution.state==='waiting') toast.error(execution.decision?`${item.title} needs your choice`:`${item.title} needs attention`,{description:execution.decision?`${execution.decision.question}\n${execution.decision.options.map(o=>`• ${o.label}`).join('\n')}`:execution.message,action:openGraph});
      // Announce a finished run once, leading with what it delivered.
      if(seen && executionNotices.current.get(item.id)!==key && execution.state==='complete') toast.success(`${item.title} is ready for review`,{description:execution.deliverables?.length?execution.deliverables.map(d=>`${d.repo}:${d.url} ${d.title}`).join('\n'):execution.message,action:openGraph});
      executionNotices.current.set(item.id,key);
    }
  },[data]);
  const project = data?.projects.find((p) => p.id === projectId) ?? data?.projects[0];
  const tickets = data?.tickets.filter((t) => t.projectId === project?.id) ?? [];
  const ticketColor = useTicketColors(project?.id ?? "", tickets);
  const doneBranch = (branch: string) => tickets.some(t => t.branch === branch && t.status !== "in_progress");
  const previews = data?.previews.filter((p) => p.projectId === project?.id && (p.isPrimary || !doneBranch(p.branch))) ?? [];
  const pulls = data?.pulls.filter((p) => p.projectId === project?.id && !doneBranch(p.branch)) ?? [];
  const ticket = tickets.find((t) => t.id === selected);
  const previewEntries = [{ id: "main", name: "Main", preview: previews.find(p => p.isPrimary) }, ...tickets.filter(t => t.status === "in_progress").map(t => ({ id: t.id, name: t.title.replace(/^.*\//, "").replace(/-+/g, " ").trim(), preview: previews.find(p => !p.isPrimary && p.branch === t.branch) }))];
  const activePreview = previewEntries.find(entry => entry.id === previewTicket) ?? previewEntries[0];
  const ticketPreviews = previews.filter(p => p.branch === ticket?.branch && !p.isPrimary);
  const jobs = data?.jobs.filter((j) => j.projectId === project?.id && ["queued", "running", "failed"].includes(j.state)).slice(0, 5) ?? [];

  async function act(action: () => Promise<unknown>, message?: string) {
    if (busy) return false;
    setBusy(true);
    try { await action(); if (message) toast.success(message); await refresh(); return true; }
    catch (e) { toast.error((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function openChatFor(owner:TicketView) {
    // Graph tickets open their master chat, which can read and drive the graph.
    await act(()=>openTicketChat(owner.id));
  }
  async function review(urls: string[], owner?: TicketView) {
    if (!confirmGraphNavigation()) return;
    await act(async () => {
      const linked = owner ?? tickets.find(t => t.pullRequests.some(p => urls.includes(p.url)) || pulls.some(g => g.branch === t.branch && Object.values(g.pulls).some(p => urls.includes(p.url))));
      let targetSpace = linked?.reviewSpaceId;
      if (linked && !targetSpace) throw new Error("Ticket space is not ready. Refresh Gantry and try again.");
      for (const url of urls) {
        const result = await api.addToSpace(url, targetSpace);
        targetSpace = result.space.id;
      }
      if (targetSpace) { setReviewSpace(targetSpace); setArea("reviews"); setSelected(null); setCreating(false); }
    });
  }
  async function showLog(title: string, url: string) {
    await act(async () => {
      const response = await fetch(bridge(url));
      if (!response.ok) throw new Error("Could not load this log. Refresh and try again.");
      setLog({ title, text: await response.text() });
    });
  }
  function openTicket(id: string, preview = false, edit = false) {
    if (!confirmGraphNavigation()) return;
    setEditingTicket(edit);
    setSelected(id); setCreating(false); setLog(null);
    setTicketTab(preview ? "preview" : "details");
  }
  function closeTicket() {
    if (creating && busy) return;
    if (!confirmGraphNavigation()) return;
    setSelected(null); setCreating(false); setLog(null); setEditingTicket(false);
    const params = new URLSearchParams(window.location.search); params.delete("ticket");
    window.history.replaceState(null, "", `/?${params}`);
  }
  async function moveTicket(id: string, status: string) {
    setDragging(null); setDropColumn(null);
    const moving = tickets.find(t => t.id === id);
    if (!moving || moving.status === status || pendingMoves.current.has(id)) return;
    pendingMoves.current.add(id);
    setMovingTickets(new Set(pendingMoves.current));
    try {
      await gantry.updateTicket(id, { status });
      // Only update the moved ticket: a slow request must not change navigation
      // or block another ticket's conversation/review.
      setData(current => current ? { ...current, tickets: current.tickets.map(t => t.id === id ? { ...t, status } : t) } : current);
      toast.success(`Moved to ${labels[status]}`);
      await refresh();
    } catch (e) { toast.error((e as Error).message); }
    finally {
      pendingMoves.current.delete(id);
      setMovingTickets(new Set(pendingMoves.current));
    }
  }
  const activeProjectId = project?.id;
  useEffect(() => {
    if (!activeProjectId) return;
    const params = new URLSearchParams(window.location.search);
    params.set("workspace", activeProjectId);
    if(area === "workflow") params.set("view","workflow"); else params.delete("view");
    if (area === "reviews" && reviewSpace) params.set("review", reviewSpace);
    else params.delete("review");
    params.delete("ticket");
    window.history.replaceState(null, "", `/?${params}`);
  }, [area, reviewSpace, activeProjectId]);
  const navigateReview = useCallback((id: string | null) => { if (!confirmGraphNavigation()) return; setReviewSpace(id); setArea(current => id ? "reviews" : current === "reviews" ? "tickets" : current); }, []);
  const changeArea = (next: Area) => { if (next !== area && !confirmGraphNavigation()) return; setArea(next); setLog(null); setCreating(false); };

  const ticketCards = new Map(tickets.map(t => [t.id, <article key={t.id} style={ticketColor(t.id)} data-ticket-id={t.id} data-done={t.status === "done" || undefined} draggable={ticketView === "board" && !busy && !movingTickets.has(t.id)} onDragStart={e => { e.dataTransfer.setData("application/x-gantry-ticket", t.id); e.dataTransfer.effectAllowed = "move"; setDragging(t.id); }} onDragEnd={() => { setDragging(null); setDropColumn(null); }} className={cn("gantry-ticket rounded-lg border", selected === t.id && "gantry-ticket-selected", dragging === t.id && "opacity-50")}>
                  <button onClick={() => openTicket(t.id)} className="flex w-full flex-col gap-3 p-3 text-left focus-visible:outline-2 focus-visible:outline-ring" aria-pressed={selected === t.id}>
                    <span className="flex w-full items-start gap-2 break-words text-sm font-semibold"><span aria-hidden="true" className="gantry-ticket-dot mt-1 size-2 shrink-0 rounded-full" /><span className="min-w-0 flex-1">{t.title}</span><TicketReviewStatus ticket={t} groups={data?.pulls ?? []} /></span>
                    <span className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground"><GitBranchIcon className="size-3 shrink-0" /><span className="truncate font-mono">{t.branch}</span></span>
                    <TicketPullRequests ticket={t} groups={data?.pulls ?? []} />
                    {t.workflow && <GraphStatus run={t.workflow} execution={t.execution} />}
                    {t.conversation && <span className="text-xs text-muted-foreground">Chat linked · {t.conversation.providerName}</span>}
                    {t.run && <span className="text-xs text-muted-foreground">{t.run.agent} · {t.run.state}</span>}
                  </button>
                  {t.status === "done" && <div className="border-t px-2 py-1"><Button size="sm" variant="ghost" disabled={busy} onClick={() => setCleaning(t)} aria-label={`Clean worktrees for ${t.title}`}>Clean worktrees</Button></div>}
                  <div className="gantry-ticket-actions flex flex-wrap gap-1 border-t px-2 py-1"><Button size="sm" variant="ghost" onClick={() => openTicket(t.id, false, true)} aria-label={`Edit ticket ${t.title}`}>Edit</Button>{t.status === "in_progress" && <><Button size="sm" variant="ghost" disabled={busy} onClick={() => void openChatFor(t)} aria-label={`Open chat for ${t.title}`}><MessageSquareIcon />Open chat</Button><Button size="sm" variant="ghost" disabled={busy || !t.reviewSpaceId} onClick={() => void review([], t)} aria-label={`Open review space for ${t.title}`}><GitPullRequestIcon />Review<ArrowUpRightIcon /></Button><Button size="sm" variant="ghost" onClick={() => openTicket(t.id, true)} aria-label={`Preview ${t.title}`}><MonitorIcon />Preview</Button></>}<Button size="sm" variant="ghost" className="ml-auto" disabled={busy || !!(t.run && ["starting", "running", "interrupting"].includes(t.run.state))} onClick={() => setDeleting(t)} aria-label={`Delete ticket ${t.title}`}><Trash2Icon />Delete</Button></div>
                </article>]));

  return <div className="gantry-workspace flex h-full min-h-0 flex-col bg-background">
    {cleaning && <CleanupWorktreesDialog ticketId={cleaning.id} title={cleaning.title} onClose={() => setCleaning(null)} onCleaned={refresh} />}
    {deleting && <DeleteTicketDialog title={deleting.title} busy={busy} onCancel={() => setDeleting(null)} onDelete={() => void act(() => gantry.deleteTicket(deleting.id), "Ticket deleted").then(ok => { if (ok) { if (selected === deleting.id) closeTicket(); setDeleting(null); } })} />}
    <header className="app-bar flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <span className="flex items-center gap-2 text-sm font-semibold"><LayoutListIcon className="size-5 text-violet-600 dark:text-violet-300" />Gantry</span>
      <div className="flex-1" /><span className="hidden text-xs text-muted-foreground sm:block" role="status">{error ? "Connection interrupted" : data ? "Connected locally" : "Connecting…"}</span>
      <SettingsLink /><ThemeToggle />
    </header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex max-h-[35dvh] overflow-y-auto md:max-h-none shrink-0 flex-col gap-5 border-b bg-muted/20 p-4 md:w-56 md:border-r md:border-b-0">
        <nav aria-label="Workspaces" className="space-y-1"><h2 className="mb-2 px-2 text-xs font-medium text-muted-foreground">Workspaces</h2>
          {!data?.projects.length && <p className="px-2 text-sm text-muted-foreground">No workspace connected</p>}
          {data?.projects.map((p) => { const active = data.tickets.filter((t) => t.projectId === p.id && t.status === "in_progress").length; return <Button key={p.id} variant={project?.id === p.id ? "secondary" : "ghost"} className="h-auto min-h-8 w-full justify-start text-left" aria-current={project?.id === p.id ? "true" : undefined} title={p.workspace} onClick={() => { if (project?.id === p.id || !confirmGraphNavigation()) return; setReviewSpace(null); setArea("tickets"); setProjectId(p.id); localStorage.setItem("gantry-workspace", p.id); setSelected(null); setCreating(false); setLog(null); }}><span className="min-w-0 flex-1 whitespace-normal break-words">{p.name}</span>{active > 0 && <span className="pl-2 text-xs tabular-nums text-muted-foreground" aria-label={`${active} in progress`}>{active}</span>}</Button>; })}
        </nav>
        <nav aria-label="Gantry workspace" className="flex gap-1 md:flex-col">
          {([["tickets", "Tickets", LayoutListIcon, tickets.filter(t => t.status === "in_progress").length], ["reviews", "Reviews", GitPullRequestIcon, pulls.length]] as const).map(([id, label, Icon, count]) =>
            <Button key={id} variant={area === id ? "secondary" : "ghost"} className={cn("justify-start", area === id && (id === "tickets" ? "gantry-nav-tickets" : "gantry-nav-reviews"))} aria-current={area === id ? "page" : undefined} onClick={() => changeArea(id)}><Icon />{label}<span className="ml-auto pl-3 text-xs tabular-nums text-muted-foreground">{count}</span></Button>)}
        </nav>
        {project && <nav aria-label="Previews" className="space-y-1"><h2 className="mb-2 flex items-center gap-2 px-2 text-xs font-semibold text-muted-foreground"><MonitorIcon className="size-4" />Previews</h2>{previewEntries.map(entry => <Button key={entry.id} variant={area === "previews" && activePreview.id === entry.id ? "secondary" : "ghost"} className={cn("h-auto min-h-8 w-full justify-start pl-6 text-left", area === "previews" && activePreview.id === entry.id && "gantry-nav-reviews")} aria-current={area === "previews" && activePreview.id === entry.id ? "page" : undefined} onClick={() => { if (!confirmGraphNavigation()) return; setPreviewTicket(entry.id); changeArea("previews"); closeTicket(); }}><span className="min-w-0 whitespace-normal break-words">{entry.name}</span></Button>)}</nav>}
        <div className="mt-auto space-y-3">
          {project && <Button variant={area === "workflow" ? "secondary" : "ghost"} size="sm" className="w-full justify-start" aria-current={area === "workflow" ? "page" : undefined} onClick={() => changeArea("workflow")}><GitBranchIcon />Workspace graph</Button>}
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setAdding(!adding)}><PlusIcon /> Add workspace</Button>
          {project && <p className="break-all text-xs leading-relaxed text-muted-foreground">{project.workspace}</p>}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {adding && <form className="flex flex-wrap items-end gap-3 border-b p-6" onSubmit={(e) => { e.preventDefault(); void act(() => gantry.addProject(workspace.trim()), "Workspace connected").then((ok) => { if (ok) { setAdding(false); setWorkspace(""); } }); }}>
          <label className="min-w-64 flex-1 space-y-2 text-sm">Workspace folder<Input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="/path/to/repository or workspace" required autoFocus /></label>
          {typeof window !== "undefined" && "gantryDesktop" in window && <Button type="button" variant="outline" onClick={() => void (window as unknown as { gantryDesktop: { pickFolder(): Promise<string | null> } }).gantryDesktop.pickFolder().then(dir => { if (dir) setWorkspace(dir); })}><FolderOpenIcon /> Browse…</Button>}
          <Button type="submit" disabled={busy || !workspace.trim()}>Connect workspace</Button><Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
        </form>}
        {area === "workflow" && project && <WorkspaceGraphPage key={project.id} project={project}/>}
        {area !== "workflow" && area !== "previews" && !(area === "reviews" && reviewSpace) && <div className="flex flex-wrap items-center gap-3 border-b px-6 py-5">
          <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">{area === "tickets" ? "Tickets" : "Ready for review"}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{area === "tickets" ? "Create a worktree, build the feature, and open a pull request." : "Review related pull requests together."}</p></div>
          {area === "tickets" && <div role="group" aria-label="Ticket view" className="flex rounded-lg border p-1">
            {(["board", "graph"] as const).map(view => <Button key={view} size="sm" variant={ticketView === view ? "secondary" : "ghost"} aria-pressed={ticketView === view} onClick={() => { setTicketView(view); localStorage.setItem("gantry-ticket-view", view); }}>{view === "board" ? <LayoutListIcon /> : <NetworkIcon />}{view === "board" ? "Board" : "Graph"}</Button>)}
          </div>}
          <Button variant="outline" disabled={busy} onClick={() => void refresh()} aria-label="Refresh Gantry"><RefreshCwIcon /></Button>
          {area === "tickets" && project && <Button disabled={busy} onClick={() => { if (!confirmGraphNavigation()) return; setCreating(true); setSelected(null); setLog(null); setTicketTab("details"); }}><PlusIcon /> New ticket</Button>}
          {area === "reviews" && project && <Button variant="outline" disabled={busy} onClick={() => void act(() => gantry.refreshProject(project.id), "Remote sync queued")}><RefreshCwIcon /> Sync remote</Button>}
        </div>}
        {error && <div role="alert" className="border-b bg-destructive/5 px-6 py-3 text-sm text-destructive">{error} {data && "Showing the last loaded state."}</div>}
        {!data && !error && <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin" /> Loading your workspaces…</div>}
        {data && !project && <div className="max-w-xl space-y-3 p-8"><h2 className="text-lg font-medium">Connect your first workspace</h2><p className="text-sm leading-relaxed text-muted-foreground">Choose a Git repository or a folder of repositories. Gantry creates local configuration automatically. Configure your provider once in Settings, then start a ticket.</p><Button onClick={() => setAdding(true)}>Add workspace</Button></div>}
        <SetupCheck />
        {area === "tickets" && tickets.some(t => t.status !== "done" && graphSummary(t.workflow, t.execution)?.waiting) && <div className="flex flex-wrap items-center gap-2 border-b bg-amber-50 px-6 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"><span className="font-medium">Waiting on you</span>{tickets.filter(t => t.status !== "done" && graphSummary(t.workflow, t.execution)?.waiting).map(t => <Button key={t.id} size="sm" variant="ghost" onClick={() => openTicket(t.id)}>{t.title}</Button>)}</div>}
        {area !== "workflow" && area !== "previews" && jobs.length > 0 && <details className="border-b px-6 py-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Activity · {jobs.length} recent jobs</summary><div className="mt-3 space-y-2">{jobs.map((j) => <div key={j.id} className="flex flex-wrap items-center gap-2"><State value={j.state} /><span>{j.kind} · {j.detail || j.phase || j.error || "Queued"}</span>{j.error && <span className="text-destructive">{j.error}</span>}</div>)}</div></details>}

        {project && previewEntries.map(entry => {
          const owner = tickets.find(ticket => ticket.id === entry.id);
          const active = area === "previews" && activePreview.id === entry.id;
          return <div key={`${project.id}:${entry.id}`} className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <TicketPreview active={active} name={entry.name} preview={entry.preview} refresh={refresh} openingChat={busy}
              owner={owner} onChat={openChatFor} onTicketReview={review} reviewDisabled={busy || !owner?.reviewSpaceId} />
          </div>;
        })}
        {project && area === "tickets" && <div className="min-h-0 flex-1">
          {ticketView === "graph" ? <TicketGraph tickets={tickets} cards={ticketCards} connected={!error} /> : <section className="grid grid-cols-1 divide-y md:grid-cols-3 md:divide-x md:divide-y-0" aria-label="Ticket board">
            {["backlog", "in_progress", "done"].map(status => {
              const column = tickets.filter(t => t.status === status).sort((a,b) => (a.position ?? 0) - (b.position ?? 0));
              return <section key={status} className={cn("gantry-column min-h-64 min-w-0 p-4 transition-colors", dropColumn === status && "bg-muted")} aria-label={labels[status]} onDragOver={e => { if (dragging && !busy) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropColumn(status); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropColumn(null); }} onDrop={e => { e.preventDefault(); if (!busy) void moveTicket(e.dataTransfer.getData("application/x-gantry-ticket"), status); }}>
                <h2 className={cn("mb-4 flex items-center gap-2 text-sm font-medium", status === "backlog" ? "text-violet-700 dark:text-violet-300" : status === "in_progress" ? "text-sky-700 dark:text-sky-300" : "text-emerald-700 dark:text-emerald-300")}>
                  {status === "backlog" ? <CircleDashedIcon className="size-4" /> : status === "in_progress" ? <CircleDotIcon className="size-4" /> : <CircleCheckIcon className="size-4" />}{labels[status]}<span className="ml-auto rounded-md bg-current/10 px-2 py-0.5 text-xs tabular-nums">{column.length}</span></h2>
                <div className="space-y-3">{column.map(t => ticketCards.get(t.id))}</div>
                {!column.length && <p className="py-6 text-xs text-muted-foreground">{status === "backlog" ? "New tickets start here." : status === "in_progress" ? "Active work appears here." : "Completed tickets appear here."}</p>}
              </section>;
            })}
          </section>}
          {(creating || ticket) && <TicketDialog color={ticket ? ticketColor(ticket.id) : undefined} title={creating ? "New ticket" : ticket!.title} onClose={closeTicket} actions={ticket?.status === "in_progress" && ticket.execution ? <Button size="sm" disabled={busy} onClick={() => void openChatFor(ticket)}><MessageSquareIcon />Open master chat<ArrowUpRightIcon /></Button> : undefined}>
            {ticket && <div className="flex shrink-0 gap-1 border-b px-6 py-2" role="tablist" aria-label="Ticket sections">{(["details", ...(ticket.status === "in_progress" ? ["preview"] : [])] as ("details" | "preview")[]).map(tab => <Button key={tab} role="tab" aria-selected={ticketTab === tab} variant={ticketTab === tab ? "secondary" : "ghost"} onClick={() => { if (tab !== ticketTab && !confirmGraphNavigation()) return; setTicketTab(tab); setLog(null); }}>{tab === "details" ? "Details" : "Preview"}</Button>)}</div>}
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {log && <section className="border-b p-6"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-medium">{log.title}</h2><Button variant="ghost" size="sm" onClick={() => setLog(null)}>Close log</Button></div><pre className="max-h-80 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">{log.text || "No output yet."}</pre></section>}
            {(creating || ticketTab === "details") && <section id="ticket-details" aria-label="Ticket details">
            <div className="min-w-0">{creating ? <TicketForm
              key={`new-${project.id}`}
              project={project}
              busy={busy}
              onCancel={closeTicket}
              onSave={async (input) => {
                await act(async () => {
                  await gantry.createTicket(project.id, input);
                  setSelected(null);
                  setCreating(false);
                });
              }}
            /> : ticket &&
              <TicketDetail key={ticket.id} editing={editingTicket} setEditing={setEditingTicket} ticket={ticket} pullGroups={data?.pulls ?? []} project={project} busy={busy || movingTickets.has(ticket.id)} act={act} onReview={(urls) => review(urls, ticket)} onLog={showLog} onDeleted={closeTicket} onStage={status => moveTicket(ticket.id, status)} />}</div></section>}
        {ticket && ticketTab === "preview" && ticket.status === "in_progress" && <section id="ticket-preview" aria-label="Ticket preview" className="divide-y"><h3 className="pb-4 text-sm font-medium">Preview</h3>{ticketPreviews.map((p) => <section key={p.id} className="space-y-4 p-6">
          <div className="flex flex-wrap items-center gap-3"><GitBranchIcon className="size-4 text-muted-foreground" /><h2 className="min-w-0 break-all font-medium">{p.isPrimary ? "Main workspace" : p.branch}</h2><State value={p.paused ? "paused" : p.status} /><div className="flex-1" />
            {!p.archived && !p.retired && !p.removed ? <><Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => gantry.previewAction(p.id, p.paused ? "resume" : "pause"))}>{p.paused ? "Resume" : "Pause"}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => gantry.previewAction(p.id, "restart"))}>Restart</Button></> : <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => gantry.previewAction(p.id, "restore"))}>Restore</Button>}
          </div>
          <div className="space-y-2">{p.services.map((s) => <div key={s.id} className="flex flex-wrap items-center gap-3 text-sm"><span className="w-28 truncate font-medium">{s.id}</span><State value={s.state} /><span className="font-mono text-xs text-muted-foreground">{s.port ? `:${s.port}` : ""}</span>{s.openLink && s.state === "ready" && <a href={s.openLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-4">Open preview<ArrowUpRightIcon className="size-3" /></a>}{s.logUrl && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void showLog(`${s.id} log`, s.logUrl!)}>Logs</Button>}{s.error && <p className="w-full break-words text-xs text-destructive">{s.error}</p>}</div>)}</div>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Checkouts and environment</summary><div className="mt-3 space-y-2">{p.checkouts.map((c) => <p key={c.repositoryId} className="break-all">{c.repositoryId} · {c.path}</p>)}{project.environments.length > 0 && <label className="flex items-center gap-2">Environment<select className={selectClass} value={p.environment ?? project.environments.find((e) => e.default)?.id ?? ""} disabled={busy} onChange={(e) => void act(() => gantry.previewAction(p.id, "environment", { environmentId: e.target.value }))}>{project.environments.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>}</div></details>
        </section>)}{!ticketPreviews.length && <p className="p-6 text-sm text-muted-foreground">No preview for this ticket yet. Create its worktrees from Details or start work in Chat.</p>}</section>}
          </div></TicketDialog>}
        </div>}
        {project && reviewSpace && <div className={area === "reviews" ? "flex min-h-0 flex-1 flex-col" : "hidden"}><ReviewWorkspace key={reviewSpace} spaceId={reviewSpace} initialTarget={null} initialFile={null} onNavigateSpace={navigateReview} /></div>}
        {project && area === "reviews" && !reviewSpace && <div className="divide-y">{pulls.map((g) => <section key={g.id} className="space-y-4 p-6"><div className="flex flex-wrap items-center gap-3"><GitBranchIcon className="size-4 text-muted-foreground" /><h2 className="min-w-0 flex-1 break-all font-medium">{g.branch}</h2><State value={g.ready ? "ready" : "blocked"} /><Button size="sm" disabled={busy} onClick={() => void review(Object.values(g.pulls).map((p) => p.url))}>Review {Object.keys(g.pulls).length > 1 ? "together" : "PR"}<ArrowUpRightIcon /></Button></div>
          {Object.entries(g.pulls).map(([repo, p]) => <div key={repo} className="flex flex-wrap items-center gap-3 text-sm"><GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" /><button className="min-w-0 flex-1 break-words text-left hover:underline" disabled={busy} onClick={() => void review([p.url])}>{repo} #{p.number} · {p.title}</button><a href={p.url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-4">GitHub</a></div>)}{g.blockers.length > 0 && <p className="text-xs text-muted-foreground">{g.blockers.join(" · ")}</p>}
        </section>)}{!pulls.length && <p className="p-6 text-sm text-muted-foreground">No open pull requests. Sync remote to check for new reviews.</p>}</div>}
      </main>
    </div>
  </div>;
}

type TicketInput = {
  title: string;
  description: string;
  scopes?: string[];
  branch?: string;
  workflowTemplateId?: string;
  graph?: Workflow;
};
function TicketForm({ project, ticket, busy, onSave, onCancel }: { project: ProjectView; ticket?: TicketView; busy: boolean; onSave: (input: TicketInput) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [branch, setBranch] = useState(ticket?.branch ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [scopes, setScopes] = useState(() => ticketServiceScopes(ticket ?? {}, project.services));
  const [scopesTouched, setScopesTouched] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name: string; graph: Workflow }[] | null>(null);
  const [templateId, setTemplateId] = useState('default');
  const [templateError, setTemplateError] = useState('');
  const [graph, setGraph] = useState<Workflow | null>(null);
  const initialGraph = templates?.find(template => template.id === templateId)?.graph;
  const graphEdits = useUnsavedGraph(
    !ticket && !!graph && !!initialGraph &&
    JSON.stringify(graph) !== JSON.stringify(canvasWorkflow(initialGraph)),
  );

  useEffect(() => {
    if (ticket) return;
    let live = true;

    gantry.workspaceWorkflowTemplates(project.id).then(items => {
      if (live) {
        setTemplates(items);
        const initial = items.find(template => template.id === 'default')?.graph;
        setGraph(initial ? canvasWorkflow(initial) : null);
      }
    }).catch(error => {
      if (live) setTemplateError(error.message);
    });

    return () => { live = false; };
  }, [project.id, ticket]);
  const scopeIds = [...new Set([...project.services.map((service) => service.id), ...(ticket?.scopes ?? [])])];
  // Refreshes can change ticket props without the user editing this selection.
  const scopeChanged = !ticket || scopesTouched;

  return <div className={ticket ? "max-w-3xl" : "grid min-w-0 gap-6 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]"}>
    <form className="space-y-5" onSubmit={(event) => {
      event.preventDefault();

      void onSave({
        title: title.trim(),
        description,
        ...(!ticket && graph ? { workflowTemplateId: templateId, graph } : {}),
        ...(scopeChanged ? { scopes } : {}),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
      });
    }}>
    <h2 className="text-lg font-semibold">{ticket ? "Edit ticket" : "New ticket"}</h2>
    <label className="block space-y-2 text-sm">Title<Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to change?" /></label>
    <label className="block space-y-2 text-sm">Branch<Input aria-label="Branch" value={branch} onChange={e => setBranch(e.target.value)} placeholder="Generated from title if empty" /></label>
    <label className="block space-y-2 text-sm">Notes<Textarea aria-label="Notes" className="min-h-32" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Context, expected behavior, and acceptance criteria" /></label>
    {!ticket && <label className="block space-y-2 text-sm">Workspace graph template
      <select aria-label="Workspace graph template" className={selectClass} disabled={busy || !templates} value={templateId} onChange={event => {
        if (!graphEdits.confirmDiscard()) return;
        setTemplateId(event.target.value);
        const initial = templates?.find(template => template.id === event.target.value)?.graph;
        setGraph(initial ? canvasWorkflow(initial) : null);
      }}>
        {!templates && <option value="default">Loading graphs…</option>}
        {templates?.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
      </select>
      <span className="block text-xs text-muted-foreground">This ticket gets its own copy of the selected graph.</span>
      {templateError && <span role="alert" className="block text-destructive">{templateError}</span>}
    </label>}
    <fieldset className="space-y-2" disabled={busy}>
      <legend className="mb-2 text-sm font-medium">Scope</legend>
      <p className="text-xs text-muted-foreground">Select the services this ticket affects. Leave empty for workspace-wide work.</p>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {scopeIds.map((id) => (
          <label key={id} className="flex min-h-9 min-w-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scopes.includes(id)}
              onChange={(event) => { setScopesTouched(true); setScopes((selected) => event.target.checked ? [...selected, id] : selected.filter((value) => value !== id)); }}
            />
            <span className="break-all">{id}{!project.services.some((service) => service.id === id) && " (unavailable)"}</span>
          </label>
        ))}
      </div>
      {!project.services.length && <p className="text-xs text-muted-foreground">No services configured in gantry.yaml.</p>}
      {ticket && ticket.scopeDescription?.startsWith("Legacy scope:") && <p className="text-xs text-muted-foreground">Legacy scope: {ticket.scope}. Select services to replace it.</p>}
    </fieldset>
    <div className="flex gap-2">
      <Button type="submit" disabled={busy || !title.trim() || (!ticket && !graph)}>
        {busy && <Loader2Icon className="animate-spin" />}
        {ticket ? "Save changes" : "Create ticket"}
      </Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
  </form>
  {!ticket && <fieldset disabled={busy} className="min-w-0 overflow-hidden rounded-lg border">
    <legend className="px-2 text-sm font-medium">Ticket workflow</legend>
    <p className="px-5 py-3 text-xs text-muted-foreground">
      Edit stages, instructions, and connections here. Your graph is saved with Create ticket and only affects this ticket.
    </p>
    {graph && initialGraph && <div className="flex h-[min(64dvh,720px)] min-h-[520px] flex-col">
      <WorkflowCanvas key={templateId} initial={initialGraph} onChange={setGraph} />
    </div>}
    {!graph && <p role="status" className="p-5 text-sm text-muted-foreground">{templateError ? 'Unable to load the workflow. Close and reopen to retry.' : 'Loading workflow…'}</p>}
  </fieldset>}
  </div>;
}

function TicketDetail({ ticket: t, pullGroups, project, busy, act, onReview, onLog, onDeleted, editing, setEditing, onStage }: { onStage: (status: string) => Promise<void>; editing: boolean; setEditing: (value: boolean) => void; ticket: TicketView; pullGroups: StatusView["pulls"]; project: ProjectView; busy: boolean; act: (action: () => Promise<unknown>, message?: string) => Promise<boolean>; onReview: (urls: string[]) => Promise<void>; onLog: (title: string, url: string) => Promise<void>; onDeleted: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const running = t.run && ["starting", "running", "interrupting"].includes(t.run.state);
  if (editing) return <TicketForm project={project} ticket={t} busy={busy} onCancel={() => setEditing(false)} onSave={async (input) => { if (await act(() => gantry.updateTicket(t.id, input))) setEditing(false); }} />;
  return <div className="space-y-6">
    <TicketWorkflow key={t.id} ticket={t} refresh={() => act(async () => {})} />
    <div className="space-y-3"><div className="flex items-start gap-3"><h2 className="min-w-0 flex-1 break-words text-lg font-semibold">{t.title}</h2><Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (confirmGraphNavigation()) setEditing(true); }}>Edit</Button></div><p className="break-all font-mono text-xs text-muted-foreground">{t.branch}</p>
      <p className="break-words text-xs text-muted-foreground">Scope: {t.scopeDescription ?? (ticketServiceScopes(t, project.services).join(", ") || "Workspace-wide")}</p>
      <TicketPullRequests ticket={t} groups={pullGroups} />
      <label className="flex items-center gap-3 text-sm">Stage<select className={selectClass} value={t.status} disabled={busy} onChange={(e) => void onStage(e.target.value)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{t.description || "No notes added."}</p>
    </div>
    <TicketOutcome key={`outcome-${t.id}`} ticket={t} busy={busy} act={act} />
    {t.status === "in_progress" && <section className="space-y-3 border-t pt-5">{t.execution ? <p className="text-sm text-muted-foreground">Use Open master chat at the top to discuss the whole ticket, ask for changes, or resume its workflow. Stage history is available in the graph.</p> : <TicketConversation ticketId={t.id} done={false} />}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !!running} onClick={() => void act(() => ticketChatRequest(t.id, "prepare"), "Ticket worktrees are ready")}>Create worktrees</Button></div>
      {t.run && <div className="flex flex-wrap items-center gap-2"><State value={t.run.state} /><Button size="sm" variant="ghost" disabled={busy} onClick={() => void onLog("Previous agent output", t.run!.logUrl)}>View previous output</Button>{running && <Button variant="outline" disabled={busy} onClick={() => void act(() => gantry.handoffTicket(t.id), "Previous agent stopped. You can continue in Chat.")}>Take over</Button>}</div>}
    </section>}
    {t.status === "in_progress" && <section className="space-y-3 border-t pt-5"><h3 className="text-sm font-medium">Review space</h3><p className="text-sm text-muted-foreground">Everything this ticket produced stays together in its own space: pull requests, commits it made locally (like a plan), and links in its final notes.</p><Button disabled={busy || !t.reviewSpaceId} onClick={() => void onReview([])}>Open ticket space<ArrowUpRightIcon /></Button>{t.pullRequests.map((p) => <Button key={p.url} variant="outline" size="sm" disabled={busy} onClick={() => void onReview([p.url])}>Review {p.role} #{p.number}</Button>)}{t.artifacts.map((a) => <a key={a.file} href={bridge(a.url)} target="_blank" rel="noreferrer" className="block text-sm underline underline-offset-4">{a.label}</a>)}</section>}
    <div className="border-t pt-5">{confirmDelete ? <div className="space-y-3"><p className="text-sm">Delete this ticket? Its worktrees and pull requests will remain.</p><div className="flex gap-2"><Button variant="destructive" disabled={busy} onClick={() => void act(() => gantry.deleteTicket(t.id)).then((ok) => { if (ok) onDeleted(); })}>Delete ticket</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button></div></div> : <Button variant="ghost" size="sm" disabled={busy || !!running} onClick={() => setConfirmDelete(true)}>Delete ticket…</Button>}</div>
  </div>;
}
