"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PROVIDERS } from "@/components/version-control-settings";
import { gantry, type ProjectView, type VcsProvider, type VcsView } from "@/lib/client/gantry";

/** Choose where each of this workspace's repositories is hosted, so Reviews lists its pull requests from the right API. */
export function WorkspaceSettingsDialog({ project, onClose }: { project: ProjectView; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [repositories, setRepositories] = useState<VcsView["repositories"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  // Errors stay inside the dialog: toasts sit behind a modal's backdrop.
  const load = useCallback(() => gantry.vcs().then(view => { setRepositories(view.repositories.filter(r => r.projectId === project.id)); setError(null); }, (e: Error) => setError(e.message)), [project.id]);
  useEffect(() => { void load(); }, [load]);

  async function choose(repositoryId: string, provider: VcsProvider | null) {
    try { await gantry.saveVcs({ repository: { projectId: project.id, repositoryId, provider } }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <dialog ref={ref} aria-labelledby="workspace-settings-title" onCancel={e => { e.preventDefault(); onClose(); }} className="fixed inset-0 m-auto max-h-[85dvh] w-[min(36rem,calc(100vw-32px))] overflow-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl backdrop:bg-black/50">
    <h2 id="workspace-settings-title" className="text-lg font-semibold">{project.name} settings</h2>
    <h3 className="mt-4 text-sm font-medium">Version control</h3>
    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Choose where each repository is hosted so Reviews lists its open pull requests from the right API.</p>
    <div className="mt-3 flex flex-col gap-2">
      {!repositories && !error && <Skeleton className="h-14" />}
      {repositories?.map(repo => <div key={repo.repositoryId} className="flex flex-col gap-1 rounded-lg border p-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{repo.repositoryId}</div>
            <div className="truncate text-xs text-muted-foreground">{repo.remoteUrl || "No remote"}{!repo.chosen && ` · detected ${repo.detected}`}</div>
          </div>
          <select aria-label={`Provider for ${repo.repositoryId}`} className="h-9 rounded-md border bg-background px-2 text-sm" value={repo.chosen ? repo.provider : ""} onChange={e => void choose(repo.repositoryId, (e.target.value || null) as VcsProvider | null)}>
            <option value="">Auto-detect ({repo.detected})</option>
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        {repo.error && <div className="text-xs text-destructive">{repo.error}</div>}
      </div>)}
      {repositories?.length === 0 && <p className="text-sm text-muted-foreground">This workspace has no repositories.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
    <div className="mt-6 flex items-center justify-between gap-2">
      <Link href="/settings?tab=version-control" className="text-sm underline underline-offset-4">Manage access tokens</Link>
      <Button variant="outline" onClick={onClose}>Close</Button>
    </div>
  </dialog>;
}
