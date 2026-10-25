"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Space } from "@/lib/types";
import { spaceStyle } from "@/lib/space-style";

interface Props {
  spaces: Space[];
  current: Space;
  onSwitch: (id: string) => void;
  onCreate?: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function SpaceSwitcher({ spaces, current, onSwitch, onCreate, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  function commit(id: string) {
    if (draft.trim()) onRename(id, draft.trim());
    setEditing(null);
  }

  return (
    <div ref={root} className="relative w-48 shrink-0 sm:w-72">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch space"
        className={cn("w-full justify-start border-2", spaceStyle(current).cls.border, spaceStyle(current).cls.tint)}
      >
        <span aria-hidden>{spaceStyle(current).emoji}</span>
        <span className="min-w-0 flex-1 truncate text-left">{current.name}</span>
        <ChevronsUpDownIcon />
      </Button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-50 mt-1 w-72 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Spaces</div>
          {spaces.map((s) => (
            <div key={s.id} className={cn("group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted", s.id === current.id && "bg-muted/60")}>
              {editing === s.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit(s.id);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  aria-label="Space name"
                  className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none"
                />
              ) : (
                <button
                  role="menuitem"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => {
                    setOpen(false);
                    onSwitch(s.id);
                  }}
                >
                  <CheckIcon className={cn("size-3.5 shrink-0", s.id !== current.id && "invisible")} />
                  <span aria-hidden className={cn("flex size-5 shrink-0 items-center justify-center rounded-md text-xs", spaceStyle(s).cls.tint)}>{spaceStyle(s).emoji}</span>
                  <span className="truncate">{s.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.targets.length}</span>
                </button>
              )}
              <button
                className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                aria-label={`Rename ${s.name}`}
                onClick={() => {
                  setDraft(s.name);
                  setEditing(s.id);
                }}
              >
                <PencilIcon className="size-3.5" />
              </button>
              {spaces.length > 1 && (
                <button
                  className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => onDelete(s.id)}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              )}
            </div>
          ))}
          {onCreate && <>
            <div className="my-1 h-px bg-border" />
            <button
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            >
              <PlusIcon className="size-3.5" /> New space
            </button>
          </>}
        </div>
      )}
    </div>
  );
}
