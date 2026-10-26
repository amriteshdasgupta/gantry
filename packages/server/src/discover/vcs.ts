import fs from 'node:fs';
import path from 'node:path';
import type { OpenPull } from './remote.js';

/**
 * Version-control provider choice and API tokens for the Reviews page.
 * Stored in the private data directory (0600); tokens are never returned by the API.
 */

export const PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const;
export type Provider = (typeof PROVIDERS)[number];

interface VcsFile {
  /** `projectId:repositoryId` -> chosen provider. Absent means "detect from the remote". */
  repositories: Record<string, Provider>;
  tokens: Partial<Record<Provider, string>>;
  /** Self-hosted GitLab base URL, e.g. https://gitlab.example.com */
  gitlabUrl?: string;
}

export function detectProvider(remoteUrl: string): Provider {
  if (/bitbucket\./i.test(remoteUrl)) return 'bitbucket';
  if (/gitlab/i.test(remoteUrl)) return 'gitlab';
  return 'github';
}

/** Host and `group/.../name` path from an SSH or HTTPS remote URL. */
export function parseRemote(url: string): { host: string; slug: string } | null {
  const match = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  return match ? { host: match[1]!, slug: match[2]! } : null;
}

export class VcsStore {
  private data: VcsFile = { repositories: {}, tokens: {} };

  constructor(private readonly file: string) {
    try {
      this.data = { repositories: {}, tokens: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch { /* first run */ }
  }

  providerFor(projectId: string, repositoryId: string, remoteUrl: string): Provider {
    return this.data.repositories[`${projectId}:${repositoryId}`] ?? detectProvider(remoteUrl);
  }

  isChosen(projectId: string, repositoryId: string): boolean {
    return `${projectId}:${repositoryId}` in this.data.repositories;
  }

  token(provider: Provider): string | undefined { return this.data.tokens[provider]; }
  get gitlabUrl(): string | undefined { return this.data.gitlabUrl; }
  hasToken(provider: Provider): boolean { return Boolean(this.data.tokens[provider]); }

  setProvider(projectId: string, repositoryId: string, provider: Provider | null): void {
    const key = `${projectId}:${repositoryId}`;
    if (provider) this.data.repositories[key] = provider;
    else delete this.data.repositories[key];
    this.save();
  }

  setCredentials(provider: Provider, token: string | null | undefined, gitlabUrl?: string | null): void {
    if (token === null) delete this.data.tokens[provider];
    else if (token) this.data.tokens[provider] = token.trim();
    if (provider === 'gitlab' && gitlabUrl !== undefined) {
      if (gitlabUrl) {
        const url = new URL(gitlabUrl);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('GitLab URL must be http(s)');
        this.data.gitlabUrl = url.origin;
      } else delete this.data.gitlabUrl;
    }
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) })
    .catch((error: Error) => { throw new Error(`could not reach ${new URL(url).host} (${(error.cause as Error | undefined)?.message ?? error.message})`); });
  if (response.status === 401 || response.status === 403) throw new Error(`${new URL(url).host} rejected the token (HTTP ${response.status}); check it in Settings`);
  if (!response.ok) throw new Error(`${new URL(url).host} returned HTTP ${response.status}`);
  return response.json();
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Base API origin for a provider and remote host (GitLab may be self-hosted). */
function gitlabBase(store: VcsStore, host: string): string {
  return store.gitlabUrl ?? `https://${host}`;
}

export async function listGitlabPulls(store: VcsStore, host: string, slug: string): Promise<OpenPull[]> {
  const token = store.token('gitlab');
  const rows = (await getJson(
    `${gitlabBase(store, host)}/api/v4/projects/${encodeURIComponent(slug)}/merge_requests?state=opened&per_page=100`,
    token ? { 'PRIVATE-TOKEN': token } : {},
  )) as Json[];
  if (!Array.isArray(rows)) throw new Error(`GitLab returned an invalid merge request list for ${slug}`);
  return rows.map((mr) => {
    const pipeline = String(mr.head_pipeline?.status ?? '');
    const checks: OpenPull['checks'] = !pipeline ? 'unknown'
      : pipeline === 'success' ? 'passed'
      : ['failed', 'canceled'].includes(pipeline) ? 'failed' : 'pending';
    const mergeState = String(mr.detailed_merge_status ?? mr.merge_status ?? 'unknown');
    const blockers: string[] = [];
    if (mr.draft) blockers.push('Draft');
    if (mergeState !== 'mergeable') blockers.push(`GitLab status: ${mergeState.replace(/_/g, ' ')}`);
    if (checks === 'failed') blockers.push('Checks failed');
    if (checks === 'pending') blockers.push('Checks pending');
    return {
      number: Number(mr.iid), title: String(mr.title ?? ''), url: String(mr.web_url ?? ''),
      branch: String(mr.source_branch ?? ''), head: String(mr.sha ?? ''),
      author: mr.author?.username ?? null, updatedAt: String(mr.updated_at ?? ''),
      draft: Boolean(mr.draft), mergeState, checks, ready: blockers.length === 0, blockers, reviewStatus: 'waiting',
    };
  });
}

export async function listBitbucketPulls(store: VcsStore, slug: string): Promise<OpenPull[]> {
  const token = store.token('bitbucket');
  const body = (await getJson(
    `https://api.bitbucket.org/2.0/repositories/${slug.split('/').map(encodeURIComponent).join('/')}/pullrequests?state=OPEN&pagelen=50`,
    token ? { Authorization: `Bearer ${token}` } : {},
  )) as Json;
  if (!Array.isArray(body.values)) throw new Error(`Bitbucket returned an invalid pull request list for ${slug}`);
  return (body.values as Json[]).map((pr) => {
    const draft = Boolean(pr.draft);
    return {
      number: Number(pr.id), title: String(pr.title ?? ''), url: String(pr.links?.html?.href ?? ''),
      branch: String(pr.source?.branch?.name ?? ''), head: String(pr.source?.commit?.hash ?? ''),
      author: pr.author?.display_name ?? null, updatedAt: String(pr.updated_on ?? ''),
      draft, mergeState: 'unknown', checks: 'unknown' as const, ready: !draft, blockers: draft ? ['Draft'] : [], reviewStatus: 'waiting' as const,
    };
  });
}

/** Cheap authenticated call used by Settings → Test. Returns the signed-in user's name. */
export async function testCredentials(store: VcsStore, provider: Provider, host?: string): Promise<string> {
  const token = store.token(provider);
  if (!token) throw new Error('No token saved');
  if (provider === 'gitlab') {
    const user = (await getJson(`${gitlabBase(store, host ?? 'gitlab.com')}/api/v4/user`, { 'PRIVATE-TOKEN': token })) as Json;
    return String(user.username);
  }
  if (provider === 'bitbucket') {
    const user = (await getJson('https://api.bitbucket.org/2.0/user', { Authorization: `Bearer ${token}` })) as Json;
    return String(user.display_name ?? user.username);
  }
  const user = (await getJson('https://api.github.com/user', { Authorization: `Bearer ${token}` })) as Json;
  return String(user.login);
}
