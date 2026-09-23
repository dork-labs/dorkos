import { describe, expect, it } from 'vitest';
import { CommunityInstallationDestinationSchema } from '../config-schema.js';
import {
  CommunityNavigationDescriptorListSchema,
  CommunityNavigationDescriptorSchema,
  communityNavigationForOwner,
  reconcileCommunityNavigationOwner,
  reconcileCommunityOrder,
  rememberCommunityDestination,
  rememberCommunityInstallationDestination,
  updateCommunityNavigationOwner,
} from '../community-navigation.js';

const EMPTY = { version: 1 as const, owners: [] };

describe('Community navigation preferences', () => {
  const descriptor = {
    kind: 'community' as const,
    key: 'community:community_a',
    ref: 'community_a',
    remoteCommunityId: '00000000-0000-4000-8000-000000000001',
    label: 'Engineering',
    icon: { kind: 'community' as const, ref: 'community_a' },
    pinnedOrigin: 'https://spaces.example.com',
    membershipState: 'active' as const,
    connectionState: 'connected' as const,
    availability: 'online' as const,
    unreadCount: 7,
    mentionCount: 2,
  };

  it('keeps local and remote identity stable without exposing content in descriptors', () => {
    const result = CommunityNavigationDescriptorListSchema.parse({
      installation: {
        kind: 'installation',
        key: 'installation',
        label: 'My DorkOS',
        icon: { kind: 'installation' },
      },
      communities: [
        descriptor,
        {
          ...descriptor,
          key: 'community:community_b',
          ref: 'community_b',
          remoteCommunityId: '00000000-0000-4000-8000-000000000002',
          icon: { kind: 'community', ref: 'community_b' },
        },
      ],
    });

    expect(result.communities.map(({ key }) => key)).toEqual([
      'community:community_a',
      'community:community_b',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/author|channel|message|text/u);
  });

  it('keeps lifecycle, connection, and availability independent', () => {
    expect(
      CommunityNavigationDescriptorSchema.parse({
        ...descriptor,
        membershipState: 'archived',
        connectionState: 'reconnect-required',
        availability: 'offline',
      })
    ).toMatchObject({
      membershipState: 'archived',
      connectionState: 'reconnect-required',
      availability: 'offline',
    });
  });

  it('rejects unqualified identities and mention counts outside unread attention', () => {
    expect(() =>
      CommunityNavigationDescriptorSchema.parse({
        ...descriptor,
        key: 'community:other',
        mentionCount: 8,
      })
    ).toThrow();
    expect(() =>
      CommunityNavigationDescriptorSchema.parse({
        ...descriptor,
        icon: { kind: 'community', ref: 'community_b' },
      })
    ).toThrow();
  });

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

  it('keeps local destinations owner-scoped and rejects Community-qualified search', () => {
    const first = rememberCommunityInstallationDestination(EMPTY, 'owner-a', {
      path: '/tasks',
      search: { view: 'board' },
    });
    const second = rememberCommunityInstallationDestination(first, 'owner-b', {
      path: '/connections',
      search: { tab: 'accounts' },
    });

    expect(communityNavigationForOwner(second, 'owner-a').installationDestination).toEqual({
      path: '/tasks',
      search: { view: 'board' },
    });
    expect(communityNavigationForOwner(second, 'owner-b').installationDestination.path).toBe(
      '/connections'
    );
    expect(
      CommunityInstallationDestinationSchema.safeParse({
        path: '/channels',
        search: { nested: { community: 'remote-a' } },
      }).success
    ).toBe(false);
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
