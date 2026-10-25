import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../desktop/src/lib/client/api';
import { createWorkspaceReviewNavigation, openWorkspaceReview, selectedWorkspaceId } from '../desktop/src/lib/client/workspace-navigation';
import type { Space } from '../desktop/src/lib/types';

afterEach(() => vi.restoreAllMocks());

const space = (id: string): Space => ({
  id,
  name: id,
  targets: [],
  active: null,
  files: {},
  updatedAt: 0,
});

describe('workspace review routing', () => {
  it('creates an explicit destination for unlinked PRs instead of using another workspace’s current space', async () => {
    const current = 'other-workspace-ticket';
    const destinations: string[] = [];
    const create = vi.spyOn(api, 'createSpace').mockImplementation(async () => {
      // Another window can change the global current space before PRs are added.
      return space('new-workspace-review');
    });
    vi.spyOn(api, 'addToSpace').mockImplementation(async (url, id) => {
      destinations.push(id ?? current);
      return { space: space(id ?? current), id: url, file: null };
    });

    const result = await openWorkspaceReview(['https://github.com/local/frontend/pull/1', 'https://github.com/local/backend/pull/2'], 'Selected workspace');

    expect(create).toHaveBeenCalledWith('Selected workspace · Reviews');
    expect(result).toBe('new-workspace-review');
    expect(destinations).toEqual(['new-workspace-review', 'new-workspace-review']);
  });

  it('retains a linked ticket’s explicit space for every PR and for empty ticket spaces', async () => {
    const create = vi.spyOn(api, 'createSpace');
    const add = vi.spyOn(api, 'addToSpace').mockResolvedValue({ space: space('ticket-space'), id: 'pr', file: null });

    expect(await openWorkspaceReview(['https://github.com/local/repo/pull/1'], 'Selected workspace', 'ticket-space')).toBe('ticket-space');
    expect(add).toHaveBeenCalledWith('https://github.com/local/repo/pull/1', 'ticket-space');
    expect(await openWorkspaceReview([], 'Selected workspace', 'empty-ticket-space')).toBe('empty-ticket-space');
    expect(create).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('does not add PRs to the global current space when destination creation fails', async () => {
    vi.spyOn(api, 'createSpace').mockRejectedValue(new Error('Could not create space'));
    const add = vi.spyOn(api, 'addToSpace');

    await expect(openWorkspaceReview(['https://github.com/local/repo/pull/1'], 'Selected workspace')).rejects.toThrow('Could not create space');
    expect(add).not.toHaveBeenCalled();
  });
});

describe('workspace selection transitions', () => {
  const projects = [{ id: 'first' }, { id: 'owner' }];

  it.each(['first', 'missing', ''])('retains the deep-linked owner after completion despite an initial choice of %j', initial => {
    const selected = selectedWorkspaceId(projects, [{ projectId: 'owner', reviewSpaceId: 'review' }], initial, 'review');
    expect(selected).toBe('owner');

    // Status no longer returns reviewSpaceId once the ticket is complete.
    const completed = [{ projectId: 'owner' }];
    expect(selectedWorkspaceId(projects, completed, selected, 'review')).toBe('owner');
    // The embedded review then closes after its own refresh.
    expect(selectedWorkspaceId(projects, completed, selected, null)).toBe('owner');
  });

  it('allows explicit workspace switches and falls back when the selected workspace is removed', () => {
    expect(selectedWorkspaceId(projects, [], 'first', null)).toBe('first');
    expect(selectedWorkspaceId([{ id: 'first' }], [], 'owner', null)).toBe('first');
    expect(selectedWorkspaceId([], [], 'owner', null)).toBe('owner');
  });
});

describe('pending review navigation', () => {
  it.each([undefined, 'ticket-space'])('does not reopen an old review after navigating away and back (ticket space: %j)', async ticketSpace => {
    const navigation = createWorkspaceReviewNavigation();
    vi.spyOn(api, 'createSpace').mockResolvedValue(space('unlinked-space'));
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const add = vi.spyOn(api, 'addToSpace').mockImplementation(async (url, id) => {
      await pending;
      return { space: space(id!), id: url, file: null };
    });
    const request = navigation.open(['https://github.com/local/repo/pull/1'], 'First workspace', ticketSpace);
    // Let unlinked-space creation finish so the add request is in flight.
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));

    // Workspace A -> B -> A still represents a newer navigation intent.
    navigation.invalidate();
    navigation.invalidate();
    finish();

    expect(await request).toBeUndefined();
    expect(add).toHaveBeenCalledWith('https://github.com/local/repo/pull/1', ticketSpace ?? 'unlinked-space');
  });

  it('invalidates navigation while space creation is pending, without losing the saved PR group', async () => {
    const navigation = createWorkspaceReviewNavigation();
    let finish!: (value: Space) => void;
    vi.spyOn(api, 'createSpace').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const add = vi.spyOn(api, 'addToSpace').mockImplementation(async (url, id) => ({ space: space(id!), id: url, file: null }));
    const request = navigation.open(['https://github.com/local/frontend/pull/1', 'https://github.com/local/backend/pull/2'], 'First workspace');

    // A view change or component unmount cancels navigation, not persistence.
    navigation.invalidate();
    finish(space('created-space'));

    expect(await request).toBeUndefined();
    expect(add.mock.calls.map(call => call[1])).toEqual(['created-space', 'created-space']);
  });

  it('allows the latest request to navigate and ignores an older response arriving later', async () => {
    const navigation = createWorkspaceReviewNavigation();
    let finish!: () => void;
    vi.spyOn(api, 'addToSpace').mockImplementation(async (url, id) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { space: space(id!), id: url, file: null };
    });
    const older = navigation.open(['https://github.com/local/repo/pull/1'], 'First workspace', 'older-space');

    expect(await navigation.open([], 'Second workspace', 'latest-space')).toBe('latest-space');
    finish();
    expect(await older).toBeUndefined();
  });
});
