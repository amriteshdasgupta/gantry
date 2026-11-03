import path from 'node:path';
import type { Database } from '../db/db.js';
import type { LoadedProject } from '../projects/registry.js';
import type { Logger } from '../log.js';
import { syncRepository, githubCliAvailable, listOpenPulls, pullState, type RemoteSnapshot, type OpenPull } from './remote.js';
import { mergedEvidence, matchPull, shouldRetire } from './merge-evidence.js';
import { git, isGitRepository } from '../git/git.js';
import { VcsStore, parseRemote, listGitlabPulls, listBitbucketPulls } from './vcs.js';

/**
 * Remote synchronization (every 2 minutes and explicitly after a PR merge;
 * never from the ticket-start path):
 *
 *  1. refresh each repository's remote default-branch view over Git
 *  2. if the GitHub CLI is authenticated, refresh exact open-PR state
 *  3. recompute merge evidence for active previews (with cached proofs)
 *  4. retire previews whose changes are fully integrated, stopping services
 *  5. complete tickets whose branch previews retired
 */

interface MergeProof {
  head: string;
  path: string;
  branch: string | null;
  evidence: string;
}

interface PreviewEvidence {
  [repositoryId: string]: { evidence: string; proof: MergeProof; number: number | null; url: string | null };
}

export class RemoteSync {
  private readonly snapshots = new Map<string, RemoteSnapshot>();
  private readonly openPulls = new Map<string, OpenPull[]>();
  private githubCli: boolean | null = null;
  /** Last open-PR listing error per `projectId:repositoryId`, shown on the Reviews page. */
  readonly pullErrors = new Map<string, string>();
  private running: Promise<void> | null = null;
  lastSyncAt = 0;
  lastError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly projects: () => Promise<LoadedProject[]>,
    private readonly log: Logger,
    private readonly onCompleteTickets: (branches: Map<string, Set<string>>) => Promise<void>,
    readonly vcs: VcsStore = new VcsStore(''),
  ) {}

  snapshotFor(projectId: string, repositoryId: string): RemoteSnapshot | null {
    return this.snapshots.get(`${projectId}:${repositoryId}`) ?? null;
  }

  pullsFor(projectId: string): { branch: string; pulls: Record<string, OpenPull> }[] {
    const groups = new Map<string, Record<string, OpenPull>>();
    for (const [key, pulls] of this.openPulls) {
      if (!key.startsWith(`${projectId}:`)) continue;
      const repositoryId = key.slice(projectId.length + 1);
      for (const pull of pulls) {
        const group = groups.get(pull.branch) ?? {};
        group[repositoryId] = pull;
        groups.set(pull.branch, group);
      }
    }
    return [...groups.entries()].map(([branch, pulls]) => ({ branch, pulls }));
  }

  async sync(fresh = false): Promise<void> {
    if (this.running) {
      await this.running;
      if (!fresh) return;
      // A merge may have happened after the active pass fetched GitHub state.
      return this.sync(true);
    }
    this.running = this.runSync();
    try { await this.running; }
    finally { this.running = null; }
  }

  private async runSync(): Promise<void> {
    try {
      const completedBranches = new Map<string, Set<string>>();
      if (this.githubCli === null) this.githubCli = await githubCliAvailable();
      const failures: string[] = [];
      for (const project of await this.projects()) {
        // One workspace failing must not stop the others from syncing.
        try {
          await this.syncProject(project, completedBranches);
        } catch (error) {
          const message = `${project.config.project.id}: ${(error as Error).message}`;
          failures.push(message);
          this.log.warn(`remote sync failed for ${message}`);
        }
      }
      await this.onCompleteTickets(completedBranches);
      this.lastSyncAt = Date.now();
      this.lastError = failures.length ? failures.join('; ') : null;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.log.warn(`remote sync failed: ${this.lastError}`);
    }
  }

  private async syncProject(project: LoadedProject, completedBranches: Map<string, Set<string>>): Promise<void> {
    const projectId = project.config.project.id;
    for (const repo of project.config.repositories) {
      const repoPath = path.resolve(project.workspace, repo.path);
      if (!(await isGitRepository(repoPath))) continue;
      const key = `${projectId}:${repo.id}`;
      this.snapshots.set(key, await syncRepository(this.snapshots.get(key) ?? null, repoPath, repo.remote, repo.defaultBranch));
      const snapshot = this.snapshots.get(key)!;
      const remoteUrl = await git(repoPath, 'remote', 'get-url', repo.remote).catch(() => '');
      const provider = this.vcs.providerFor(projectId, repo.id, remoteUrl);
      const remote = parseRemote(remoteUrl);
      try {
        if (provider === 'github') {
          if (this.githubCli && snapshot.repository) this.openPulls.set(key, await listOpenPulls(snapshot.repository, repoPath));
          else this.openPulls.delete(key);
        } else if (!remote) {
          throw new Error(`cannot read the ${provider} repository from remote "${remoteUrl}"`);
        } else {
          this.openPulls.set(key, provider === 'gitlab' ? await listGitlabPulls(this.vcs, remote.host, remote.slug) : await listBitbucketPulls(this.vcs, remote.slug));
        }
        this.pullErrors.delete(key);
      } catch (error) {
        this.pullErrors.set(key, (error as Error).message);
        this.log.debug(`${key}: ${provider} pull list failed: ${(error as Error).message}`);
      }
    }
    try {
      await this.recomputeEvidence(project, completedBranches);
    } catch (error) {
      this.log.warn(`${projectId}: merge evidence failed: ${(error as Error).message}`);
    }
  }

  private async recomputeEvidence(project: LoadedProject, completedBranches: Map<string, Set<string>>): Promise<void> {
    const projectId = project.config.project.id;
    const previews = this.db.prepare("SELECT * FROM previews WHERE project_id=? AND retired=0 AND removed=0").all(projectId) as {
      id: string;
      branch: string;
      merge_evidence: string | null;
    }[];
    for (const preview of previews) {
      if (preview.branch === '__primary__') continue;
      try {
        await this.recomputePreviewEvidence(projectId, preview, completedBranches);
      } catch (error) {
        // A single branch whose history is too large to compare must not stop the rest.
        this.log.warn(`${projectId}:${preview.branch}: merge evidence skipped: ${(error as Error).message}`);
      }
    }
  }

  private async recomputePreviewEvidence(
    projectId: string,
    preview: { id: string; branch: string; merge_evidence: string | null },
    completedBranches: Map<string, Set<string>>,
  ): Promise<void> {
    {
      const checkouts = this.db.prepare('SELECT * FROM preview_checkouts WHERE preview_id=?').all(preview.id) as {
        repository_id: string;
        path: string;
        head: string | null;
        branch: string | null;
        is_fallback: number;
        is_primary: number;
      }[];
      const previousProofs = safeParseProofs(preview.merge_evidence);
      const previousNumbers = safeParseNumbers((this.db.prepare('SELECT merge_evidence FROM previews WHERE id=?').get(preview.id) as { merge_evidence: string | null })?.merge_evidence);
      const evidence: PreviewEvidence = {};
      const changed: { repositoryId: string; evidence: string | null }[] = [];
      for (const checkout of checkouts) {
        if (checkout.is_primary || checkout.is_fallback) continue;
        if (!checkout.head) {
          changed.push({ repositoryId: checkout.repository_id, evidence: null });
          continue;
        }
        const snapshot = this.snapshots.get(`${projectId}:${checkout.repository_id}`);
        const remembered = previousProofs[checkout.repository_id];
        if (remembered && remembered.head === checkout.head && remembered.path === checkout.path && remembered.branch === checkout.branch) {
          // Merge is terminal for this checkout/head — remembered even while offline.
          evidence[checkout.repository_id] = { evidence: remembered.evidence, proof: remembered, number: previousNumbers[checkout.repository_id] ?? null, url: prUrl(snapshot, previousNumbers[checkout.repository_id] ?? null) };
          changed.push({ repositoryId: checkout.repository_id, evidence: remembered.evidence });
          continue;
        }
        if (!snapshot?.head) {
          changed.push({ repositoryId: checkout.repository_id, evidence: null });
          continue; // no successful fetch yet: keep the preview running
        }
        const pulls = snapshot.pullRefs;
        const pr = matchPull({ head: checkout.head }, pulls, previousNumbers[checkout.repository_id] ?? null, snapshot.head);
        let evidenceText: string | null = null;
        const prNumber: number | null = pr?.number ?? null;
        if (!pr) {
          const { isAncestor } = await import('../git/git.js');
          if (await isAncestor(checkout.path, checkout.head, snapshot.head)) evidenceText = 'Unchanged companion branch';
        } else if (snapshot.repository) {
          const exact = await pullState(snapshot.repository, pr.number);
          if (exact?.merged && exact.head === checkout.head) evidenceText = 'GitHub confirmed this PR head was merged';
          else evidenceText = await mergedEvidence(checkout.path, { head: checkout.head }, pr, snapshot.head, pulls);
        } else {
          evidenceText = await mergedEvidence(checkout.path, { head: checkout.head }, pr, snapshot.head, pulls);
        }
        if (evidenceText) {
          evidence[checkout.repository_id] = {
            evidence: evidenceText,
            proof: { head: checkout.head, path: checkout.path, branch: checkout.branch, evidence: evidenceText },
            number: prNumber,
            url: prUrl(snapshot, prNumber),
          };
        }
        changed.push({ repositoryId: checkout.repository_id, evidence: evidenceText });
      }
      if (!changed.length) return;
      const retired = shouldRetire(changed.map((item) => ({ isFallback: false, isPrimary: false, evidence: item.evidence })));
      this.db.prepare('UPDATE previews SET merge_evidence=?, retired=?, updated_at=? WHERE id=?').run(
        JSON.stringify(evidence),
        retired ? 1 : 0,
        new Date().toISOString(),
        preview.id,
      );
      if (retired) {
        this.log.info(`${preview.branch}: merged — preview retired`);
        const set = completedBranches.get(projectId) ?? new Set<string>();
        set.add(preview.branch);
        completedBranches.set(projectId, set);
      }
    }
  }
}

function prUrl(snapshot: RemoteSnapshot | undefined, number: number | null): string | null {
  return snapshot?.repository && number ? `https://github.com/${snapshot.repository}/pull/${number}` : null;
}

function safeParseProofs(raw: string | null): Record<string, MergeProof> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { evidence: string; proof: MergeProof }>;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value.proof]));
  } catch {
    return {};
  }
}

function safeParseNumbers(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { number: number | null }>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value.number).map(([key, value]) => [key, value.number as number]));
  } catch {
    return {};
  }
}
