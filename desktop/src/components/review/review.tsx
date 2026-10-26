"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLinkIcon, Loader2Icon, MessagesSquareIcon, PanelsTopLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ThemeToggle } from "@/components/theme-toggle";
import { BackToTickets } from "@/components/gantry/link";
import { SettingsLink } from "@/components/settings-link";
import { AgentPicker } from "@/components/agents/agent-picker";
import { api, hrefFor, spaceHref } from "@/lib/client/api";
import { subscribeChat } from "@/lib/client/chat-events";
import { useAgents } from "@/lib/client/agents";
import { threadsOf, type Thread } from "@/lib/client/threads";
import type { LocalChanges, Anchor, ChatMessage, CommentsResponse, FileResponse, PrState, Quote, TargetResponse } from "@/lib/types";
import { PrStateBadge } from "@/components/pr-state";
import { FileList } from "./file-list";
import { FileView, type Focus } from "./file-view";
import { ChatPanel, type ChatPanelHandle } from "./chat-panel";

import { MergeDialog } from "./merge-dialog";
import { PublishDialog } from "./publish-dialog";
import { ReviewLoop } from "./review-loop";

type Mode = "diff" | "full";

export interface ReviewActivity {
  title: string | null;
  prState?: PrState;
  pending: boolean;
  /** Bumps when an answer finishes, so a hidden tab can show it has news. */
  answers: number;
}

interface Props {
  id: string;
  initialFile: string | null;
  /** Inside a space: the space draws the chrome and owns the URL. */
  embedded?: boolean;
  spaceId?: string;
  onFileChange?: (file: string) => void;
  onActivity?: (a: ReviewActivity) => void;
}

export function Review({ id, initialFile, embedded = false, spaceId, onFileChange, onActivity }: Props) {
  const router = useRouter();
  const [source, setSource] = useState<"pr" | "local">("pr");
  const [local, setLocal] = useState<LocalChanges | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [publishing, setPublishing] = useState<LocalChanges | null>(null);
  const [answers, setAnswers] = useState(0);
  const localRevision = useRef<string | null>(null);
  const [data, setData] = useState<TargetResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [picked, setCurrent] = useState<string | null>(initialFile);
  const [mode, setMode] = useState<Mode>("diff");
  const [files, setFiles] = useState<Record<string, FileResponse>>({});
  const [fileError, setFileError] = useState<Record<string, string>>({});

  const [draft, setDraft] = useState<Anchor | null>(null);
  const [draftQuote, setDraftQuote] = useState<Quote[] | null>(null);
  const [comments, setComments] = useState<CommentsResponse | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Questions about the whole change live in a side panel that stays out of the way until wanted.
  const [sideOpen, setSideOpen] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ChatMessage | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const agents = useAgents();
  const agentName = agents?.agents.find((a) => a.id === agents.current)?.name ?? "the assistant";
  const chat = useRef<ChatPanelHandle>(null);

  // Plain branch browsing has no changed files: show the README until a file is picked.
  const current = picked ?? allFiles?.find((p) => /^readme(\.\w+)?$/i.test(p)) ?? null;
  const visibleFiles = useMemo(() => source === "local" ? local?.files ?? [] : data?.files ?? [], [source, local, data]);
  const canDiff = source === "local" || !!data?.target.baseSha;
  const changedPaths = useMemo(() => new Set(visibleFiles.map((f) => f.path)), [visibleFiles]);
  const effectiveMode: Mode = current && changedPaths.has(current) ? mode : "full";
  const fileKey = current ? `${effectiveMode}:${current}` : null;

  // ---------- loading ----------

  const apply = useCallback((res: TargetResponse) => {
    setData(res);
    setMessages(res.messages);
    setPending(res.pending);
    setQueued(res.queued ?? []);
    setLoadError(null);
    if (!res.target.baseSha) setShowAll(true);
    setCurrent((c) => c ?? res.files[0]?.path ?? null);
  }, []);

  const load = useCallback(
    (refresh = false) =>
      api.target(id, refresh).then(
        (res) => {
          if (refresh) {
            setFiles({});
            setFileError({});
          }
          apply(res);
        },
        (e: Error) => setLoadError(e.message),
      ),
    [id, apply],
  );

  useEffect(() => {
    let live = true;
    api.target(id).then(
      (res) => live && apply(res),
      (e: Error) => live && setLoadError(e.message),
    );
    return () => {
      live = false;
    };
  }, [id, apply]);

  const loaded = !!data;
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    const update = async () => {
      try {
        const next = await api.localChanges(id);
        if (!live) return;
        setLocalError(null); setLocal(next);
        if (localRevision.current !== next.revision) {
          const first = localRevision.current === null;
          const openLocal = first && (next.files.length || next.commits) && !id.startsWith("~");
          localRevision.current = next.revision;
          // PR files do not change with the local worktree. Keep their editors mounted
          // so a late local-status response cannot discard an in-progress question.
          if (source === "local" || openLocal) { setFiles({}); setFileError({}); setAllFiles(null); }
          // A ticket's local output opens on what it committed; its worktree's stray files can wait.
          if (openLocal) { setSource("local"); setCurrent(next.files[0]?.path ?? null); }
        }
      } catch (e) { if (live) setLocalError((e as Error).message); }
    };
    void update();
    const timer = setInterval(() => { if (!document.hidden) void update(); }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [id, loaded, answers, source]);

  // Reviewers' comments from GitHub, for pull requests.
  const isPull = data?.target.kind === "pull";
  useEffect(() => {
    if (!isPull) return;
    let live = true;
    api.comments(id).then((c) => live && setComments(c), () => {});
    return () => {
      live = false;
    };
  }, [id, isPull]);

  useEffect(() => {
    if (!data || allFiles || (!showAll && data.target.baseSha)) return;
    api.tree(id, source).then(setAllFiles, (e: Error) => toast.error(e.message));
  }, [data, showAll, allFiles, id, source]);

  useEffect(() => {
    if (!data || !current || !fileKey || files[fileKey] || fileError[fileKey]) return;
    let live = true;
    api.file(id, current, effectiveMode, source).then(
      (f) => live && setFiles((m) => ({ ...m, [fileKey]: f })),
      (e: Error) => live && setFileError((m) => ({ ...m, [fileKey]: e.message })),
    );
    return () => {
      live = false;
    };
  }, [data, current, fileKey, effectiveMode, files, fileError, id, source]);

  // Keep ?file= in the address bar without re-rendering the route (a space handles its own URL).
  useEffect(() => {
    if (!current) return;
    if (onFileChange) onFileChange(current);
    else window.history.replaceState(null, "", hrefFor(id, current));
  }, [current, id, onFileChange]);


  const title = data?.target.title ?? null;
  const prState = data?.target.prState;
  useEffect(() => {
    onActivity?.({ title, prState, pending: !!pending, answers });
  }, [onActivity, title, prState, pending, answers]);

  // ---------- chat stream ----------

  useEffect(
    () =>
      subscribeChat(id, (e) => {
          switch (e.type) {
          case "user":
            setMessages((ms) => (ms.some((m) => m.id === e.msg.id) ? ms : [...ms, e.msg]));
            // Answers run one at a time; a question asked meanwhile waits its turn.
            setQueued((q) => (q.includes(e.msg.id) ? q : [...q, e.msg.id]));
            break;
          case "start":
            setPending(e.msg);
            setQueued((q) => q.filter((x) => x !== e.msg.replyTo));
            break;
          case "delta":
            setPending((p) => (p && p.id === e.id ? { ...p, text: p.text + e.text } : p));
            break;
          case "tool":
            setPending((p) => (p && p.id === e.id ? { ...p, tools: [...(p.tools ?? []), e.tool] } : p));
            break;
          case "done":
            setPending(null);
            setAnswers((n) => n + 1);
            setMessages((ms) => (ms.some((m) => m.id === e.msg.id) ? ms : [...ms, e.msg]));
            break;
          case "deleted":
            setMessages((ms) => ms.filter((m) => m.id !== e.id && m.replyTo !== e.id && m.thread !== e.id));
            setQueued((q) => q.filter((x) => x !== e.id));
            break;
          }
      }),
    [id],
  );

  // ---------- actions ----------

  const openFile = useCallback((path: string, line?: number, side: "new" | "old" = "new") => {
    setCurrent(path);
    if (line) setFocus({ file: path, line, side, nonce: Date.now() });
  }, []);

  function openThread(t: Thread) {
    const a = t.anchor;
    if (!a) return;
    if (a.side === "old") setMode("diff");
    setCollapsed((c) => {
      if (!c.has(t.id)) return c;
      const n = new Set(c);
      n.delete(t.id);
      return n;
    });
    openFile(a.file, a.end, a.side);
  }

  function openLocation(file: string, line: number) {
    // The agent may cite a path relative to a subdirectory; match by suffix when it isn't exact.
    const known = [...changedPaths, ...(allFiles ?? [])];
    const path = known.includes(file) ? file : known.find((p) => p.endsWith(`/${file}`)) ?? file;
    if (!changedPaths.has(path)) setMode("full");
    openFile(path, line);
  }

  const added = (msg: ChatMessage) => setMessages((ms) => (ms.some((m) => m.id === msg.id) ? ms : [...ms, msg]));

  function pickDraft(a: Anchor | null, quote?: Quote[]) {
    setDraft(a);
    setDraftQuote(quote ?? null);
  }

  async function ask(text: string, anchor: Anchor | null = null, quote?: Quote[]): Promise<boolean> {
    try {
      added((await api.ask(id, text, { anchor, quote })).msg);
      if (anchor) pickDraft(null);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  }

  async function reply(thread: string, text: string): Promise<boolean> {
    try {
      added((await api.ask(id, text, { thread })).msg);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  }

  async function remove(msgId: string) {
    try {
      await api.remove(id, msgId);
      setMessages((ms) => ms.filter((m) => m.id !== msgId && m.replyTo !== msgId && m.thread !== msgId));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const stop = () => api.stop(id).catch((e: Error) => toast.error(e.message));

  async function addToSpace() {
    try {
      const { space } = await api.addToSpace(id);
      router.push(spaceHref(space.id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setAllFiles(null);
    await load(true);
    if (isPull) await api.comments(id, true).then(setComments, () => {});
    setRefreshing(false);
  }

  const threads = useMemo(() => threadsOf(messages, pending, queued), [messages, pending, queued]);
  const fileGh = useMemo(() => comments?.threads.filter((t) => t.file === current) ?? [], [comments, current]);
  const generalCount = threads.filter((t) => !t.anchor).length;
  const generalBusy = threads.some((t) => !t.anchor && (t.pending || t.waiting));
  const fileThreads = useMemo(() => threads.filter((t) => t.anchor && t.anchor.file === current), [threads, current]);
  const threadCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of threads) if (t.anchor) c[t.anchor.file] = (c[t.anchor.file] ?? 0) + 1;
    for (const t of comments?.threads ?? []) c[t.file] = (c[t.file] ?? 0) + 1;
    return c;
  }, [threads, comments]);

  // ---------- render ----------

  if (loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-lg text-sm text-destructive">{loadError}</p>
        <div className="flex gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/" />}>Back</Button>
          <Button onClick={() => (setLoadError(null), load())}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-5 animate-spin" />
        <p>Fetching {id}…</p>
        <p className="text-xs">The first open of a repo clones it, which can take a minute.</p>
      </div>
    );
  }

  const t = data.target;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={embedded ? "flex h-11 shrink-0 items-center gap-2 border-b px-3" : "app-bar flex h-12 shrink-0 items-center gap-2 border-b px-3"}>
        {!embedded && (
          <BackToTickets />
        )}
        {t.prState && <PrStateBadge state={t.prState} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{t.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {t.kind === "doc" ? t.subtitle : `${t.kind === "local" ? t.repo : `${t.owner}/${t.repo}`} · ${t.subtitle}`}
          </div>
        </div>
        <AgentPicker />
        {isPull && <ReviewLoop targetId={id} spaceId={spaceId} />}
        <Button
          variant={sideOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setSideOpen((o) => !o)}
          aria-pressed={sideOpen}
          aria-label="Questions about the whole change"
          title="Ask about the whole change"
        >
          {generalBusy ? <Loader2Icon className="animate-spin" /> : <MessagesSquareIcon />}
          Whole change
          {generalCount > 0 && <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[10px] tabular-nums">{generalCount}</span>}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={refresh} disabled={refreshing} aria-label="Fetch latest">
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
        </Button>
        {t.url && <Button variant="ghost" size="icon-sm" nativeButton={false} render={<a href={t.url} target="_blank" rel="noreferrer" />} aria-label={t.kind === "doc" ? `Open in ${t.repo}` : "Open on GitHub"}>
          <ExternalLinkIcon />
        </Button>}
        {!embedded && (
          <>
            <Button variant="ghost" size="sm" onClick={addToSpace}>
              <PanelsTopLeftIcon /> Add to space
            </Button>
            <SettingsLink />
            <ThemeToggle />
          </>
        )}
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div role="group" aria-label="Change source" className="flex gap-1">
          <Button size="sm" variant={source === "pr" ? "secondary" : "ghost"} aria-pressed={source === "pr"} onClick={() => { setSource("pr"); setCurrent(data.files[0]?.path ?? null); setFiles({}); setFileError({}); setAllFiles(null); }}>{t.kind === "doc" ? `In ${t.repo}` : t.kind === "local" ? "Committed" : "PR changes"}</Button>
          <Button size="sm" variant={source === "local" ? "secondary" : "ghost"} aria-pressed={source === "local"} onClick={() => { setSource("local"); setCurrent(local?.files[0]?.path ?? null); setFiles({}); setFileError({}); setAllFiles(null); }}>{t.kind === "doc" ? "Draft" : "Local changes"}{local ? ` (${local.files.length})` : ""}</Button>
        </div>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{localError || (t.kind === "doc"
          ? source === "local" ? local?.files.length ? `Edits not yet published to ${t.repo}.` : "No edits yet. Edit the document here or ask Claude to." : `What changed in ${t.repo} since Gantry last fetched it.`
          : t.kind === "local"
          ? source === "local" ? local?.files.length || local?.commits ? "Uncommitted edits and new commits in the ticket's worktree." : "Nothing uncommitted in the ticket's worktree." : "What the ticket committed in its worktree. There is no pull request."
          : source === "local" ? local?.files.length || local?.commits ? "Edits and commits not yet on this PR." : "No local changes waiting to be published." : "Changes published on GitHub.")}</p>
        {isPull && t.prState === "open" && <Button size="sm" variant="outline" disabled={!local || !!local.files.length || !!local.commits || !!pending || !!queued.length || !!localError || refreshing} onClick={() => setMerging(true)}>Merge PR</Button>}
        {(isPull || t.kind === "doc") && <Button size="sm" disabled={!local || (!local.files.length && !local.commits) || !!pending || !!queued.length || !!localError} onClick={() => setPublishing(local)}>{t.kind === "doc" ? `Publish to ${t.repo}` : "Commit and push"}</Button>}
      </div>
      {merging && <MergeDialog id={id} head={t.headSha} title={t.title} onClose={() => setMerging(false)} onMerged={(warning) => {
        setMerging(false);
        setData(current => current ? { ...current, target: { ...current.target, prState: "merged" } } : current);
        window.dispatchEvent(new Event("gantry:merge-completed"));
        if (warning) toast.warning(warning); else toast.success("PR merged. Gantry will move the ticket to Done once all its changes are merged.");
        void refresh();
      }} />}
      {publishing && <PublishDialog id={id} snapshot={publishing} doc={t.kind === "doc" ? { source: t.repo, url: t.url } : undefined} onClose={() => setPublishing(null)} onPublished={(warning) => { setPublishing(null); setSource("pr"); localRevision.current = null; toast.success(t.kind === "doc" ? `Published to ${t.repo}` : "Changes pushed to the PR"); if (warning) toast.warning(warning); void refresh(); }} />}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="files" defaultSize="18%" minSize={160}>
          <FileList
            changed={visibleFiles}
            all={allFiles}
            showAll={showAll}
            onShowAll={setShowAll}
            canDiff={canDiff}
            current={current}
            threads={threadCounts}
            onOpen={(p) => openFile(p)}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="code" minSize={320}>
          <FileView
            target={t}
            onSaved={() => { setSource("local"); setFiles({}); setFileError({}); setAllFiles(null); void api.localChanges(id).then(setLocal, (e: Error) => toast.error(e.message)); }}
            local={source === "local"}
            path={current}
            data={fileKey ? files[fileKey] ?? null : null}
            loading={!!fileKey && !files[fileKey]}
            error={fileKey ? fileError[fileKey] ?? null : null}
            mode={effectiveMode}
            onMode={setMode}
            draft={draft}
            draftQuote={draftQuote}
            onDraft={pickDraft}
            threads={fileThreads}
            ghThreads={source === "local" ? [] : fileGh}
            collapsed={collapsed}
            onToggleThread={(tid) =>
              setCollapsed((c) => {
                const n = new Set(c);
                if (n.has(tid)) n.delete(tid);
                else n.add(tid);
                return n;
              })
            }
            agentName={agentName}
            onAsk={(text, a, quote) => ask(text, a, quote)}
            onReply={reply}
            onStop={stop}
            onDelete={remove}
            onOpenLocation={openLocation}
            focus={focus}
          />
        </ResizablePanel>
        {sideOpen && <ResizableHandle />}
        {sideOpen && (
        <ResizablePanel id="side" defaultSize="28%" minSize={280}>
          <ChatPanel
            ref={chat}
            threads={threads}
            onAsk={(text, quote) => ask(text, null, quote)}
            general={comments?.general ?? []}
            onStop={stop}
            onDelete={remove}
            onOpenThread={openThread}
            onOpenLocation={openLocation}
          />
        </ResizablePanel>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
