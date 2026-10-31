"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { gantry, type VcsProvider, type VcsView } from "@/lib/client/gantry";

export const PROVIDERS: { id: VcsProvider; label: string; hint: string }[] = [
  { id: "github", label: "GitHub", hint: "Uses the GitHub CLI (gh auth login); a token is only needed to test here." },
  { id: "gitlab", label: "GitLab", hint: "Personal or project access token with read_api scope." },
  { id: "bitbucket", label: "Bitbucket", hint: "Repository or workspace access token (read pull requests)." },
];

/** Save the API tokens the Reviews page needs; they apply to every workspace. */
export function VersionControlSettings() {
  const [view, setView] = useState<VcsView | null>(null);
  const [tokens, setTokens] = useState<Partial<Record<VcsProvider, string>>>({});
  /** What each field last saved, so a saved token stays visible as dots without being sent again. */
  const [savedTokens, setSavedTokens] = useState<Partial<Record<VcsProvider, string>>>({});
  const [gitlabUrl, setGitlabUrl] = useState("");

  const show = useCallback((next: VcsView) => { setView(next); setGitlabUrl(next.gitlabUrl); }, []);
  const load = useCallback(async () => show(await gantry.vcs()), [show]);
  useEffect(() => { gantry.vcs().then(show, (e: Error) => toast.error(e.message)); }, [show]);

  async function save(input: Parameters<typeof gantry.saveVcs>[0], message: string) {
    try { await gantry.saveVcs(input); await load(); toast.success(message); return true; }
    catch (e) { toast.error((e as Error).message); return false; }
  }
  async function saveToken(provider: VcsProvider, label: string) {
    const token = tokens[provider];
    const changed = token && token !== savedTokens[provider] ? token : undefined;
    const saved = await save({ credentials: { provider, token: changed, ...(provider === "gitlab" ? { gitlabUrl } : {}) } }, `${label} saved`);
    if (saved && changed) setSavedTokens((s) => ({ ...s, [provider]: changed }));
  }
  async function removeToken(provider: VcsProvider, label: string) {
    if (!await save({ credentials: { provider, token: null } }, `${label} token removed`)) return;
    setTokens((t) => ({ ...t, [provider]: "" }));
    setSavedTokens((s) => ({ ...s, [provider]: undefined }));
  }
  async function test(provider: VcsProvider) {
    try { toast.success(`Signed in as ${(await gantry.testVcs(provider)).user}`); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="vcs-heading">
      <div className="flex flex-col gap-1">
        <h1 id="vcs-heading" className="text-2xl font-semibold tracking-tight">Version control</h1>
        <p className="text-sm text-muted-foreground">
          Access tokens for every workspace. Tokens stay on this computer and are never shown again. Choose each repository&apos;s provider from its workspace settings.
        </p>
      </div>
      {!view && <Skeleton className="h-20" />}
      {PROVIDERS.map((p) => (
        <div key={p.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <span className="font-medium">{p.label}</span>
            <span className="text-xs text-muted-foreground">{view?.providers[p.id].hasToken ? "Token saved" : "No token saved"}</span>
          </div>
          <p className="text-xs text-muted-foreground">{p.hint}</p>
          {p.id === "gitlab" && (
            <Input aria-label="GitLab URL" placeholder="https://gitlab.com (set for self-hosted)" value={gitlabUrl} onChange={(e) => setGitlabUrl(e.target.value)} />
          )}
          <div className="flex gap-2">
            <Input
              // The server never returns a saved token or its length, so a saved token shows as a fixed run of dots.
              type="password" autoComplete="off" aria-label={`${p.label} token`} placeholder={view?.providers[p.id].hasToken ? "••••••••••••••••" : "Paste token"}
              className={view?.providers[p.id].hasToken ? "placeholder:text-foreground!" : undefined}
              value={tokens[p.id] ?? ""} onChange={(e) => setTokens((t) => ({ ...t, [p.id]: e.target.value }))}
            />
            <Button
              variant="outline"
              disabled={(!tokens[p.id] || tokens[p.id] === savedTokens[p.id]) && (p.id !== "gitlab" || gitlabUrl === (view?.gitlabUrl ?? ""))}
              onClick={() => void saveToken(p.id, p.label)}
            >Save</Button>
            <Button variant="outline" disabled={!view?.providers[p.id].hasToken} onClick={() => void test(p.id)}>Test</Button>
            <Button variant="ghost" disabled={!view?.providers[p.id].hasToken} onClick={() => void removeToken(p.id, p.label)}>Remove</Button>
          </div>
        </div>
      ))}
    </section>
  );
}
