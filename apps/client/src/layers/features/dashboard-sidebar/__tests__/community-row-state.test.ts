/**
 * What a Community's row in the switcher says about it (DOR-2334).
 */
import { describe, expect, it } from 'vitest';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { communityRowState, navigationDescriptor } from '../ui/context/community-row-state';

const none = { read: false, post: false, enrollAgent: false, stream: false };

function withLifecycle(
  lifecycle: 'active' | 'deleted' | 'taken_down' | 'deletion_pending',
  extra: Partial<CommunityConnectionDescriptor> = {}
): CommunityConnectionDescriptor {
  return {
    ref: 'alpha' as CommunityConnectionDescriptor['ref'],
    remoteCommunityId: 'community-id',
    label: 'Alpha',
    pinnedOrigin: 'https://alpha.example.com',
    connectedHumanMemberId: 'member',
    status: 'connected',
    expiresAt: null,
    access: {
      state: 'verified',
      effective: none,
      lastKnown: { lifecycle, capabilities: none, verifiedAt: '2026-09-29T00:00:00.000Z' },
    },
    attention: null,
    ...extra,
  };
}

describe('communityRowState', () => {
  // Purpose: a community its host took down is "taken down" in the navigation, and its row says
  // so. It fails if `taken_down` is passed through unmapped, or the row says anything else.
  it('says a community was taken down', () => {
    expect(navigationDescriptor(withLifecycle('taken_down')).membershipState).toBe('taken-down');
    expect(communityRowState(withLifecycle('taken_down'))).toBe('taken down');
  });

  // Purpose: "seems to be gone" is a guess, so it never overrides what the Community said: a
  // taken-down or deleted community keeps its own words. It fails if the guess wins.
  it('never says "seems to be gone" over a definite answer', () => {
    const since = { seemsGoneSince: '2026-09-01T00:00:00.000Z' };
    expect(communityRowState(withLifecycle('taken_down', since))).toBe('taken down');
    expect(communityRowState(withLifecycle('deleted', since))).toBe('deleted');
    expect(communityRowState(withLifecycle('active', since))).toBe('Seems to be gone');
  });

  it('puts reconnecting first', () => {
    expect(communityRowState(withLifecycle('taken_down', { status: 'reconnect-required' }))).toBe(
      'Reconnect required'
    );
    expect(communityRowState(withLifecycle('deletion_pending'))).toBe('deletion pending');
    expect(communityRowState(withLifecycle('active'))).toBeUndefined();
  });
});
