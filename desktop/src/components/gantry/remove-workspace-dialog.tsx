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
    <h2 id="remove-workspace-title" className="text-lg font-semibold">Remove {project.name}?</h2>
    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Its previews stop and it leaves Gantry. Your repositories, worktrees and gantry.yaml in {project.workspace} are not changed.</p>
    <div className="mt-4 space-y-3">
      <div>
        <Button variant="outline" className="w-full" disabled={busy} onClick={() => void remove(false)}>Remove and keep data</Button>
        <p className="mt-1 text-xs text-muted-foreground">Tickets and history stay on this machine and return if you add this workspace again.</p>
      </div>
      <div>
        <Button variant="destructive" className="w-full" disabled={busy} onClick={() => void remove(true)}>Remove and delete data</Button>
        <p className="mt-1 text-xs text-muted-foreground">Permanently deletes this workspace&apos;s tickets, run history, logs, artifacts, chats and settings from Gantry.</p>
      </div>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    <div className="mt-6 flex justify-end"><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button></div>
  </dialog>;
}
