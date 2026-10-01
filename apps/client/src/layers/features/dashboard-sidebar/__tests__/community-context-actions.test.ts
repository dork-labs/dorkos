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
    onJoin: () => {},
    creationOrigins: [] as string[],
    onCreate: () => {},
    onDeploy: () => {},
    hosting: null,
  };

  it('offers only "Add a space" while this DorkOS is selected', () => {
    const nodes = buildCommunityContextNodes({ ...handlers, selected: null });
    expect(nodes.map((node) => node.id)).toEqual(['add-community']);
    expect(nodes[0]).toMatchObject({ label: 'Add a space' });
  });

  /** The ids of a submenu's rows, or `null` when the node is not one. */
  function ids(node: ReturnType<typeof buildCommunityContextNodes>[number] | undefined) {
    return node?.kind === 'submenu' ? node.items.map((item) => item.id) : null;
  }

  /** The Advanced submenu under "Add a space". */
  function advanced(add: ReturnType<typeof buildCommunityContextNodes>[number] | undefined) {
    const found =
      add?.kind === 'submenu'
        ? add.items.find((item) => item.id === 'add-community-advanced')
        : undefined;
    return found;
  }

  // Purpose: Join is the one way in, and running your own server sits behind
  // Advanced. Fails if Connect and Join come back as two rows, or the self-run
  // path returns to the top level.
  it('offers Join, then Advanced with the self-run path, while unlinked', () => {
    const [add] = buildCommunityContextNodes({ ...handlers, selected: null });
    expect(ids(add)).toEqual([
      'add-community-join',
      'add-community-sep-advanced',
      'add-community-advanced',
    ]);
    expect(add!.kind === 'submenu' && add!.items[0]).toMatchObject({
      label: 'Join a space',
      opensInput: true,
    });
    expect(ids(advanced(add))).toEqual(['add-community-deploy']);
  });

  it('offers creation under Advanced, one row per server the person runs', () => {
    const [one] = buildCommunityContextNodes({
      ...handlers,
      selected: null,
      creationOrigins: ['https://a.example.com'],
    });
    expect(ids(advanced(one))).toEqual(['add-community-create', 'add-community-deploy']);
    const advancedOne = advanced(one);
    const create = advancedOne?.kind === 'submenu' ? advancedOne.items[0] : null;
    expect(create).toMatchObject({
      label: 'Create a space on your server',
      opensInput: true,
      external: { host: 'a.example.com' },
    });
    const [two] = buildCommunityContextNodes({
      ...handlers,
      selected: null,
      creationOrigins: ['https://a.example.com', 'https://b.example.com:8443'],
    });
    const advancedTwo = advanced(two);
    const rows = advancedTwo?.kind === 'submenu' ? advancedTwo.items : [];
    expect(
      rows
        .filter((node) => node.id.startsWith('add-community-create'))
        .map((node) => (node.kind === 'action' ? node.label : null))
    ).toEqual(['Create a space on a.example.com', 'Create a space on b.example.com:8443']);
  });

  // Purpose: the entry points for spaces on DorkOS exist only while linked
  // (spec P5), and Start and Join lead. Fails if an unlinked install draws
  // them, a linked one misses either, or the order buries Start.
  it('leads with Start and Join, then Your spaces, only while linked', () => {
    const linked = { onStart: () => {}, onOpenYourSpaces: () => {} };
    const [add] = buildCommunityContextNodes({ ...handlers, selected: null, hosting: linked });
    expect(ids(add)).toEqual([
      'add-community-start',
      'add-community-join',
      'add-community-yours',
      'add-community-sep-advanced',
      'add-community-advanced',
    ]);
    const labels =
      add!.kind === 'submenu'
        ? add!.items.map((item) => ('label' in item ? item.label : null))
        : [];
    expect(labels).toEqual(['Start a space', 'Join a space', 'Your spaces', null, 'Advanced']);
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
