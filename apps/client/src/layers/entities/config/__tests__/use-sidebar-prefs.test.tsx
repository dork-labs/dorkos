/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { SidebarPrefs } from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import {
  useUpdateSidebarPrefs,
  pinPath,
  unpinPath,
  moveToGroup,
  createGroup,
  renameGroup,
  deleteGroup,
  reorderGroup,
  reorderWithinGroup,
  reorderPinned,
  setGroupSortMode,
  setGroupCollapsed,
  setUngroupedCollapsed,
  setRecentsCollapsed,
  setUngroupedSortMode,
  setGroupsHintDismissed,
} from '../model/use-sidebar-prefs';

function prefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return { ...structuredClone(SIDEBAR_PREFS_DEFAULTS), ...overrides };
}

describe('sidebar prefs pure helpers', () => {
  describe('pinPath / unpinPath', () => {
    it('pinPath appends when absent and is idempotent', () => {
      const p1 = pinPath(prefs(), '/a');
      expect(p1.pinned).toEqual(['/a']);
      const p2 = pinPath(p1, '/a');
      expect(p2).toBe(p1); // no change → same reference
      const p3 = pinPath(p1, '/b');
      expect(p3.pinned).toEqual(['/a', '/b']);
    });

    it('unpinPath removes and is a no-op for unknown paths', () => {
      const base = prefs({ pinned: ['/a', '/b'] });
      expect(unpinPath(base, '/a').pinned).toEqual(['/b']);
      expect(unpinPath(base, '/missing')).toBe(base);
    });

    it('does not mutate the input', () => {
      const base = prefs({ pinned: ['/a'] });
      pinPath(base, '/b');
      expect(base.pinned).toEqual(['/a']);
    });
  });

  describe('moveToGroup disjointness invariant', () => {
    const groups = [
      {
        id: 'A',
        name: 'A',
        agentPaths: ['/x'],
        sortMode: 'manual' as const,
        collapsed: false,
        displayFilter: 'all' as const,
        muted: false,
      },
      {
        id: 'B',
        name: 'B',
        agentPaths: [],
        sortMode: 'manual' as const,
        collapsed: false,
        displayFilter: 'all' as const,
        muted: false,
      },
    ];

    it('moving a path already in group A into group B leaves it only in B', () => {
      const next = moveToGroup(prefs({ groups }), '/x', 'B');
      expect(next.groups.find((g) => g.id === 'A')!.agentPaths).toEqual([]);
      expect(next.groups.find((g) => g.id === 'B')!.agentPaths).toEqual(['/x']);
    });

    it('ungroup (null) removes the path from all groups', () => {
      const next = moveToGroup(prefs({ groups }), '/x', null);
      expect(next.groups.every((g) => !g.agentPaths.includes('/x'))).toBe(true);
    });

    it('appends to the target group at the end', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            agentPaths: ['/x'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
          {
            id: 'B',
            name: 'B',
            agentPaths: ['/y'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const next = moveToGroup(seeded, '/x', 'B');
      expect(next.groups.find((g) => g.id === 'B')!.agentPaths).toEqual(['/y', '/x']);
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
        agentPaths: [],
        sortMode: 'manual',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
      });
    });

    it('renameGroup sets the name', () => {
      const { next, id } = createGroup(prefs(), 'Old');
      expect(renameGroup(next, id, 'New').groups[0].name).toBe('New');
    });

    it('deleteGroup returns members to ungrouped (they vanish from all agentPaths)', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            agentPaths: ['/x', '/y'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const next = deleteGroup(seeded, 'A');
      expect(next.groups).toEqual([]);
      // The members are simply no longer in any group's agentPaths.
      expect(next.groups.flatMap((g) => g.agentPaths)).toEqual([]);
    });
  });

  describe('reorder bounds handling', () => {
    const seeded = prefs({
      pinned: ['/a', '/b', '/c'],
      groups: [
        {
          id: 'A',
          name: 'A',
          agentPaths: ['/x', '/y'],
          sortMode: 'manual',
          collapsed: false,
          displayFilter: 'all',
          muted: false,
        },
        {
          id: 'B',
          name: 'B',
          agentPaths: [],
          sortMode: 'manual',
          collapsed: false,
          displayFilter: 'all',
          muted: false,
        },
      ],
    });

    it('reorderPinned moves within range and is a safe no-op out of range', () => {
      expect(reorderPinned(seeded, 0, 2).pinned).toEqual(['/b', '/c', '/a']);
      expect(reorderPinned(seeded, 0, 9)).toBe(seeded);
      expect(reorderPinned(seeded, -1, 0)).toBe(seeded);
    });

    it('reorderGroup moves within range and no-ops out of range', () => {
      expect(reorderGroup(seeded, 0, 1).groups.map((g) => g.id)).toEqual(['B', 'A']);
      expect(reorderGroup(seeded, 0, 5)).toBe(seeded);
    });

    it('reorderWithinGroup reorders agentPaths, out-of-range is a no-op', () => {
      expect(reorderWithinGroup(seeded, 'A', 0, 1).groups[0].agentPaths).toEqual(['/y', '/x']);
      const noop = reorderWithinGroup(seeded, 'A', 0, 9);
      expect(noop.groups[0].agentPaths).toEqual(['/x', '/y']);
    });
  });

  describe('setGroupSortMode', () => {
    it('changes sortMode without mutating agentPaths', () => {
      const seeded = prefs({
        groups: [
          {
            id: 'A',
            name: 'A',
            agentPaths: ['/x', '/y'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
      });
      const next = setGroupSortMode(seeded, 'A', 'recent');
      expect(next.groups[0].sortMode).toBe('recent');
      // The durable manual order is preserved when switching away from manual.
      expect(next.groups[0].agentPaths).toEqual(['/x', '/y']);
    });
  });

  it('section-level setters update only their own field', () => {
    const base = prefs();
    expect(setUngroupedCollapsed(base, true).ungroupedCollapsed).toBe(true);
    expect(setRecentsCollapsed(base, true).recentsCollapsed).toBe(true);
    expect(setUngroupedSortMode(base, 'recent').ungroupedSortMode).toBe('recent');
    expect(setGroupsHintDismissed(base, true).groupsHintDismissed).toBe(true);
    // Inputs are never mutated.
    expect(base.ungroupedCollapsed).toBe(false);
  });

  it('setGroupCollapsed toggles only the targeted group', () => {
    const seeded = prefs({
      groups: [
        {
          id: 'A',
          name: 'A',
          agentPaths: [],
          sortMode: 'manual',
          collapsed: false,
          displayFilter: 'all',
          muted: false,
        },
        {
          id: 'B',
          name: 'B',
          agentPaths: [],
          sortMode: 'manual',
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

describe('useUpdateSidebarPrefs optimistic behavior', () => {
  it('onMutate applies the updater to the config cache and sends the complete section', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig(prefs()));

    const { result } = renderHook(() => useUpdateSidebarPrefs(), { wrapper });

    act(() => {
      result.current.update((p) => pinPath(p, '/a'));
    });

    // Cache reflects the optimistic write (onMutate applies it after cancelling
    // in-flight config reads).
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.sidebar.pinned
      ).toEqual(['/a'])
    );

    // The COMPLETE ui.sidebar section is sent (array replaced wholesale).
    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
    expect(transport.updateConfig).toHaveBeenCalledWith({
      ui: { sidebar: expect.objectContaining({ pinned: ['/a'] }) },
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
      result.current.update((p) => pinPath(p, '/a'));
      result.current.update((p) => pinPath(p, '/b'));
    });

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(2));
    // The last write carries BOTH pins.
    expect(transport.updateConfig).toHaveBeenLastCalledWith({
      ui: { sidebar: expect.objectContaining({ pinned: ['/a', '/b'] }) },
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
    const original = makeServerConfig(prefs({ pinned: ['/original'] }));
    queryClient.setQueryData(configKeys.current(), original);

    const { result } = renderHook(() => useUpdateSidebarPrefs(), { wrapper });

    act(() => {
      result.current.update((p) => pinPath(p, '/a'));
    });

    // Optimistically added while the write is still in flight...
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.sidebar.pinned
      ).toEqual(['/original', '/a'])
    );

    // ...then rolled back to the snapshot on error.
    await act(async () => {
      rejectWrite(new Error('boom'));
      await pending.catch(() => {});
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.sidebar.pinned
      ).toEqual(['/original'])
    );
  });
});
