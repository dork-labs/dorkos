/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { SidebarPrefs, SidebarItemRef } from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS, SidebarGroupSchema } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  pinItem,
  unpinItem,
  unmuteItem,
  setSectionDisplayFilter,
  moveToGroup,
  createGroup,
  convertSmartGroupToManual,
  deleteGroup,
  reorderWithinGroup,
  isSectionCollapsed,
  sectionSortMode,
  sectionDisplayFilter,
  setSectionCollapsed,
  setSectionSortMode,
  setGroupMuted,
  muteItem,
  mutedRoomIds,
  moveTargetGroups,
  roomSectionIds,
} from '../model/use-sidebar-prefs';

/** An agent member reference — every helper below takes one of these now. */
const agent = (path: string): SidebarItemRef => ({ kind: 'agent', path });
/** A room member reference (schema-level only in S1 — nothing renders one yet). */
const room = (roomId: string): SidebarItemRef => ({ kind: 'room', roomId });

function prefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return { ...structuredClone(SIDEBAR_PREFS_DEFAULTS), ...overrides };
}

describe('sidebar prefs pure helpers', () => {
  describe('pinItem / unpinItem', () => {
    it('pinItem appends when absent and is idempotent', () => {
      const p1 = pinItem(prefs(), agent('/a'));
      expect(p1.pinned).toEqual([agent('/a')]);
      const p2 = pinItem(p1, agent('/a'));
      expect(p2).toBe(p1); // no change → same reference
      const p3 = pinItem(p1, agent('/b'));
      expect(p3.pinned).toEqual([agent('/a'), agent('/b')]);
    });

    it('an agent and a room are never the same pin', () => {
      const seeded = prefs({ pinned: [agent('/a')] });
      const withRoom = pinItem(seeded, room('room-1'));
      expect(withRoom.pinned).toEqual([agent('/a'), room('room-1')]);
      // Unpinning the room leaves the agent pin alone, and vice versa.
      expect(unpinItem(withRoom, room('room-1')).pinned).toEqual([agent('/a')]);
      expect(unpinItem(withRoom, agent('/a')).pinned).toEqual([room('room-1')]);
    });

    it('unpinItem removes and is a no-op for unknown items', () => {
      const base = prefs({ pinned: [agent('/a'), agent('/b')] });
      expect(unpinItem(base, agent('/a')).pinned).toEqual([agent('/b')]);
      expect(unpinItem(base, agent('/missing'))).toBe(base);
      expect(unpinItem(base, room('room-1'))).toBe(base);
    });
  });

  describe('moveToGroup disjointness invariant', () => {
    const groups = [
      {
        id: 'A',
        name: 'A',
        items: [agent('/x')],
        sortMode: 'manual' as const,
        kind: 'manual' as const,
        collapsed: false,
        displayFilter: 'all' as const,
        muted: false,
      },
      {
        id: 'B',
        name: 'B',
        items: [],
        sortMode: 'manual' as const,
        kind: 'manual' as const,
        collapsed: false,
        displayFilter: 'all' as const,
        muted: false,
      },
    ];

    it('moving an item already in group A into group B leaves it only in B', () => {
      const next = moveToGroup(prefs({ groups }), agent('/x'), 'B');
      expect(next.groups.find((g) => g.id === 'A')!.items).toEqual([]);
      expect(next.groups.find((g) => g.id === 'B')!.items).toEqual([agent('/x')]);
    });

    it('ungroup (null) removes the item from all groups', () => {
      const next = moveToGroup(prefs({ groups }), agent('/x'), null);
      expect(next.groups.flatMap((g) => g.items)).toEqual([]);
    });
  });

  describe('group CRUD', () => {
    it('createGroup mints an id and appends an expanded manual group', () => {
      const { next, id } = createGroup(prefs(), 'Clients');
      expect(id).toBeTruthy();
      expect(next.groups).toHaveLength(1);
      expect(next.groups[0]).toEqual({
        id,
        name: 'Clients',
        items: [],
        sortMode: 'manual',
        kind: 'manual',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
      });
    });

    it('createGroup mints exactly what the schema defaults to (DOR-2055)', () => {
      // The literal above and `SidebarGroupSchema`'s defaults are two independent statements of
      // the same fact, and until this they were only ever asserted apart.
      const { next, id } = createGroup(prefs(), 'Clients');
      expect(next.groups[0]).toEqual(SidebarGroupSchema.parse({ id, name: 'Clients' }));
    });

    // --- Smart groups (DOR-338) ---

    it('convertSmartGroupToManual materializes the exact current members and drops rules', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'g1',
            name: 'Active now',
            items: [],
            sortMode: 'recent',
            kind: 'smart',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            rules: { statuses: ['active'] },
          },
        ],
      });
      const next = convertSmartGroupToManual(seeded, 'g1', [agent('/x'), agent('/y')]);
      expect(next.groups[0]).toEqual({
        id: 'g1',
        name: 'Active now',
        items: [agent('/x'), agent('/y')],
        sortMode: 'recent',
        kind: 'manual',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
        rules: undefined,
      });
    });

    it('deleteGroup returns members to ungrouped (they vanish from all members lists)', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            items: [agent('/x'), agent('/y')],
            sortMode: 'manual',
            kind: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const next = deleteGroup(seeded, 'A');
      expect(next.groups).toEqual([]);
      // The members are simply no longer in any group's members list.
      expect(next.groups.flatMap((g) => g.items)).toEqual([]);
    });
  });

  describe('reorder bounds handling', () => {
    const seeded = prefs({
      pinned: [agent('/a'), agent('/b'), agent('/c')],
      groups: [
        {
          id: 'A',
          name: 'A',
          items: [agent('/x'), agent('/y')],
          sortMode: 'manual',
          kind: 'manual',
          collapsed: false,
          displayFilter: 'all',
          muted: false,
        },
        {
          id: 'B',
          name: 'B',
          items: [],
          sortMode: 'manual',
          kind: 'manual',
          collapsed: false,
          displayFilter: 'all',
          muted: false,
        },
      ],
    });

    it('reorderWithinGroup reorders members, out-of-range is a no-op', () => {
      expect(reorderWithinGroup(seeded, 'A', 0, 1).groups[0].items).toEqual([
        agent('/y'),
        agent('/x'),
      ]);
      const noop = reorderWithinGroup(seeded, 'A', 0, 9);
      expect(noop.groups[0].items).toEqual([agent('/x'), agent('/y')]);
    });
  });

  describe('per-section state (`sections`)', () => {
    it('a section with nothing stored is open and answers with the caller’s defaults', () => {
      const base = prefs();
      expect(base.sections).toEqual({});
      expect(isSectionCollapsed(base, 'channels')).toBe(false);
      expect(sectionSortMode(base, 'agents', ['name', 'recent'])).toBe('name');
      expect(sectionDisplayFilter(base, 'agents', 'all')).toBe('all');
    });

    it('patching one field of a section keeps the rest of that section', () => {
      const seeded = setSectionSortMode(
        setSectionCollapsed(prefs(), 'agents', true),
        'agents',
        'recent'
      );
      expect(seeded.sections.agents).toEqual({ collapsed: true, sortMode: 'recent' });
    });

    it('each setter writes its own section and leaves the others alone', () => {
      const collapsed = setSectionCollapsed(prefs(), 'channels', true);
      expect(isSectionCollapsed(collapsed, 'channels')).toBe(true);
      expect(isSectionCollapsed(collapsed, 'dms')).toBe(false);

      const sorted = setSectionSortMode(collapsed, 'agents', 'recent');
      expect(sectionSortMode(sorted, 'agents', ['name', 'recent'])).toBe('recent');
      // …and the earlier write survives, because a section is patched, not replaced.
      expect(isSectionCollapsed(sorted, 'channels')).toBe(true);

      const filtered = setSectionDisplayFilter(sorted, 'agents', 'attention');
      expect(sectionDisplayFilter(filtered, 'agents', 'all')).toBe('attention');
      expect(sectionSortMode(filtered, 'agents', ['name', 'recent'])).toBe('recent');
    });
  });

  // --- Display filter + mute (DOR-339) ---

  describe('setGroupMuted — a lens over members, never writes muted[]', () => {
    it('never writes member refs into ui.sidebar.muted (individual state survives group mute/unmute untouched)', () => {
      const seeded = prefs({
        muted: [agent('/y')], // /y is individually muted; /x is not
        groups: [
          {
            id: 'A',
            name: 'A',
            items: [agent('/x'), agent('/y')],
            sortMode: 'manual',
            kind: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const muted = setGroupMuted(seeded, 'A', true);
      expect(muted.muted).toEqual([agent('/y')]); // untouched by the group-mute lens

      const unmuted = setGroupMuted(muted, 'A', false);
      expect(unmuted.muted).toEqual([agent('/y')]); // still untouched — /y's individual mute survives
    });
  });

  describe('muteItem / unmuteItem', () => {
    it('muteItem appends when absent and is idempotent', () => {
      const p1 = muteItem(prefs(), agent('/a'));
      expect(p1.muted).toEqual([agent('/a')]);
      const p2 = muteItem(p1, agent('/a'));
      expect(p2).toBe(p1); // no change → same reference
    });

    it('unmuteItem removes and is a no-op for unknown items', () => {
      const base = prefs({ muted: [agent('/a'), agent('/b')] });
      expect(unmuteItem(base, agent('/a')).muted).toEqual([agent('/b')]);
      expect(unmuteItem(base, agent('/missing'))).toBe(base);
    });
  });
});

// --------------------------------------------------------------------------- Optimistic mutation
// ---------------------------------------------------------------------------

function makeServerConfig(sidebar: SidebarPrefs): ServerConfig {
  return { ui: { sidebar } } as unknown as ServerConfig;
}

function createHarness(transport: Transport) {
  // No gcTime override: the optimistic tests seed the config query and read it back with no
  // active observer, so `gcTime: 0` would garbage-collect the seeded data and make the functional
  // setQueryData a no-op.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('useSidebarPrefs hands the stored section over as it is (DOR-588)', () => {
  // It used to convert the pre-DOR-579 encoding — bare agent paths, `groups[].agentPaths` —
  // behind a `WeakMap` that kept the result stable for the memos downstream.
  function renderPrefs(sidebar: SidebarPrefs) {
    const transport = createMockTransport({});
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig(sidebar));
    return renderHook(() => useSidebarPrefs(), { wrapper });
  }

  it('passes the stored section through by reference', () => {
    const canonical = prefs({ pinned: [agent('/projects/alpha')] });
    const { result } = renderPrefs(canonical);
    expect(result.current).toBe(canonical);
  });
});

describe('useUpdateSidebarPrefs optimistic behavior', () => {
  it('onMutate applies the updater to the config cache and sends the complete section', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig(prefs()));

    const { result } = renderHook(() => useUpdateSidebarPrefs(), { wrapper });

    act(() => {
      result.current.update((p) => pinItem(p, agent('/a')));
    });

    // Cache reflects the optimistic write (onMutate applies it after cancelling
    // in-flight config reads).
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.sidebar.pinned
      ).toEqual([agent('/a')])
    );

    // The COMPLETE ui.sidebar section is sent (array replaced wholesale).
    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
    expect(transport.updateConfig).toHaveBeenCalledWith({
      ui: { sidebar: expect.objectContaining({ pinned: [agent('/a')] }) },
    });
  });

  it('rolls back to the snapshot when the transport write fails', async () => {
    // A deferred promise lets the test hold the write in flight, observe the
    // optimistic state, then reject deterministically (no timing race).
    let rejectWrite!: (err: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const transport = createMockTransport({
      updateConfig: vi.fn().mockReturnValue(pending),
    });
    const { queryClient, wrapper } = createHarness(transport);
    const original = makeServerConfig(prefs({ pinned: [agent('/original')] }));
    queryClient.setQueryData(configKeys.current(), original);

    const { result } = renderHook(() => useUpdateSidebarPrefs(), { wrapper });

    act(() => {
      result.current.update((p) => pinItem(p, agent('/a')));
    });

    // Optimistically added while the write is still in flight...
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.sidebar.pinned
      ).toEqual([agent('/original'), agent('/a')])
    );

    // ...then rolled back to the snapshot on error.
    await act(async () => {
      rejectWrite(new Error('boom'));
      await pending.catch(() => {});
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.sidebar.pinned
      ).toEqual([agent('/original')])
    );
  });
});

/** The one reader both surfaces share. */
describe('mutedRoomIds', () => {
  it('reads only the room members of the muted list', () => {
    expect([...mutedRoomIds([agent('/a'), room('r1'), room('r2')])]).toEqual(['r1', 'r2']);
  });
});

/** The two readers the sidebar's row chrome resolves a room's section with. */
describe('roomSectionIds / moveTargetGroups', () => {
  const section = (
    id: string,
    kind: 'manual' | 'smart',
    items: SidebarItemRef[] = []
  ): SidebarPrefs['groups'][number] =>
    ({
      id,
      name: id.toUpperCase(),
      items,
      sortMode: 'manual' as const,
      kind,
      collapsed: false,
      displayFilter: 'all' as const,
      muted: false,
      ...(kind === 'smart' ? { rules: { statuses: ['active' as const] } } : {}),
    }) as SidebarPrefs['groups'][number];

  it('says which section each room is filed into, and nothing about agents', () => {
    const map = roomSectionIds([
      section('clients', 'manual', [room('r1'), agent('/a')]),
      section('archive', 'manual', [room('r2')]),
    ]);
    expect(map.get('r1')).toBe('clients');
    expect(map.get('r2')).toBe('archive');
    // An agent is filed the same way but is not a room, and reading it here
    // would tick somebody else's section on a room row.
    expect(map.get('/a')).toBeUndefined();
  });

  it('never offers a SMART section as a move target', () => {
    // Red when the filter goes: a room filed into a smart section is counted as grouped and
    // hidden from Channels, while that section draws its rule-derived members instead — so the
    // row vanishes entirely.
    const targets = moveTargetGroups([
      section('clients', 'manual'),
      section('active-now', 'smart'),
    ]);
    expect(targets).toEqual([{ id: 'clients', name: 'CLIENTS' }]);
  });
});
