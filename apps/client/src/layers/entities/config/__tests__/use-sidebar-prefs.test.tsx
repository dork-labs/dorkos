/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { SidebarPrefs, SidebarGroup, SidebarItemRef } from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  pinItem,
  unpinItem,
  moveToGroup,
  createGroup,
  createSmartGroup,
  convertSmartGroupToManual,
  setGroupRules,
  renameGroup,
  deleteGroup,
  reorderGroup,
  reorderWithinGroup,
  reorderPinned,
  setGroupSortMode,
  setGroupCollapsed,
  isSectionCollapsed,
  sectionSortMode,
  sectionDisplayFilter,
  setSectionCollapsed,
  setSectionSortMode,
  setSectionDisplayFilter,
  GROUPS_HINT_SUGGESTION_ID,
  isSuggestionRetired,
  retireSuggestion,
  setGroupDisplayFilter,
  setGroupMuted,
  muteItem,
  unmuteItem,
  mutedRoomIds,
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

    it('pinItem compares by value, not object identity', () => {
      // Two structurally-equal refs built on different code paths must count as
      // the same pin — this is exactly what `sameSidebarItem` exists for, and a
      // stray `includes`/`===` would silently duplicate here.
      const seeded = prefs({ pinned: [{ kind: 'agent', path: '/a' }] });
      expect(pinItem(seeded, { kind: 'agent', path: '/a' })).toBe(seeded);
      expect(unpinItem(seeded, { kind: 'agent', path: '/a' }).pinned).toEqual([]);
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

    it('does not mutate the input', () => {
      const base = prefs({ pinned: [agent('/a')] });
      pinItem(base, agent('/b'));
      expect(base.pinned).toEqual([agent('/a')]);
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

    it('appends to the target group at the end', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            items: [agent('/x')],
            sortMode: 'manual',
            kind: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
          {
            id: 'B',
            name: 'B',
            items: [agent('/y')],
            sortMode: 'manual',
            kind: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const next = moveToGroup(seeded, agent('/x'), 'B');
      expect(next.groups.find((g) => g.id === 'B')!.items).toEqual([agent('/y'), agent('/x')]);
    });

    it('moves a room the same way it moves an agent', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            items: [agent('/x'), room('room-1')],
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
      const next = moveToGroup(seeded, room('room-1'), 'B');
      expect(next.groups.find((g) => g.id === 'A')!.items).toEqual([agent('/x')]);
      expect(next.groups.find((g) => g.id === 'B')!.items).toEqual([room('room-1')]);
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

    // --- Smart groups (DOR-338) ---

    it('createSmartGroup mints an id, forces sortMode "recent", and stores the rules', () => {
      const rules: SidebarGroup['rules'] = { statuses: ['needs-attention', 'active'] };
      const { next, id } = createSmartGroup(prefs(), 'Active now', rules);
      expect(id).toBeTruthy();
      expect(next.groups).toHaveLength(1);
      expect(next.groups[0]).toEqual({
        id,
        name: 'Active now',
        items: [],
        sortMode: 'recent',
        kind: 'smart',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
        rules,
      });
    });

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

    it('convertSmartGroupToManual keeps name/collapse/sort/mute/displayFilter untouched', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'g1',
            name: 'Codex fleet',
            items: [],
            sortMode: 'name',
            kind: 'smart',
            collapsed: true,
            displayFilter: 'attention',
            muted: true,
            rules: { runtimes: ['codex'] },
          },
        ],
      });
      const next = convertSmartGroupToManual(seeded, 'g1', []);
      const g = next.groups[0]!;
      expect(g.name).toBe('Codex fleet');
      expect(g.sortMode).toBe('name');
      expect(g.collapsed).toBe(true);
      expect(g.displayFilter).toBe('attention');
      expect(g.muted).toBe(true);
      expect(g.items).toEqual([]);
    });

    it('setGroupRules replaces a smart group’s rules and is a no-op for a manual group', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'smart1',
            name: 'Active now',
            items: [],
            sortMode: 'recent',
            kind: 'smart',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            rules: { statuses: ['active'] },
          },
          {
            id: 'manual1',
            name: 'Clients',
            items: [agent('/x')],
            sortMode: 'manual',
            kind: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const newRules = { runtimes: ['codex'] };
      const next = setGroupRules(seeded, 'smart1', newRules);
      expect(next.groups[0]!.rules).toEqual(newRules);
      // The manual group is untouched — same reference.
      expect(next.groups[1]).toBe(seeded.groups[1]);

      // No-op against a manual group id.
      const noop = setGroupRules(seeded, 'manual1', newRules);
      expect(noop.groups[1]).toBe(seeded.groups[1]);
    });

    it('renameGroup sets the name', () => {
      const { next, id } = createGroup(prefs(), 'Old');
      expect(renameGroup(next, id, 'New').groups[0].name).toBe('New');
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

    it('reorderPinned moves within range and is a safe no-op out of range', () => {
      expect(reorderPinned(seeded, 0, 2).pinned).toEqual([agent('/b'), agent('/c'), agent('/a')]);
      expect(reorderPinned(seeded, 0, 9)).toBe(seeded);
      expect(reorderPinned(seeded, -1, 0)).toBe(seeded);
    });

    it('reorderGroup moves within range and no-ops out of range', () => {
      expect(reorderGroup(seeded, 0, 1).groups.map((g) => g.id)).toEqual(['B', 'A']);
      expect(reorderGroup(seeded, 0, 5)).toBe(seeded);
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

  describe('setGroupSortMode', () => {
    it('changes sortMode without mutating members', () => {
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
      const next = setGroupSortMode(seeded, 'A', 'recent');
      expect(next.groups[0].sortMode).toBe('recent');
      // The durable manual order is preserved when switching away from manual.
      expect(next.groups[0].items).toEqual([agent('/x'), agent('/y')]);
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

    it('patching one field of a section keeps the rest of that section', () => {
      const seeded = setSectionSortMode(
        setSectionCollapsed(prefs(), 'agents', true),
        'agents',
        'recent'
      );
      expect(seeded.sections.agents).toEqual({ collapsed: true, sortMode: 'recent' });
    });

    it('reads a stored sort the section does not offer as the section’s default', () => {
      // A `manual` left behind on a section that stopped sorting by hand must
      // never reach a menu that has no such item in it.
      const stale = {
        ...prefs(),
        sections: { agents: { collapsed: false, sortMode: 'manual' as const } },
      };
      expect(sectionSortMode(stale, 'agents', ['name', 'recent'])).toBe('name');
    });

    it('never mutates its input', () => {
      const base = prefs();
      setSectionCollapsed(base, 'channels', true);
      expect(base.sections).toEqual({});
    });
  });

  describe('Getting started retirement', () => {
    it('retires a suggestion once and stays retired', () => {
      const once = retireSuggestion(prefs(), GROUPS_HINT_SUGGESTION_ID);
      expect(once.gettingStarted.retired).toEqual([GROUPS_HINT_SUGGESTION_ID]);
      expect(isSuggestionRetired(once, GROUPS_HINT_SUGGESTION_ID)).toBe(true);
      // Idempotent, and the same reference back so a write is not queued twice.
      expect(retireSuggestion(once, GROUPS_HINT_SUGGESTION_ID)).toBe(once);
    });

    it('keeps earlier retirements when a second suggestion is answered', () => {
      const two = retireSuggestion(
        retireSuggestion(prefs(), 'suggestion:ask-dorkbot'),
        GROUPS_HINT_SUGGESTION_ID
      );
      expect(two.gettingStarted.retired).toEqual([
        'suggestion:ask-dorkbot',
        GROUPS_HINT_SUGGESTION_ID,
      ]);
    });
  });

  it('setGroupCollapsed toggles only the targeted group', () => {
    const seeded = prefs({
      groups: [
        {
          id: 'A',
          name: 'A',
          items: [],
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
    const next = setGroupCollapsed(seeded, 'A', true);
    expect(next.groups.find((g) => g.id === 'A')!.collapsed).toBe(true);
    expect(next.groups.find((g) => g.id === 'B')!.collapsed).toBe(false);
  });

  // --- Display filter + mute (DOR-339) ---

  describe('setGroupDisplayFilter', () => {
    it('sets only the targeted group’s filter', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            items: [],
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
      const next = setGroupDisplayFilter(seeded, 'A', 'attention');
      expect(next.groups.find((g) => g.id === 'A')!.displayFilter).toBe('attention');
      expect(next.groups.find((g) => g.id === 'B')!.displayFilter).toBe('all');
    });
  });

  describe('setGroupMuted — a lens over members, never writes muted[]', () => {
    it('sets only the targeted group’s muted flag', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            items: [agent('/x')],
            sortMode: 'manual',
            kind: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
          {
            id: 'B',
            name: 'B',
            items: [agent('/y')],
            sortMode: 'manual',
            kind: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const next = setGroupMuted(seeded, 'A', true);
      expect(next.groups.find((g) => g.id === 'A')!.muted).toBe(true);
      expect(next.groups.find((g) => g.id === 'B')!.muted).toBe(false);
    });

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

    it('muteItem holds an agent and a room independently', () => {
      const withBoth = muteItem(muteItem(prefs(), agent('/a')), room('room-1'));
      expect(withBoth.muted).toEqual([agent('/a'), room('room-1')]);
      expect(unmuteItem(withBoth, room('room-1')).muted).toEqual([agent('/a')]);
    });

    it('unmuteItem removes and is a no-op for unknown items', () => {
      const base = prefs({ muted: [agent('/a'), agent('/b')] });
      expect(unmuteItem(base, agent('/a')).muted).toEqual([agent('/b')]);
      expect(unmuteItem(base, agent('/missing'))).toBe(base);
    });

    it('does not mutate the input', () => {
      const base = prefs({ muted: [agent('/a')] });
      muteItem(base, agent('/b'));
      expect(base.muted).toEqual([agent('/a')]);
    });
  });
});

// ---------------------------------------------------------------------------
// Optimistic mutation
// ---------------------------------------------------------------------------

function makeServerConfig(sidebar: SidebarPrefs): ServerConfig {
  return { ui: { sidebar } } as unknown as ServerConfig;
}

function createHarness(transport: Transport) {
  // No gcTime override: the optimistic tests seed the config query and read it
  // back with no active observer, so `gcTime: 0` would garbage-collect the
  // seeded data and make the functional setQueryData a no-op.
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

describe('useSidebarPrefs reading a config the migration has not touched', () => {
  // `conf` runs a migration only when its key lands in
  // `(storedVersion, projectVersion]`, so a dev tree (version `0.0.0`) runs none
  // at all and the file keeps its pre-DOR-579 encoding. The cockpit still has to
  // show the person's groups.
  const legacySidebar = {
    ...structuredClone(SIDEBAR_PREFS_DEFAULTS),
    pinned: ['/projects/alpha'],
    muted: ['/projects/beta'],
    groups: [
      {
        id: 'g1',
        name: 'Clients',
        agentPaths: ['/projects/alpha'],
        sortMode: 'manual',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
        kind: 'manual',
      },
    ],
  } as unknown as SidebarPrefs;

  function renderPrefs(sidebar: SidebarPrefs) {
    const transport = createMockTransport({});
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig(sidebar));
    return renderHook(() => useSidebarPrefs(), { wrapper });
  }

  it('reads a legacy config back in the canonical encoding', () => {
    const { result } = renderPrefs(legacySidebar);
    expect(result.current.pinned).toEqual([agent('/projects/alpha')]);
    expect(result.current.muted).toEqual([agent('/projects/beta')]);
    expect(result.current.groups[0]!.items).toEqual([agent('/projects/alpha')]);
  });

  it('returns a referentially stable object across re-renders', () => {
    // Every consumer memoizes on `prefs.pinned` / `prefs.groups` identity, so
    // converting into a fresh object per read would invalidate those memos on
    // every render.
    const { result, rerender } = renderPrefs(legacySidebar);
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('passes an already-canonical config straight through', () => {
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

  it('composes two same-tick updates: both survive in the final PATCH payload', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig(prefs()));

    const { result } = renderHook(() => useUpdateSidebarPrefs(), { wrapper });

    // Two synchronous updates in one tick — the second must compose on the
    // first's pending head, not the pre-mutation cache (whole-section writes
    // would otherwise clobber each other).
    act(() => {
      result.current.update((p) => pinItem(p, agent('/a')));
      result.current.update((p) => pinItem(p, agent('/b')));
    });

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(2));
    // The last write carries BOTH pins.
    expect(transport.updateConfig).toHaveBeenLastCalledWith({
      ui: { sidebar: expect.objectContaining({ pinned: [agent('/a'), agent('/b')] }) },
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

/**
 * The one reader both surfaces share.
 *
 * It lives here rather than in the sidebar because "Jump back in" drops muted
 * rooms from a list the sidebar only dims them in, and a second derivation is
 * how one of the two starts offering what the other was told to stop offering.
 */
describe('mutedRoomIds', () => {
  it('reads only the room members of the muted list', () => {
    expect([...mutedRoomIds(prefs({ muted: [agent('/a'), room('r1'), room('r2')] }))]).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('is empty when nothing is muted, and when only agents are', () => {
    expect(mutedRoomIds(prefs()).size).toBe(0);
    expect(mutedRoomIds(prefs({ muted: [agent('/a')] })).size).toBe(0);
  });

  it('answers for what mute wrote, so a muted room is dropped by whoever reads it', () => {
    const muted = muteItem(prefs(), room('r9'));
    expect(mutedRoomIds(muted).has('r9')).toBe(true);
    expect(mutedRoomIds(unmuteItem(muted, room('r9'))).has('r9')).toBe(false);
  });
});
