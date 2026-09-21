import { describe, expect, it } from 'vitest';
import {
  communityNavigationForOwner,
  reconcileCommunityNavigationOwner,
  reconcileCommunityOrder,
  rememberCommunityDestination,
  updateCommunityNavigationOwner,
} from '../community-navigation.js';

const EMPTY = { version: 1 as const, owners: [] };

describe('Community navigation preferences', () => {
  it('keeps manual order, drops removed refs, and appends unknown refs deterministically', () => {
    expect(reconcileCommunityOrder(['c', 'missing', 'a', 'c'], ['b', 'c', 'a'])).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('never returns another owner’s same-named destination', () => {
    const first = rememberCommunityDestination(EMPTY, 'owner-a', {
      ref: 'community_a',
      roomId: 'same-room',
      threadId: 'thread-a',
      scrollAnchorEntryId: 'entry-a',
    });
    const second = rememberCommunityDestination(first, 'owner-b', {
      ref: 'community_b',
      roomId: 'same-room',
      threadId: 'thread-b',
      scrollAnchorEntryId: 'entry-b',
    });

    expect(communityNavigationForOwner(second, 'owner-a').destinations).toEqual([
      expect.objectContaining({ ref: 'community_a', threadId: 'thread-a' }),
    ]);
    expect(communityNavigationForOwner(second, 'owner-b').destinations).toEqual([
      expect.objectContaining({ ref: 'community_b', threadId: 'thread-b' }),
    ]);
    expect(communityNavigationForOwner(second, 'owner-c').destinations).toEqual([]);
  });

  it('updates one owner without losing an unrelated owner write', () => {
    const first = updateCommunityNavigationOwner(EMPTY, 'owner-a', (owner) => ({
      ...owner,
      order: ['community_a'],
    }));
    const second = updateCommunityNavigationOwner(first, 'owner-b', (owner) => ({
      ...owner,
      order: ['community_b'],
    }));

    expect(communityNavigationForOwner(second, 'owner-a').order).toEqual(['community_a']);
    expect(communityNavigationForOwner(second, 'owner-b').order).toEqual(['community_b']);
  });

  it('prunes removed refs and their destinations only after an authoritative refresh', () => {
    const stored = rememberCommunityDestination(
      updateCommunityNavigationOwner(EMPTY, 'owner-a', (owner) => ({
        ...owner,
        order: ['gone', 'kept'],
      })),
      'owner-a',
      { ref: 'gone', roomId: 'private-room', threadId: null, scrollAnchorEntryId: null }
    );
    const reconciled = reconcileCommunityNavigationOwner(stored, 'owner-a', ['new', 'kept']);

    expect(communityNavigationForOwner(reconciled, 'owner-a')).toMatchObject({
      order: ['kept', 'new'],
      destinations: [],
    });
  });
});
