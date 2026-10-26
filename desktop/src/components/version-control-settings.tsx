"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { gantry, type VcsProvider, type VcsView } from "@/lib/client/gantry";

const PROVIDERS: { id: VcsProvider; label: string; hint: string }[] = [
  { id: "github", label: "GitHub", hint: "Uses the GitHub CLI (gh auth login); a token is only needed to test here." },
  { id: "gitlab", label: "GitLab", hint: "Personal or project access token with read_api scope." },
  { id: "bitbucket", label: "Bitbucket", hint: "Repository or workspace access token (read pull requests)." },
];

/** Pick where each repository's pull requests live and save the API tokens the Reviews page needs. */
export function VersionControlSettings() {
  const [view, setView] = useState<VcsView | null>(null);
  const [tokens, setTokens] = useState<Partial<Record<VcsProvider, string>>>({});
  const [gitlabUrl, setGitlabUrl] = useState("");

  const show = useCallback((next: VcsView) => { setView(next); setGitlabUrl(next.gitlabUrl); }, []);
  const load = useCallback(async () => show(await gantry.vcs()), [show]);
  useEffect(() => { gantry.vcs().then(show, (e: Error) => toast.error(e.message)); }, [show]);

  async function save(input: Parameters<typeof gantry.saveVcs>[0], message: string) {
    try { await gantry.saveVcs(input); await load(); toast.success(message); }
    catch (e) { toast.error((e as Error).message); }
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
          Choose where each repository is hosted so Reviews lists its open pull requests from the right API. Tokens stay on this computer and are never shown again.
        </p>
      </div>
      {!view && <Skeleton className="h-20" />}
      {view?.repositories.map((repo) => (
        <div key={`${repo.projectId}:${repo.repositoryId}`} className="flex flex-col gap-1 rounded-lg border p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{repo.projectName} / {repo.repositoryId}</div>
              <div className="truncate text-xs text-muted-foreground">{repo.remoteUrl || "No remote"}{!repo.chosen && ` · detected ${repo.detected}`}</div>
            </div>
            <select
              aria-label={`Provider for ${repo.repositoryId}`}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={repo.provider}
              onChange={(e) => void save({ repository: { projectId: repo.projectId, repositoryId: repo.repositoryId, provider: e.target.value as VcsProvider } }, `${repo.repositoryId} uses ${e.target.value}`)}
            >
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          {repo.error && <div className="text-xs text-destructive">{repo.error}</div>}
        </div>
      ))}
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
              type="password" autoComplete="off" aria-label={`${p.label} token`} placeholder={view?.providers[p.id].hasToken ? "Replace token" : "Paste token"}
              value={tokens[p.id] ?? ""} onChange={(e) => setTokens((t) => ({ ...t, [p.id]: e.target.value }))}
            />
            <Button
              variant="outline"
              disabled={!tokens[p.id] && (p.id !== "gitlab" || gitlabUrl === (view?.gitlabUrl ?? ""))}
              onClick={() => void save({ credentials: { provider: p.id, token: tokens[p.id] || undefined, ...(p.id === "gitlab" ? { gitlabUrl } : {}) } }, `${p.label} saved`).then(() => setTokens((t) => ({ ...t, [p.id]: "" })))}
            >Save</Button>
            <Button variant="outline" disabled={!view?.providers[p.id].hasToken} onClick={() => void test(p.id)}>Test</Button>
            <Button variant="ghost" disabled={!view?.providers[p.id].hasToken} onClick={() => void save({ credentials: { provider: p.id, token: null } }, `${p.label} token removed`)}>Remove</Button>
          </div>
        </div>
      ))}
    </section>
  );
}
