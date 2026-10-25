"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRightIcon, Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/theme-toggle";
import { gantry } from "@/lib/client/gantry";
import { BackToTickets } from "@/components/gantry/link";
import { SettingsLink } from "@/components/settings-link";
import { Review, type ReviewActivity } from "@/components/review/review";
import { api, shortLabel, spaceHref } from "@/lib/client/api";
import type { Space, SpacesResponse } from "@/lib/types";
import { SpaceSwitcher } from "./space-switcher";
import { PrStateIcon } from "@/components/pr-state";

interface Props {
  projectId?: string;
  onNavigateSpace?: (id: string | null) => void;
  spaceId: string;
  initialTarget: string | null;
  initialFile: string | null;
}

export function Workspace({ spaceId, initialTarget, initialFile, onNavigateSpace, projectId }: Props) {
  const router = useRouter();
  const [data, setData] = useState<SpacesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(initialTarget);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(initialTarget ? [initialTarget] : []));
  const [activity, setActivity] = useState<Record<string, ReviewActivity>>({});
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const files = useRef<Record<string, string>>({});
  // Where each tab opens when first shown; later moves live in `files`.
  const [startFiles, setStartFiles] = useState<Record<string, string>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const space = data?.spaces.find((s) => s.id === spaceId) ?? null;

  const replaceSpace = useCallback((next: Space) => {
    setData((d) => d && { ...d, spaces: d.spaces.map((s) => (s.id === next.id ? next : s)) });
  }, []);

  // Load spaces; a ?pr= that isn't in this space yet gets added to it.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let res = await api.spaces();
        const here = res.spaces.find((s) => s.id === spaceId);
        if (here && initialTarget && !here.targets.includes(initialTarget)) {
          const { space: updated } = await api.addToSpace(initialTarget, spaceId);
          res = { ...res, spaces: res.spaces.map((s) => (s.id === updated.id ? updated : s)) };
        } else if (here && res.current !== spaceId) {
          api.updateSpace(spaceId, { makeCurrent: true }).catch(() => {});
        }
        if (!live) return;
        setData(res);
        const s = res.spaces.find((x) => x.id === spaceId);
        const first = initialTarget ?? s?.active ?? s?.targets[0] ?? null;
        setActive(first);
        if (first) setVisited((v) => new Set(v).add(first));
        files.current = { ...(s?.files ?? {}) };
        if (initialTarget && initialFile) files.current[initialTarget] = initialFile;
        setStartFiles({ ...files.current });
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [spaceId, initialTarget, initialFile]);

  // Discover new ticket PRs even while the user stays inside its review space.
  const gantryTicket = space?.gantry?.ticketId;
  useEffect(() => {
    if (!gantryTicket) return;
    let live = true;
    let loading = false;
    const refresh = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        await gantry.status();
        const next = await api.spaces();
        if (live) {
          if (!next.spaces.some(s => s.id === spaceId)) { if (onNavigateSpace) onNavigateSpace(null); else router.replace("/"); return; }
          setData(next);
          const first = next.spaces.find(s => s.id === spaceId)?.targets[0];
          if (first) { setActive(a => a ?? first); setVisited(v => new Set(v).add(first)); }
        }
      } catch { /* Keep the last review available when Gantry is offline. */ }
      finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => { live = false; clearInterval(timer); };
  }, [gantryTicket, spaceId, router, onNavigateSpace]);

  // Address bar mirrors the open tab and file.
  const syncUrl = useCallback(
    (target: string | null) => {
      if (onNavigateSpace) return;
      const params = new URLSearchParams();
      if (target) params.set("pr", target);
      const file = target ? files.current[target] : undefined;
      if (file) params.set("file", file);
      const qs = params.toString();
      window.history.replaceState(null, "", `${spaceHref(spaceId)}${qs ? `?${qs}` : ""}`);
    },
    [spaceId, onNavigateSpace],
  );

  function open(target: string) {
    setActive(target);
    setVisited((v) => new Set(v).add(target));
    setSeen((s) => ({ ...s, [target]: activity[target]?.answers ?? 0 }));
    syncUrl(target);
    api.updateSpace(spaceId, { active: target }).catch(() => {});
  }

  const onFile = useCallback(
    (target: string, file: string) => {
      if (files.current[target] === file) {
        if (target === active) syncUrl(target);
        return;
      }
      files.current[target] = file;
      if (target === active) syncUrl(target);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        api.updateSpace(spaceId, { file: { target, path: file } }).catch(() => {});
      }, 400);
    },
    [active, spaceId, syncUrl],
  );

  const onActivity = useCallback((target: string, a: ReviewActivity) => {
    setActivity((m) => {
      const prev = m[target];
      if (prev && prev.title === a.title && prev.pending === a.pending && prev.answers === a.answers) return m;
      return { ...m, [target]: a };
    });
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const { space: updated, id } = await api.addToSpace(url, spaceId);
      replaceSpace(updated);
      setUrl("");
      setAdding(false);
      open(id);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function close(target: string) {
    if (!space) return;
    const i = space.targets.indexOf(target);
    const targets = space.targets.filter((t) => t !== target);
    const next = target === active ? targets[Math.min(i, targets.length - 1)] ?? null : active;
    replaceSpace({ ...space, targets, active: next });
    setVisited((v) => {
      const n = new Set(v);
      n.delete(target);
      return n;
    });
    setActive(next);
    syncUrl(next);
    try {
      replaceSpace(await api.updateSpace(spaceId, { targets, active: next }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function switchTo(id: string) {
    await api.updateSpace(id, { makeCurrent: true }).catch(() => {});
    if (onNavigateSpace) onNavigateSpace(id); else router.push(spaceHref(id));
  }

  async function create() {
    try {
      const s = await api.createSpace();
      if (onNavigateSpace) onNavigateSpace(s.id); else router.push(spaceHref(s.id));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function rename(id: string, name: string) {
    try {
      replaceSpace(await api.updateSpace(id, { name }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(id: string) {
    const victim = data?.spaces.find((s) => s.id === id);
    if (!victim || !window.confirm(`Delete "${victim.name}"? Its PR chats are kept.`)) return;
    try {
      const res = await api.deleteSpace(id);
      setData(res);
      if (id === spaceId) { if (onNavigateSpace) onNavigateSpace(null); else router.push(spaceHref(res.current)); }
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const tabs = useMemo(() => space?.targets ?? [], [space]);

  if (error) {
    return <Centered className="text-destructive">{error}</Centered>;
  }
  if (!data) {
    return (
      <Centered>
        <Loader2Icon className="mr-2 size-4 animate-spin" /> Loading space…
      </Centered>
    );
  }
  if (!space) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-3">
          <p>That space doesn&apos;t exist any more.</p>
          <Button variant="outline" nativeButton={false} render={<Link href={spaceHref(data.current)} />}>
            Go to your current space
          </Button>
        </div>
      </Centered>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={cn("flex h-12 shrink-0 items-center gap-2 border-b px-3", !onNavigateSpace && "app-bar")}>
        {!onNavigateSpace && <BackToTickets projectId={space.gantry?.projectId} ticketId={space.gantry?.ticketId} />}
        <SpaceSwitcher
          spaces={projectId ? data.spaces.filter(s => s.gantry?.projectId === projectId || s.id === spaceId) : data.spaces}
          current={space}
          onSwitch={switchTo}
          onCreate={projectId ? undefined : create}
          onRename={rename}
          onDelete={remove}
        />
        <nav role="tablist" aria-label="Outputs in this space" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const a = activity[t];
            const unread = t !== active && (a?.answers ?? 0) > (seen[t] ?? 0);
            return (
              <div
                key={t}
                className={cn(
                  "group flex h-8 max-w-64 shrink-0 items-center gap-1.5 rounded-md border pr-1 pl-2.5 text-xs transition-colors",
                  t === active ? "border-border bg-muted font-medium" : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {a?.pending ? (
                  <Loader2Icon role="img" className="size-3 shrink-0 animate-spin" aria-label="Claude is answering" />
                ) : unread ? (
                  <span role="img" className="size-2 shrink-0 rounded-full bg-sky-500" aria-label="New answer" />
                ) : a?.prState ? (
                  <PrStateIcon state={a.prState} className="size-3.5" />
                ) : null}
                <button role="tab" aria-selected={t === active} title={a?.title ?? t} onClick={() => open(t)} className="min-w-0 truncate">
                  {shortLabel(t)}
                </button>
                <button
                  onClick={() => close(t)}
                  className="rounded p-0.5 text-muted-foreground opacity-60 hover:bg-background hover:text-foreground group-hover:opacity-100"
                  aria-label={`Close ${shortLabel(t)}`}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}
          {space.links?.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title={l.url}
              className="flex h-8 max-w-56 shrink-0 items-center gap-1 rounded-md border border-dashed px-2.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              <span className="min-w-0 truncate">{l.title}</span>
              <ArrowUpRightIcon className="size-3 shrink-0" />
            </a>
          ))}
          {adding ? (
            <form onSubmit={add} className="flex shrink-0 items-center gap-1">
              <Input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && (setAdding(false), setUrl(""))}
                placeholder="Paste a PR link"
                aria-label="PR link to add"
                className="h-7 w-72 font-mono text-xs"
              />
              <Button size="sm" type="submit" disabled={busy || !url.trim()}>
                {busy ? <Loader2Icon className="animate-spin" /> : "Add"}
              </Button>
            </form>
          ) : (
            <Button variant="ghost" size="icon-sm" onClick={() => setAdding(true)} aria-label="Add a PR to this space">
              <PlusIcon />
            </Button>
          )}
        </nav>
        {!onNavigateSpace && <><SettingsLink /><ThemeToggle /></>}
      </header>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 && (
          <Centered>
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <p className="font-medium text-foreground">{space.name} is empty</p>
              <p>Add pull requests with the + button above. Each one opens as a tab and keeps its own chat.</p>
              {!adding && (
                <Button onClick={() => setAdding(true)}>
                  <PlusIcon /> Add a PR
                </Button>
              )}
            </div>
          </Centered>
        )}
        {tabs
          .filter((t) => visited.has(t))
          .map((t) => (
            <TabPanel
              key={t}
              spaceId={spaceId}
              target={t}
              visible={t === active}
              initialFile={startFiles[t] ?? null}
              onFile={onFile}
              onActivity={onActivity}
            />
          ))}
      </div>
    </div>
  );
}

/** Tabs stay mounted while hidden so switching back keeps the file, selection and draft. */
const TabPanel = memo(function TabPanel({
  spaceId,
  target,
  visible,
  initialFile,
  onFile,
  onActivity,
}: {
  spaceId: string;
  target: string;
  visible: boolean;
  initialFile: string | null;
  onFile: (target: string, file: string) => void;
  onActivity: (target: string, a: ReviewActivity) => void;
}) {
  const handleFile = useCallback((f: string) => onFile(target, f), [onFile, target]);
  const handleActivity = useCallback((a: ReviewActivity) => onActivity(target, a), [onActivity, target]);
  return (
    <div role="tabpanel" aria-label={target} hidden={!visible} className="absolute inset-0 flex flex-col">
      <Review id={target} initialFile={initialFile} embedded spaceId={spaceId} onFileChange={handleFile} onActivity={handleActivity} />
    </div>
  );
});

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex h-full flex-1 items-center justify-center p-6 text-sm text-muted-foreground", className)}>{children}</div>;
}
