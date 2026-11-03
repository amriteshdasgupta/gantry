"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { gantry, type ProjectView } from "@/lib/client/gantry";

export function RemoveWorkspaceDialog({ project, onClose, onRemoved }: { project: ProjectView; onClose: () => void; onRemoved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  async function remove(deleteData: boolean) {
    setBusy(true);
    setError(null);
    try { await gantry.removeProject(project.id, deleteData); onRemoved(); }
    // Errors stay inside the dialog: toasts sit behind a modal's backdrop.
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <dialog ref={ref} aria-labelledby="remove-workspace-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} className="fixed inset-0 m-auto max-h-[85dvh] w-[min(36rem,calc(100vw-32px))] overflow-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl backdrop:bg-black/50">
    <h2 id="remove-workspace-title" className="text-lg font-semibold">Remove &quot;{project.name}&quot; from Gantry?</h2>
    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Any running previews will stop. Your files in {project.workspace} won&apos;t be touched (including repositories, worktrees and gantry.yaml).</p>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <div>
        <Button variant="outline" className="w-full" disabled={busy} onClick={() => void remove(false)}>Keep data</Button>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Gantry saves your tickets and history. Add the workspace again later to get them back.</p>
      </div>
      <div>
        <Button variant="destructive" className="w-full" disabled={busy} onClick={() => void remove(true)}>Delete data</Button>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Gantry permanently deletes your tickets, run history, logs, artifacts, chats and settings for this workspace. You can&apos;t undo this.</p>
      </div>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    <div className="mt-6 flex justify-end"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button></div>
  </dialog>;
}
