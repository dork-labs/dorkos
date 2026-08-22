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
import type {
  SidebarPrefs,
  SidebarGroup,
  SidebarItemRef,
  SidebarSectionId,
  SidebarSectionPrefs,
  SidebarDisplayFilter,
} from '@dorkos/shared/config-schema';
import { SIDEBAR_PREFS_DEFAULTS, sameSidebarItem } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/**
 * Resolve the sidebar prefs from a (possibly-undefined) server config.
 *
 * A straight read. It used to convert the pre-DOR-579 encoding on the way past —
 * bare agent paths, `groups[].agentPaths` — behind a `WeakMap` that kept the
 * result referentially stable for the memos downstream. That rename shipped a
 * release ago with its migration, so the conversion and its cache are gone
 * (DOR-588) and the stored object is handed over as it is.
 *
 * @param config - The server config, or `undefined` while it loads.
 */
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

  // **Keyed on `mutate`, never on the mutation result.** TanStack returns a
  // fresh result object on every render but keeps `mutate`/`mutateAsync` stable
  // for the life of the observer, so depending on the whole result gave these
  // two a new identity on every render — and every memo that closes over them,
  // including the sidebar's whole row chrome, rebuilt with them
  // (`specs/sidebar-simplification` D8).
  const { mutate, mutateAsync } = mutation;
  const update = useCallback(
    (updater: (prev: SidebarPrefs) => SidebarPrefs) => {
      mutate(resolveNext(updater));
    },
    [mutate, resolveNext]
  );

  const updateAsync = useCallback(
    (updater: (prev: SidebarPrefs) => SidebarPrefs) => mutateAsync(resolveNext(updater)),
    [mutateAsync, resolveNext]
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

/** Append `ref` to `pinned` if absent (idempotent). */
export function pinItem(prev: SidebarPrefs, ref: SidebarItemRef): SidebarPrefs {
  if (prev.pinned.some((p) => sameSidebarItem(p, ref))) return prev;
  return { ...prev, pinned: [...prev.pinned, ref] };
}

/** Remove `ref` from `pinned`. */
export function unpinItem(prev: SidebarPrefs, ref: SidebarItemRef): SidebarPrefs {
  if (!prev.pinned.some((p) => sameSidebarItem(p, ref))) return prev;
  return { ...prev, pinned: prev.pinned.filter((p) => !sameSidebarItem(p, ref)) };
}

/**
 * Move `ref` into a group (or ungroup it). Removes `ref` from EVERY group's
 * `items` first, then appends it to the target group; `groupId === null`
 * ungroups (removed from all, added to none). Enforces disjointness — an item
 * never appears in two groups.
 *
 * @param prev - Current prefs.
 * @param ref - The item to move.
 * @param groupId - Target group id, or `null` to ungroup.
 */
export function moveToGroup(
  prev: SidebarPrefs,
  ref: SidebarItemRef,
  groupId: string | null
): SidebarPrefs {
  const groups = prev.groups.map((g) => ({
    ...g,
    items: g.items.filter((m) => !sameSidebarItem(m, ref)),
  }));
  if (groupId !== null) {
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx !== -1) {
      groups[idx] = { ...groups[idx]!, items: [...groups[idx]!.items, ref] };
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
    items: [],
    sortMode: 'manual',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
    kind: 'manual',
  };
  return { next: { ...prev, groups: [...prev.groups, group] }, id };
}

/**
 * Create a new expanded smart group (smart-agent-groups, DOR-338) with the
 * given name and rules. `sortMode` is forced to `'recent'` — smart groups
 * reject `'manual'` sort at the schema level (derived membership has no
 * hand-orderable sequence).
 *
 * @param prev - Current prefs.
 * @param name - Display name for the new group.
 * @param rules - The rule set to evaluate membership from (≥1 constraint).
 * @returns The next prefs plus the newly-minted group `id`.
 */
export function createSmartGroup(
  prev: SidebarPrefs,
  name: string,
  rules: SidebarGroup['rules']
): { next: SidebarPrefs; id: string } {
  const id = crypto.randomUUID();
  const group: SidebarGroup = {
    id,
    name,
    items: [],
    sortMode: 'recent',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
    kind: 'smart',
    rules,
  };
  return { next: { ...prev, groups: [...prev.groups, group] }, id };
}

/**
 * Convert a smart group to a manual group, materializing its currently-
 * matching members into `items` (spec §4, ideation decision 5 — the escape
 * hatch). Keeps name/collapse/sort/mute/displayFilter untouched; drops `rules`
 * since a manual group never reads it.
 *
 * @param prev - Current prefs.
 * @param groupId - The smart group to convert.
 * @param currentMembers - The group's currently-matching members (wrapped from
 *   `evaluateSmartGroup`, which stays agent-only), materialized verbatim into
 *   `items`.
 */
export function convertSmartGroupToManual(
  prev: SidebarPrefs,
  groupId: string,
  currentMembers: SidebarItemRef[]
): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) =>
      g.id === groupId ? { ...g, kind: 'manual', rules: undefined, items: [...currentMembers] } : g
    ),
  };
}

/**
 * Replace a smart group's `rules` (the "Edit rules" flow). A no-op for a
 * manual group or an unknown id.
 *
 * @param prev - Current prefs.
 * @param groupId - The smart group to edit.
 * @param rules - The new rule set (≥1 constraint — schema-enforced).
 */
export function setGroupRules(
  prev: SidebarPrefs,
  groupId: string,
  rules: SidebarGroup['rules']
): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) => (g.id === groupId && g.kind === 'smart' ? { ...g, rules } : g)),
  };
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

/** Reorder `items` inside the group with `groupId` (bounds-checked no-op). */
export function reorderWithinGroup(
  prev: SidebarPrefs,
  groupId: string,
  from: number,
  to: number
): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) =>
      g.id === groupId ? { ...g, items: moveItem(g.items, from, to) } : g
    ),
  };
}

/** Reorder the `pinned` array (bounds-checked no-op). */
export function reorderPinned(prev: SidebarPrefs, from: number, to: number): SidebarPrefs {
  const pinned = moveItem(prev.pinned, from, to);
  return pinned === prev.pinned ? prev : { ...prev, pinned };
}

/**
 * Set a group's `sortMode`. MUST NOT touch `items` — switching away from
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

// ---------------------------------------------------------------------------
// Per-section state (`sections`) — one keyed record replaced the seven
// per-section booleans and enums this file used to carry
// (`specs/sidebar-now-today-library` §D). Reads go through the accessors below
// rather than reaching into the record, because "absent" is the common case: a
// section only appears once the person has changed something about it.
// ---------------------------------------------------------------------------

/** Read one section's stored state, or `undefined` when it has none yet. */
function sectionOf(prefs: SidebarPrefs, id: SidebarSectionId): SidebarSectionPrefs | undefined {
  return prefs.sections[id];
}

/** Whether a section is folded shut. A section with no stored state is open. */
export function isSectionCollapsed(prefs: SidebarPrefs, id: SidebarSectionId): boolean {
  return sectionOf(prefs, id)?.collapsed === true;
}

/**
 * A section's sort mode, narrowed to the sorts that section actually offers.
 *
 * The `offered` list belongs to the caller because it is a property of the
 * SECTION, not of the storage: Agents sorts by name or recency and never by
 * hand, a manual group does the opposite. Its first entry is what the section
 * shows when the person has not chosen.
 *
 * A stored value the section does not offer reads as that first entry, which is
 * what keeps a `manual` left behind on a section that stopped sorting by hand
 * from being handed to a menu with no such item in it.
 *
 * @param prefs - Current sidebar prefs.
 * @param id - The section to read.
 * @param offered - The sorts this section offers, default first.
 */
export function sectionSortMode<T extends NonNullable<SidebarSectionPrefs['sortMode']>>(
  prefs: SidebarPrefs,
  id: SidebarSectionId,
  offered: readonly [T, ...T[]]
): T {
  const stored = sectionOf(prefs, id)?.sortMode;
  return stored !== undefined && (offered as readonly string[]).includes(stored)
    ? (stored as T)
    : offered[0];
}

/**
 * A section's display filter, falling back to what the section shows by default.
 *
 * @param prefs - Current sidebar prefs.
 * @param id - The section to read.
 * @param fallback - What the section shows when the person has not chosen.
 */
export function sectionDisplayFilter(
  prefs: SidebarPrefs,
  id: SidebarSectionId,
  fallback: SidebarDisplayFilter
): SidebarDisplayFilter {
  return sectionOf(prefs, id)?.displayFilter ?? fallback;
}

/** Apply an immutable patch to one section's stored state. */
function patchSection(
  prev: SidebarPrefs,
  id: SidebarSectionId,
  patch: Partial<SidebarSectionPrefs>
): SidebarPrefs {
  const current = prev.sections[id] ?? { collapsed: false };
  return { ...prev, sections: { ...prev.sections, [id]: { ...current, ...patch } } };
}

/** Fold or unfold a section. */
export function setSectionCollapsed(
  prev: SidebarPrefs,
  id: SidebarSectionId,
  collapsed: boolean
): SidebarPrefs {
  return patchSection(prev, id, { collapsed });
}

/** Set how a section orders its rows. MUST NOT touch any manual order. */
export function setSectionSortMode(
  prev: SidebarPrefs,
  id: SidebarSectionId,
  sortMode: NonNullable<SidebarSectionPrefs['sortMode']>
): SidebarPrefs {
  return patchSection(prev, id, { sortMode });
}

/** Set which members a section shows (All / Active / Needs attention). */
export function setSectionDisplayFilter(
  prev: SidebarPrefs,
  id: SidebarSectionId,
  displayFilter: SidebarDisplayFilter
): SidebarPrefs {
  return patchSection(prev, id, { displayFilter });
}

// ---------------------------------------------------------------------------
// Getting started + digest
// ---------------------------------------------------------------------------

/**
 * The suggestion id the "group your agents" hint card became when Getting
 * started absorbed it. Anyone who dismissed the card already answered this
 * suggestion, and the conf migration keyed `0.59.0` records that.
 */
export const GROUPS_HINT_SUGGESTION_ID = 'suggestion:groups-hint';

/** Whether this person has finished with a Getting-started suggestion. */
export function isSuggestionRetired(prefs: SidebarPrefs, suggestionId: string): boolean {
  return prefs.gettingStarted.retired.includes(suggestionId);
}

/**
 * Retire a Getting-started suggestion, for good (idempotent).
 *
 * Retirement is one-way on purpose: a suggestion never comes back once it has
 * been answered, even if the condition that raised it becomes true again.
 */
export function retireSuggestion(prev: SidebarPrefs, suggestionId: string): SidebarPrefs {
  if (prev.gettingStarted.retired.includes(suggestionId)) return prev;
  return {
    ...prev,
    gettingStarted: { retired: [...prev.gettingStarted.retired, suggestionId] },
  };
}

/**
 * Record that the welcome-back digest has been shown on a local calendar day
 * (idempotent).
 *
 * **Once per day per ACCOUNT, not per device** (BC-22). That is the whole
 * reason the date lives in server-held config rather than in localStorage: a
 * person who reads the digest on a laptop and then opens the cockpit on a
 * desktop has already had the moment, and a second one is the product
 * repeating itself.
 *
 * @param prev - The prefs to patch.
 * @param date - The local calendar day, `YYYY-MM-DD`.
 */
export function markDigestShown(prev: SidebarPrefs, date: string): SidebarPrefs {
  if (prev.digest.lastShownDate === date) return prev;
  return { ...prev, digest: { lastShownDate: date } };
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
 * writes member references into `muted`, so unmuting the group restores
 * whatever individual mute state each member already had (ideation decision 4).
 */
export function setGroupMuted(prev: SidebarPrefs, groupId: string, muted: boolean): SidebarPrefs {
  return {
    ...prev,
    groups: prev.groups.map((g) => (g.id === groupId ? { ...g, muted } : g)),
  };
}

/** Mute an individual item (idempotent). Mute owns ALL signals for the item at once. */
export function muteItem(prev: SidebarPrefs, ref: SidebarItemRef): SidebarPrefs {
  if (prev.muted.some((m) => sameSidebarItem(m, ref))) return prev;
  return { ...prev, muted: [...prev.muted, ref] };
}

/** Unmute an individual item. */
export function unmuteItem(prev: SidebarPrefs, ref: SidebarItemRef): SidebarPrefs {
  if (!prev.muted.some((m) => sameSidebarItem(m, ref))) return prev;
  return { ...prev, muted: prev.muted.filter((m) => !sameSidebarItem(m, ref)) };
}

/**
 * The rooms the operator has muted individually (`ui.sidebar.muted`).
 *
 * Lives beside the prefs rather than in any one feature because more than one
 * surface has to agree about it: the sidebar dims a muted room's row, and "Jump
 * back in" drops it from both of its lists — mute means "stop pulling me back
 * into this", and a shortcut whose whole job is to pull you back in has no
 * quieter way to honour that. Two readers deriving it separately is how one
 * surface starts offering what the other was told to stop offering.
 *
 * There is no group-mute widening for rooms the way there is for agents: a
 * muted group dims its rows through the section's own filter, and a room row
 * carries no live activity emphasis to suppress on top of that.
 *
 * **Takes the LIST, not the whole prefs.** Every caller memoizes this, and a
 * memo can only be keyed on what the function actually reads: given the whole
 * object, folding a section or renaming one produces a new `prefs` and therefore
 * a new Set, which is a changed prop for everything downstream of it
 * (`specs/sidebar-simplification` D8).
 *
 * @param muted - `ui.sidebar.muted`, the individually-silenced list.
 */
export function mutedRoomIds(muted: readonly SidebarItemRef[]): Set<string> {
  return new Set(muted.flatMap((ref) => (ref.kind === 'room' ? [ref.roomId] : [])));
}

/**
 * The hand-made section each room is filed into, by room id.
 *
 * A room in no section is simply absent. Lives beside the prefs for the reason
 * {@link mutedRoomIds} does: a row's menu ticks the section it is in, and the
 * panel that hands it that answer must be reading the same list the drag layer
 * writes. It takes the list for that function's reason too.
 *
 * @param groups - `ui.sidebar.groups`, the stored sections.
 */
export function roomSectionIds(groups: readonly SidebarGroup[]): Map<string, string> {
  const byRoomId = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) if (item.kind === 'room') byRoomId.set(item.roomId, group.id);
  }
  return byRoomId;
}

/**
 * The sections "Move to section ▸" may offer, in stored order.
 *
 * **Smart sections are left out, and that is a correctness rule rather than a
 * tidiness one.** A smart section's membership comes from rules about agents and
 * it draws those derived members instead of its stored `items` — while
 * `groupedRoomIds` still counts a room filed there as grouped and hides it from
 * Channels. Offering one would file a room somewhere no section draws it: the
 * row would simply vanish. The drag layer refuses the same drop.
 *
 * @param groups - `ui.sidebar.groups`, the stored sections.
 */
export function moveTargetGroups(groups: readonly SidebarGroup[]): { id: string; name: string }[] {
  return groups
    .filter((group) => group.kind !== 'smart')
    .map((group) => ({ id: group.id, name: group.name }));
}
