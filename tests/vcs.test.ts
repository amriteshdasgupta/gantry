import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { expect, test } from 'vitest';
import { VcsStore, detectProvider, parseRemote, listGitlabPulls, listBitbucketPulls } from '../packages/server/src/discover/vcs.js';

test('provider detection uses the host, not the repository name', () => {
  expect(detectProvider('git@github.com:o/gitlab-tools.git')).toBe('github');
  expect(detectProvider('https://github.com/o/bitbucket.org.git')).toBe('github');
  expect(detectProvider('https://gitlab.example.com/g/r.git')).toBe('gitlab');
});

test('the GitLab token is only sent to its own host', async () => {
  let token: string | string[] | undefined = 'unset';
  const server = await mock((req, res) => { token = req.headers['private-token']; res.statusCode = 404; res.end('{}'); });
  const store = new VcsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-')), 'v.json'));
  store.setCredentials('gitlab', 'tok', server.url);
  // Another host: the request goes to https://other.invalid, never to the configured server.
  await expect(listGitlabPulls(store, 'other.invalid', 'a/b')).rejects.toThrow(/other\.invalid/);
  expect(token).toBe('unset');
  server.close();
});

test('a 404 without a token suggests adding one', async () => {
  const server = await mock((_req, res) => { res.statusCode = 404; res.end('{}'); });
  const store = new VcsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-')), 'v.json'));
  store.setCredentials('gitlab', null, server.url);
  await expect(listGitlabPulls(store, '127.0.0.1', 'a/b')).rejects.toThrow(/add a GitLab token/);
  server.close();
});

test('lists open Bitbucket pull requests with a bearer token', async () => {
  let seen: http.IncomingMessage | undefined;
  const server = await mock((req, res) => {
    seen = req;
    res.end(JSON.stringify({ values: [{ id: 3, title: 'T', links: { html: { href: 'https://bitbucket.org/ws/app/pull-requests/3' } }, source: { branch: { name: 'feat' }, commit: { hash: 'abc' } }, author: { display_name: 'Bo' }, updated_on: 'now', draft: true }] }));
  });
  const store = new VcsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-')), 'v.json'));
  store.setCredentials('bitbucket', 'bb', undefined);
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => real(String(url).replace('https://api.bitbucket.org', server.url), init)) as typeof fetch;
  try {
    const pulls = await listBitbucketPulls(store, 'ws/app');
    expect(seen?.url).toContain('/2.0/repositories/ws/app/pullrequests');
    expect(seen?.headers.authorization).toBe('Bearer bb');
    expect(pulls[0]).toMatchObject({ number: 3, branch: 'feat', author: 'Bo', draft: true, blockers: ['Draft'] });
  } finally { globalThis.fetch = real; server.close(); }
});

test('detects the provider and repository from remotes', () => {
  expect(detectProvider('git@gitlab.com:grp/sub/app.git')).toBe('gitlab');
  expect(detectProvider('https://bitbucket.org/ws/app.git')).toBe('bitbucket');
  expect(detectProvider('git@github.com:o/r.git')).toBe('github');
  expect(parseRemote('git@gitlab.example.com:grp/sub/app.git')).toEqual({ host: 'gitlab.example.com', slug: 'grp/sub/app' });
  expect(parseRemote('https://user@bitbucket.org/ws/app.git')).toEqual({ host: 'bitbucket.org', slug: 'ws/app' });
});

test('store remembers choices and keeps tokens private (0600)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-')), 'vcs.json');
  const store = new VcsStore(file);
  store.setProvider('p', 'api', 'gitlab');
  store.setCredentials('gitlab', ' secret ', 'https://git.example.com/some/path');
  const again = new VcsStore(file);
  expect(again.providerFor('p', 'api', 'git@github.com:o/r.git')).toBe('gitlab');
  expect(again.token('gitlab')).toBe('secret');
  expect(again.gitlabUrl).toBe('https://git.example.com');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  again.setCredentials('gitlab', null);
  expect(again.hasToken('gitlab')).toBe(false);
});

async function mock(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

test('lists open GitLab merge requests with the saved token', async () => {
  let seen: http.IncomingMessage | undefined;
  const server = await mock((req, res) => {
    seen = req;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ iid: 7, title: 'Fix', web_url: 'http://x/mr/7', source_branch: 'fix', sha: 'abc', author: { username: 'ann' }, updated_at: 'now', draft: false, detailed_merge_status: 'mergeable', head_pipeline: { status: 'success' } }]));
  });
  const store = new VcsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-')), 'v.json'));
  store.setCredentials('gitlab', 'tok', server.url);
  const pulls = await listGitlabPulls(store, '127.0.0.1', 'grp/app');
  server.close();
  expect(seen?.url).toContain('/api/v4/projects/grp%2Fapp/merge_requests');
  expect(seen?.headers['private-token']).toBe('tok');
  expect(pulls[0]).toMatchObject({ number: 7, branch: 'fix', checks: 'passed', ready: true, author: 'ann' });
});

test('rejected tokens produce an actionable error', async () => {
  const server = await mock((_req, res) => { res.statusCode = 401; res.end('{}'); });
  const store = new VcsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-')), 'v.json'));
  store.setCredentials('gitlab', 'bad', server.url);
  await expect(listGitlabPulls(store, '127.0.0.1', 'a/b')).rejects.toThrow(/rejected the token/);
  server.close();
});
