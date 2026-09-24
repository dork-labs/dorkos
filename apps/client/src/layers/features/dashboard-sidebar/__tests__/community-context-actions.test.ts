import { describe, expect, it } from 'vitest';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  buildCommunityContextNodes,
  communityActionAvailability,
  communityCreationOrigins,
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
    creationOrigins: [] as string[],
    onCreate: () => {},
    onDeploy: () => {},
    hosting: null,
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

  it('offers creation between joining and running a server, one row per host', () => {
    const [one] = buildCommunityContextNodes({
      ...handlers,
      selected: null,
      creationOrigins: ['https://a.example.com'],
    });
    expect(one!.kind === 'submenu' && one!.items.map((node) => node.id)).toEqual([
      'add-community-connect',
      'add-community-join',
      'add-community-create',
      'add-community-deploy',
    ]);
    const create = one!.kind === 'submenu' ? one!.items[2]! : null;
    expect(create).toMatchObject({
      label: 'Create a community',
      opensInput: true,
      external: { host: 'a.example.com' },
    });
    const [two] = buildCommunityContextNodes({
      ...handlers,
      selected: null,
      creationOrigins: ['https://a.example.com', 'https://b.example.com:8443'],
    });
    expect(
      two!.kind === 'submenu' &&
        two!.items
          .filter((node) => node.id.startsWith('add-community-create'))
          .map((node) => (node.kind === 'action' ? node.label : null))
    ).toEqual(['Create a community on a.example.com', 'Create a community on b.example.com:8443']);
  });

  // Purpose: the hosted entry points exist only while linked (spec P5). Fails
  // if an unlinked install draws them, or a linked one misses either.
  it('adds Start and Move beside the other paths only while linked', () => {
    const linked = {
      onStart: () => {},
      onMove: () => {},
      onOpenHosted: null,
    };
    const [add] = buildCommunityContextNodes({ ...handlers, selected: null, hosting: linked });
    expect(add!.kind === 'submenu' && add!.items.map((node) => node.id)).toEqual([
      'add-community-connect',
      'add-community-join',
      'add-community-start',
      'add-community-move',
      'add-community-deploy',
    ]);
    const [withList] = buildCommunityContextNodes({
      ...handlers,
      selected: null,
      hosting: { ...linked, onOpenHosted: () => {} },
    });
    expect(withList!.kind === 'submenu' && withList!.items.map((node) => node.id)).toContain(
      'add-community-hosted'
    );
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

describe('communityCreationOrigins', () => {
  const at = (
    origin: string,
    hostOperator: boolean | undefined
  ): CommunityConnectionDescriptor => ({
    ...descriptor('connected', 'verified'),
    pinnedOrigin: origin,
    ...(hostOperator === undefined ? {} : { hostOperator }),
  });

  it('keeps each host the person runs once, in switcher order, and nothing else', () => {
    expect(
      communityCreationOrigins([
        at('https://b.example.com', true),
        at('https://a.example.com', undefined),
        at('https://c.example.com', false),
        at('https://b.example.com', true),
        at('https://a.example.com', true),
      ])
    ).toEqual(['https://b.example.com', 'https://a.example.com']);
    expect(communityCreationOrigins([])).toEqual([]);
  });
});
