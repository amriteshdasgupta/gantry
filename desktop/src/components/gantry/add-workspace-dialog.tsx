"use client";
import { useEffect, useRef, useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddWorkspaceDialog({ busy, onCancel, onConnect }: { busy: boolean; onCancel: () => void; onConnect: (workspace: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [workspace, setWorkspace] = useState("");
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="add-workspace-title" onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }} className="fixed inset-0 m-auto max-h-[85dvh] w-[min(36rem,calc(100vw-32px))] overflow-auto rounded-xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/40">
    <form onSubmit={e => { e.preventDefault(); onConnect(workspace.trim()); }}>
      <h2 id="add-workspace-title" className="text-lg font-semibold">Add workspace</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Choose a Git repository or a folder of repositories.</p>
      <div className="mt-4 flex items-end gap-2">
        <label className="min-w-0 flex-1 space-y-2 text-sm">Workspace folder<Input value={workspace} onChange={e => setWorkspace(e.target.value)} placeholder="/path/to/repository or workspace" required autoFocus /></label>
        {typeof window !== "undefined" && "gantryDesktop" in window && <Button type="button" variant="outline" onClick={() => void (window as unknown as { gantryDesktop: { pickFolder(): Promise<string | null> } }).gantryDesktop.pickFolder().then(dir => { if (dir) setWorkspace(dir); })}><FolderOpenIcon /> Browse…</Button>}
      </div>
      <div className="mt-6 flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy || !workspace.trim()}>{busy ? "Connecting…" : "Connect workspace"}</Button></div>
    </form>
  </dialog>;
}
