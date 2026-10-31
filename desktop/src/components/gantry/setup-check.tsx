"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";

type Check = { ok: boolean; detail: string };

/** Says what is missing before Gantry can open chats: herdr, and a coding CLI. Nothing shows once both are there. */
export function SetupCheck() {
  const [status, setStatus] = useState<{ ok: boolean; herdr: Check; agent: Check } | null>(null);
  useEffect(() => {
    const check = () => fetch("/api/setup", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then(setStatus, () => {});
    void check();
    // Installing something in another window should clear the banner without a restart.
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  if (!status || status.ok) return null;
  const missing = [status.herdr.ok ? null : status.herdr.detail, status.agent.ok ? null : status.agent.detail].filter(Boolean);
  return <div role="alert" className="flex items-start gap-2 border-b bg-amber-50 px-6 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
    <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="font-medium">Gantry needs herdr and a coding CLI (Claude Code or OpenCode) to open chats.</p>
      {missing.map((m) => <p key={m}>{m}</p>)}
    </div>
    <Link href={status.herdr.ok ? "/settings" : "/settings?tab=chats"} className="shrink-0 underline underline-offset-4">Settings</Link>
  </div>;
}
