import { describe, expect, it } from 'vitest';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  buildCommunityContextNodes,
  communityActionAvailability,
} from '../ui/context/community-context-actions';

const all = { read: true, post: true, enrollAgent: true, stream: true };
const none = { read: false, post: false, enrollAgent: false, stream: false };

function descriptor(
  status: CommunityConnectionDescriptor['status'],
  state: 'verified' | 'unverified' | 'reconnect-required' | null,
  lifecycle: 'active' | 'archived' | 'suspended' | 'deletion_pending' = 'active'
): CommunityConnectionDescriptor {
  return {
    ref: 'a',
    remoteCommunityId: 'remote-a',
    label: 'Alpha',
    pinnedOrigin: 'https://a.example.com',
    connectedHumanMemberId: 'person-a',
    status,
    expiresAt: null,
    access:
      state === null
        ? null
        : {
            state,
            effective: state === 'verified' ? all : none,
            lastKnown: { lifecycle, capabilities: all, verifiedAt: '2026-09-21T00:00:00.000Z' },
          },
    attention: null,
  } as CommunityConnectionDescriptor;
}

describe('communityActionAvailability', () => {
  it.each([
    // status, access, lifecycle → invite, settings, leave
    ['connected', 'verified', 'active', true, true, true],
    ['connected', 'verified', 'archived', false, true, true],
    ['connected', 'verified', 'suspended', false, true, true],
    ['connected', 'verified', 'deletion_pending', false, true, true],
    ['connected', 'unverified', 'active', false, false, false],
    ['reconnect-required', 'reconnect-required', 'active', false, true, false],
    ['pending', null, 'active', false, false, false],
  ] as const)(
    '%s / %s / %s → invite %s, settings %s, leave %s',
    (status, state, lifecycle, invite, settings, leave) => {
      const allowed = communityActionAvailability(descriptor(status, state, lifecycle));
      expect([allowed.canInvite, allowed.canOpenSettings, allowed.canLeave]).toEqual([
        invite,
        settings,
        leave,
      ]);
    }
  );
});

describe('buildCommunityContextNodes', () => {
  const handlers = {
    onMove: () => {},
    onInvite: () => {},
    onOpenSettings: () => {},
    onLeave: () => {},
    onDisconnect: () => {},
    onConnect: () => {},
    onJoin: () => {},
    onDeploy: () => {},
  };

  it('offers only "Add community" while this DorkOS is selected', () => {
    const nodes = buildCommunityContextNodes({ ...handlers, selected: null });
    expect(nodes.map((node) => node.id)).toEqual(['add-community']);
  });

  it('keeps pairing, joining and running a server as three separate paths', () => {
    const [add] = buildCommunityContextNodes({ ...handlers, selected: null });
    expect(add!.kind === 'submenu' && add!.items.map((node) => node.id)).toEqual([
      'add-community-connect',
      'add-community-join',
      'add-community-deploy',
    ]);
  });

  it('puts the selected Community’s actions first, with only the local disconnect drawn as destructive', () => {
    const connection = descriptor('connected', 'verified');
    const [manage] = buildCommunityContextNodes({
      ...handlers,
      selected: {
        connection,
        availability: communityActionAvailability(connection),
        canMoveUp: false,
        canMoveDown: true,
      },
    });
    expect(manage!.kind).toBe('submenu');
    if (manage!.kind !== 'submenu') return;
    expect(manage.label).toBe('Manage Alpha');
    expect(manage.items.map((node) => node.id)).toEqual([
      'community-invite',
      'community-settings',
      'community-move-down',
      'community-sep-end',
      'community-disconnect',
      'community-leave',
    ]);
    const destructive = manage.items.filter((node) => node.kind === 'action' && node.destructive);
    // Leaving opens the Community's own confirming page, so it is not drawn as
    // an immediate destructive act here.
    expect(destructive.map((node) => node.id)).toEqual(['community-disconnect']);
    const external = manage.items.filter((node) => node.kind === 'action' && node.external);
    expect(external.map((node) => node.id)).toEqual([
      'community-invite',
      'community-settings',
      'community-leave',
    ]);
  });
});
