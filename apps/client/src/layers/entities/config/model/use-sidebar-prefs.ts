/**
 * Sidebar organization state (DOR-329): read + mutate `ui.sidebar` with
 * optimistic writes, plus the pure mutation helpers that shape the next
 * {@link SidebarPrefs} immutably.
 *
 * `PATCH /api/config` deep-merges objects but replaces arrays wholesale, so the
 * mutation always sends the COMPLETE `ui.sidebar` section on every write —
 * writes are deterministic last-write-wins per whole section. Optimistic cache
 * updates make drag-drop, pin toggles, and collapse feel instant.
 *
 * @module entities/config/model/use-sidebar-prefs
 */
import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { SidebarPrefs, SidebarGroup } from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/** Resolve the sidebar prefs from a (possibly-undefined) server config. */
function selectSidebar(config: ServerConfig | undefined): SidebarPrefs {
  return config?.ui?.sidebar ?? SIDEBAR_PREFS_DEFAULTS;
}

/**
 * Read the current sidebar organization prefs (`ui.sidebar`).
 *
 * Selects from the shared {@link useConfig} query. Schema defaults guarantee the
 * section is present once config loads; a stable default is returned while it is
 * still loading.
 */
export function useSidebarPrefs(): SidebarPrefs {
  const { data } = useConfig();
  return selectSidebar(data);
}

/** Public shape of {@link useUpdateSidebarPrefs}. */
export interface UpdateSidebarPrefs {
  /** Apply an immutable updater to the current prefs and persist the whole section. */
  update: (updater: (prev: SidebarPrefs) => SidebarPrefs) => void;
  /** Promise-returning variant of {@link UpdateSidebarPrefs.update}. */
  updateAsync: (updater: (prev: SidebarPrefs) => SidebarPrefs) => Promise<void>;
  /** Whether a write is in flight. */
  isPending: boolean;
  /** Whether the last write failed. */
  isError: boolean;
}

/**
 * Persist sidebar organization changes with an optimistic cache update.
 *
 * The returned `update` takes an immutable updater `(prev) => next`; the next
 * prefs are computed once, written optimistically into the config query
 * (`onMutate` cancels in-flight config reads + snapshots), sent as the COMPLETE
 * `ui.sidebar` via `transport.updateConfig`, rolled back on error, and
 * re-validated by invalidating the config query on settle.
 *
 * Same-tick composition: because every write carries the whole section, two
 * `update()` calls in one tick must not both read the pre-mutation cache (the
 * second PATCH would clobber the first). `resolveNext` therefore composes on a
 * pending "head" — the latest optimistic {@link SidebarPrefs} held in a ref
 * while any mutation is in flight — and clears it once the last in-flight
 * mutation settles, so batched helper applications (e.g. Phase 3 drag gestures)
 * all survive in the final payload.
 */
export function useUpdateSidebarPrefs(): UpdateSidebarPrefs {
  const transport = useTransport();
  const queryClient = useQueryClient();
  /** Latest optimistic prefs while mutations are in flight; null when idle. */
  const pendingHeadRef = useRef<SidebarPrefs | null>(null);
  /** Number of unsettled mutations backing {@link pendingHeadRef}. */
  const inFlightRef = useRef(0);

  const mutation = useMutation<void, Error, SidebarPrefs, { previous: ServerConfig | undefined }>({
    mutationFn: (next) => transport.updateConfig({ ui: { sidebar: next } }),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        // Preserve the whole `ui` section (incl. `ui.shapes`) and only replace
        // `sidebar`. When `ui` is absent from the cache there is nothing to
        // patch optimistically (the settle-time invalidate refetches it), so
        // leave it undefined rather than fabricate a partial `ui`.
        old ? { ...old, ui: old.ui ? { ...old.ui, sidebar: next } : old.ui } : old
      );
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(configKeys.current(), context.previous);
      }
    },
    onSettled: () => {
      inFlightRef.current -= 1;
      if (inFlightRef.current <= 0) {
        // Last in-flight write settled: drop the head so the next update reads
        // the (invalidated, soon-refetched) cache — including after a rollback.
        inFlightRef.current = 0;
        pendingHeadRef.current = null;
      }
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });

  const resolveNext = useCallback(
    (updater: (prev: SidebarPrefs) => SidebarPrefs): SidebarPrefs => {
      const base =
        pendingHeadRef.current ??
        selectSidebar(queryClient.getQueryData<ServerConfig>(configKeys.current()));
      const next = updater(base);
      pendingHeadRef.current = next;
      inFlightRef.current += 1;
      return next;
    },
    [queryClient]
  );

  const update = useCallback(
    (updater: (prev: SidebarPrefs) => SidebarPrefs) => {
      mutation.mutate(resolveNext(updater));
    },
    [mutation, resolveNext]
  );

  const updateAsync = useCallback(
    (updater: (prev: SidebarPrefs) => SidebarPrefs) => mutation.mutateAsync(resolveNext(updater)),
    [mutation, resolveNext]
  );

  return { update, updateAsync, isPending: mutation.isPending, isError: mutation.isError };
}

// ---------------------------------------------------------------------------
// Pure mutation helpers — each takes `prev` and returns the next prefs
// immutably; inputs are never mutated. Exported for direct unit testing and for
// composing into `useUpdateSidebarPrefs().update(...)` callsites.
// ---------------------------------------------------------------------------

/** Move `arr[from]` to index `to`, immutably. Out-of-range indices are a no-op (returns the same array). */
function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to) return arr as T[];
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return arr as T[];
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Append `path` to `pinned` if absent (idempotent). */
export function pinPath(prev: SidebarPrefs, path: string): SidebarPrefs {
  if (prev.pinned.includes(path)) return prev;
  return { ...prev, pinned: [...prev.pinned, path] };
}

/** Remove `path` from `pinned`. */
export function unpinPath(prev: SidebarPrefs, path: string): SidebarPrefs {
  if (!prev.pinned.includes(path)) return prev;
  return { ...prev, pinned: prev.pinned.filter((p) => p !== path) };
}

/**
 * Move `path` into a group (or ungroup it). Removes `path` from EVERY group's
 * `agentPaths` first, then appends it to the target group; `groupId === null`
 * ungroups (removed from all, added to none). Enforces disjointness — a path
 * never appears in two groups.
 *
 * @param prev - Current prefs.
 * @param path - Agent project path to move.
 * @param groupId - Target group id, or `null` to ungroup.
 */
export function moveToGroup(
  prev: SidebarPrefs,
  path: string,
  groupId: string | null
): SidebarPrefs {
  const groups = prev.groups.map((g) => ({
    ...g,
    agentPaths: g.agentPaths.filter((p) => p !== path),
  }));
  if (groupId !== null) {
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx !== -1) {
      groups[idx] = { ...groups[idx]!, agentPaths: [...groups[idx]!.agentPaths, path] };
    }
  }
  return { ...prev, groups };
}

/**
 * Create a new expanded, manually-sorted group with the given name.
 *
 * @param prev - Current prefs.
 * @param name - Display name for the new group.
 * @returns The next prefs plus the newly-minted group `id`.
 */
export function createGroup(prev: SidebarPrefs, name: string): { next: SidebarPrefs; id: string } {
  const id = crypto.randomUUID();
  const group: SidebarGroup = {
    id,
    name,
    agentPaths: [],
    sortMode: 'manual',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
  };
  return { next: { ...prev, groups: [...prev.groups, group] }, id };
}

/** Rename the group with `groupId`. */
export function renameGroup(prev: SidebarPrefs, groupId: string, name: string): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
  };
}

/** Delete the group with `groupId`; its members implicitly return to ungrouped. */
export function deleteGroup(prev: SidebarPrefs, groupId: string): SidebarPrefs {
  return { ...prev, groups: prev.groups.filter((g) => g.id !== groupId) };
}

/** Move a group within the `groups` array (bounds-checked no-op). */
export function reorderGroup(prev: SidebarPrefs, from: number, to: number): SidebarPrefs {
  const groups = moveItem(prev.groups, from, to);
  return groups === prev.groups ? prev : { ...prev, groups };
}

/** Reorder `agentPaths` inside the group with `groupId` (bounds-checked no-op). */
export function reorderWithinGroup(
  prev: SidebarPrefs,
  groupId: string,
  from: number,
  to: number
): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) =>
      g.id === groupId ? { ...g, agentPaths: moveItem(g.agentPaths, from, to) } : g
    ),
  };
}

/** Reorder the `pinned` array (bounds-checked no-op). */
export function reorderPinned(prev: SidebarPrefs, from: number, to: number): SidebarPrefs {
  const pinned = moveItem(prev.pinned, from, to);
  return pinned === prev.pinned ? prev : { ...prev, pinned };
}

/**
 * Set a group's `sortMode`. MUST NOT touch `agentPaths` — switching away from
 * 'manual' never destroys the durable manual order.
 */
export function setGroupSortMode(
  prev: SidebarPrefs,
  groupId: string,
  mode: SidebarGroup['sortMode']
): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) => (g.id === groupId ? { ...g, sortMode: mode } : g)),
  };
}

/** Set a group's collapsed state. */
export function setGroupCollapsed(
  prev: SidebarPrefs,
  groupId: string,
  collapsed: boolean
): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)),
  };
}

/** Set the ungrouped ("Agents") section's collapsed state. */
export function setUngroupedCollapsed(prev: SidebarPrefs, collapsed: boolean): SidebarPrefs {
  return { ...prev, ungroupedCollapsed: collapsed };
}

/** Set the Recent section's collapsed state. */
export function setRecentsCollapsed(prev: SidebarPrefs, collapsed: boolean): SidebarPrefs {
  return { ...prev, recentsCollapsed: collapsed };
}

/** Set the ungrouped ("Agents") section's sort mode (`name` or `recent`). */
export function setUngroupedSortMode(
  prev: SidebarPrefs,
  mode: SidebarPrefs['ungroupedSortMode']
): SidebarPrefs {
  return { ...prev, ungroupedSortMode: mode };
}

/** Mark the one-time "group your agents" hint card as dismissed. */
export function setGroupsHintDismissed(prev: SidebarPrefs, dismissed: boolean): SidebarPrefs {
  return { ...prev, groupsHintDismissed: dismissed };
}

// ---------------------------------------------------------------------------
// Display filter + mute (DOR-339) — additive on the DOR-329 shape above.
// ---------------------------------------------------------------------------

/** Set a group's display filter (All / Active / Needs attention). */
export function setGroupDisplayFilter(
  prev: SidebarPrefs,
  groupId: string,
  filter: SidebarGroup['displayFilter']
): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) => (g.id === groupId ? { ...g, displayFilter: filter } : g)),
  };
}

/**
 * Set a group's muted flag. Group mute is a LENS over its members — it never
 * writes member paths into `muted`, so unmuting the group restores whatever
 * individual mute state each member already had (ideation decision 4).
 */
export function setGroupMuted(prev: SidebarPrefs, groupId: string, muted: boolean): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) => (g.id === groupId ? { ...g, muted } : g)),
  };
}

/** Set the ungrouped ("Agents") section's display filter. */
export function setUngroupedDisplayFilter(
  prev: SidebarPrefs,
  filter: SidebarPrefs['ungroupedDisplayFilter']
): SidebarPrefs {
  return { ...prev, ungroupedDisplayFilter: filter };
}

/** Mute an individual agent path (idempotent). Mute owns ALL signals for the path at once. */
export function mutePath(prev: SidebarPrefs, path: string): SidebarPrefs {
  if (prev.muted.includes(path)) return prev;
  return { ...prev, muted: [...prev.muted, path] };
}

/** Unmute an individual agent path. */
export function unmutePath(prev: SidebarPrefs, path: string): SidebarPrefs {
  if (!prev.muted.includes(path)) return prev;
  return { ...prev, muted: prev.muted.filter((p) => p !== path) };
}
