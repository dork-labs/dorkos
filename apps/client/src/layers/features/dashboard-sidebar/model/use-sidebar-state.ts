/**
 * The sidebar's one data-fetching hook — every source the panel is a function
 * of, gathered once and handed to `buildSidebarModel` as a snapshot (spec
 * `sidebar-now-today-library` §A2).
 *
 * **This is the ONLY place in the feature that fetches.** Before it, the same
 * entity hooks were called from eight components, so the net query count was a
 * property of which sections happened to be mounted. Here they are called once,
 * in one order, and everything below renders a value.
 *
 * **Referential stability is the contract, not an optimization** (spec §H).
 * `SessionActivity` churns every couple of seconds per working session, and a
 * new `SidebarState` object rebuilds the whole model. So every field an activity
 * event can touch is put through a shallow-stability guard first: the VALUES are
 * identical across such an event — only the identities move — and the guard is
 * what turns that fact into a memo that holds. An activity event therefore
 * produces no new state object at all.
 *
 * @module features/dashboard-sidebar/model/use-sidebar-state
 */
import { useCallback, useMemo } from 'react';
import { useRouterState, useSearch } from '@tanstack/react-router';
import { useShallow } from 'zustand/shallow';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { listedPageAt, useRenderSlot } from '@/layers/shared/lib';
import { useMenuExtensionPages, useNow } from '@/layers/shared/model';
import {
  disambiguateDisplayNames,
  useExecutionExceptions,
  useResolvedAgents,
} from '@/layers/entities/agent';
import { toSidebarModelPrefs, useSidebarPrefs } from '@/layers/entities/config';
import { useInteractionTimestamps } from '@/layers/entities/interactions';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useRooms } from '@/layers/entities/room';
import {
  RECENT_SESSIONS_WINDOW,
  useAgentAttentionMap,
  useRecentSessions,
  useSessionListStore,
  useSessionRouteContext,
} from '@/layers/entities/session';
import type { SidebarTarget } from './build-sidebar-model';
import { useBootState } from './boot/use-boot-state';
import type { AgentRosterEntry, SidebarAddOnPage, SidebarState } from './sidebar-state';

/**
 * How coarse the model's clock is, in milliseconds.
 *
 * One minute, because the only rule that reads `state.now` is a smart
 * section's "active in the last N days". A finer clock would rebuild the whole
 * tree for an answer that did not change.
 */
export const SIDEBAR_CLOCK_TICK_MS = 60_000;

/**
 * No fleet, as one identity.
 *
 * A shared empty rather than a fresh `[]`, because it is what the roster reads
 * as while its manifests are still in flight and a new array each render would
 * rebuild the whole model on every tick of that wait.
 */
const NO_PATHS: string[] = [];

/**
 * The value a slot was last given, until it is given a different one by the
 * caller's own definition of different.
 *
 * A {@link useRenderSlot} rather than a ref because the guards below are read
 * DURING render — returning a held identity is the entire job — and render is
 * not allowed to read refs.
 *
 * @param value - This render's value.
 * @param isEqual - What counts as the same value.
 */
function useHeldWhileEqual<T>(value: T, isEqual: (a: T, b: T) => boolean): T {
  const slot = useRenderSlot(value);
  const held = slot.read();
  if (held !== value && !isEqual(held, value)) {
    slot.write(value);
    return value;
  }
  return held;
}

/**
 * Whether two flat maps carry the same keys and the same values.
 *
 * Shallow rather than deep on purpose — it must not mask a real change, and the
 * values it is used on here are flat maps of primitives.
 *
 * @param a - The held value.
 * @param b - This render's value.
 */
function shallowEqualRecords(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && bKeys.every((key) => Object.is(a[key], b[key]));
}

/**
 * Whether two arrays carry the same members in the same order.
 *
 * @param a - The held array.
 * @param b - This render's array.
 */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((entry, i) => a[i] === entry);
}

/**
 * The previous value, whenever the new one is shallow-equal to it.
 *
 * The guard the whole memo rests on. An activity event re-runs
 * `useAgentAttentionMap`'s own memo and hands back a structurally identical
 * record with a fresh identity; without this, that identity alone would rebuild
 * the model.
 *
 * @param value - This render's value.
 */
function useShallowStable<T extends Record<string, unknown>>(value: T): T {
  return useHeldWhileEqual(value, shallowEqualRecords);
}

/**
 * The same array, whenever its members are unchanged.
 *
 * The roster's paths feed three queries' cache keys, so a fresh array every
 * render would refetch the fleet on every store tick.
 *
 * @param value - This render's array.
 */
function useStableList(value: string[]): string[] {
  return useHeldWhileEqual(value, sameMembers);
}

/**
 * The router's answer to "what is on screen", as a {@link SidebarTarget}.
 *
 * Read off the URL rather than out of a store, for the reason every other
 * sidebar surface reads it there: identity travels as a search param, and the
 * URL is the one answer every window agrees on.
 *
 * **`/` is deliberately NOT a room target here**, even though it draws #team.
 * Home is not "a room is open" — the highlight on #team's row is handled on its
 * own, next to the row that needs it (`SidebarChrome`'s `homeRoomId`), so the
 * scroll anchor does not move on every visit to the dashboard.
 *
 * **A top item's page is open when you are on it** — Threads on `/threads`, the
 * Directory on `/team` — so its door lights like any other row.
 *
 * **A mini app's page is open when you are on it or anywhere under it**, and it
 * names the one listed page that holds the address ({@link listedPageAt}), so
 * the Add-ons section lights one row.
 *
 * @param roomKindOf - Resolves a room id to its kind, from the room list.
 * @param addOns - The listed mini-app pages, for which one is open.
 */
function useActiveTarget(
  roomKindOf: (roomId: string) => 'channel' | 'dm',
  addOns: readonly SidebarAddOnPage[]
): SidebarTarget | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const addOn = listedPageAt(addOns, pathname);
  const addOnExtensionId = addOn?.extensionId ?? null;
  const addOnPath = addOn?.path ?? null;
  const search = useSearch({ strict: false }) as {
    id?: string;
    dir?: string;
    session?: string;
  };
  const sessionId = pathname === '/session' ? (search.session ?? null) : null;
  // **Where the open chat lives comes from its route context, not the URL.**
  // Links no longer carry `?dir=` (`toSession` strips it), so reading the URL
  // alone left a brand-new chat with no agent, and its agent's row dark
  // (DOR-2845). The route loader records the directory it resolved for every
  // chat it opens.
  const routeContext = useSessionRouteContext(sessionId);
  const cwd = pathname === '/session' ? (routeContext?.cwd ?? search.dir ?? null) : null;
  const roomId = pathname === '/channels' ? (search.id ?? null) : null;
  const roomKind = roomId === null ? null : roomKindOf(roomId);
  return useMemo(() => {
    if (sessionId !== null) return { kind: 'session', sessionId, agentPath: cwd ?? '', cwd };
    if (pathname === '/threads') return { kind: 'command', commandId: 'open-threads' };
    if (pathname === '/team') return { kind: 'command', commandId: 'open-directory' };
    if (addOnExtensionId !== null && addOnPath !== null) {
      return { kind: 'add-on', extensionId: addOnExtensionId, path: addOnPath };
    }
    if (roomId === null || roomKind === null) return null;
    return { kind: 'room', roomId, roomKind };
  }, [sessionId, cwd, pathname, addOnExtensionId, addOnPath, roomId, roomKind]);
}

/**
 * Everything the sidebar is a function of, as one memoized snapshot.
 */
export function useSidebarState(): SidebarState {
  const now = useNow(SIDEBAR_CLOCK_TICK_MS);
  // Where this mount is in its first paint — the fleet is withheld until its
  // manifests are in (see `fleetKnown` below).
  const boot = useBootState();

  // ── Sessions, for whose each live one is ──
  // Lifecycle ONLY, never `activity` — the standing rule the whole design rests
  // on. `useShallow` is what makes that true in practice as well as in type: the
  // status objects in the store carry the verb, so selecting them raw would put
  // a new identity in front of the memo on every tool call.
  const recentQuery = useRecentSessions(RECENT_SESSIONS_WINDOW);
  const sessions = useMemo(() => recentQuery.data?.sessions ?? [], [recentQuery.data]);
  const sessionStatuses = useSessionListStore(
    useShallow((s): Record<string, SessionLifecycle> => {
      const out: Record<string, SessionLifecycle> = {};
      for (const [id, status] of Object.entries(s.statuses)) out[id] = status.lifecycle;
      return out;
    })
  );
  const workingSessionIds = useMemo(
    () =>
      Object.entries(sessionStatuses)
        .filter(([, lifecycle]) => lifecycle === 'streaming')
        .map(([id]) => id),
    [sessionStatuses]
  );
  const blockedSessionIds = useMemo(
    () =>
      Object.entries(sessionStatuses)
        .filter(([, lifecycle]) => lifecycle === 'blocked')
        .map(([id]) => id),
    [sessionStatuses]
  );
  // Whose each of those is, from the same event that made it live — the REST
  // window above is up to thirty seconds behind, and a folded section that
  // waited for it lost the working signal for exactly that long (BC-31,
  // DOR-1137). A plain selector is stable here: immer replaces `statusCwds`
  // only when it changes, which is the same read `useAgentAttentionMap` makes.
  const liveSessionCwds = useSessionListStore(useCallback((s) => s.statusCwds, []));

  // ── Rooms ──
  //
  // **Direct messages wait for the fleet** (DOR-1143). A DM's face is its
  // agent participants' faces, and an agent's DM is drawn as the agent's own
  // row — so on a boot that opened on the 1500 ms ceiling with manifests still
  // in flight, a DM row would paint with the room's own letter and grow faces a
  // moment later. Channels have no such dependency and paint immediately.
  const roomsQuery = useRooms();
  const rooms = useMemo(() => {
    const all = roomsQuery.data ?? [];
    if (boot.fleetKnown) return all;
    return all.filter((room) => room.kind !== 'dm');
  }, [roomsQuery.data, boot.fleetKnown]);
  // **@mentions come from the room list itself** (BC-40). The server counts
  // them from the log above the reader's own cursor (`RoomSummary.mentionCount`),
  // so this is a projection, never a second count. A room the server sent no
  // count for has no entry: omission, never a guess. Built from every room
  // rather than the fleet-gated list above, because a mention is not a face.
  // Held while equal, so a list refetch that moved no count rebuilds nothing.
  const mentions = useShallowStable(
    useMemo(() => {
      const counts: Record<string, number> = {};
      for (const room of roomsQuery.data ?? []) {
        const count = room.mentionCount ?? 0;
        if (count > 0) counts[room.id] = count;
      }
      return counts;
    }, [roomsQuery.data])
  );

  // ── When the operator opened each agent, which its attention reads ──
  // An agent you opened this week is not dormant, whatever it ran. Re-keyed by
  // path, parsed once, and held while equal: a fresh object each render would
  // defeat `useAgentAttentionMap`'s memo on every store tick.
  const interactions = useInteractionTimestamps();
  const agentInteractionAt = useShallowStable(
    useMemo(() => {
      const opened: Record<string, number> = {};
      for (const [key, iso] of Object.entries(interactions)) {
        if (!key.startsWith('agent:')) continue;
        const at = Date.parse(iso);
        if (!Number.isNaN(at)) opened[key.slice('agent:'.length)] = at;
      }
      return opened;
    }, [interactions])
  );

  // ── The fleet ──
  const meshQuery = useMeshAgentPaths();
  const meshData = meshQuery.data;
  const rawPaths = useStableList(
    useMemo(() => (meshData?.agents ?? []).map((entry) => entry.projectPath), [meshData])
  );
  const manifestsQuery = useResolvedAgents(rawPaths);
  const manifests = manifestsQuery.data;
  const { brokenPaths } = useExecutionExceptions();
  const attentionMap = useShallowStable(
    useAgentAttentionMap(rawPaths, brokenPaths, agentInteractionAt)
  );
  const agentActivity = useMemo(() => recentQuery.data?.agentActivity ?? {}, [recentQuery.data]);
  // **The fleet is empty until its manifests are in** (DOR-1143), and that is a
  // withholding rather than a degradation. A manifest that has not answered
  // means an agent row would hash the DIRECTORY for its face and fall back to
  // the path for its name, and both change the moment the manifest lands —
  // thirty rows flipping at once, which is the defect D6 exists to remove. So
  // on a boot that opened on the ceiling with manifests still in flight, the
  // agent rows are simply not drawn, and they appear once, correct, when the
  // manifests answer.
  const paths = boot.fleetKnown ? rawPaths : NO_PATHS;
  const agents = useMemo<readonly AgentRosterEntry[]>(
    () =>
      paths.map((path) => {
        const manifest = manifests?.[path] ?? null;
        const activityIso = agentActivity[path];
        const lastActivityAt = activityIso === undefined ? NaN : Date.parse(activityIso);
        return {
          path,
          runtime: manifest?.runtime ?? 'claude-code',
          namespace: manifest?.namespace ?? null,
          isSystem: manifest?.isSystem ?? false,
          lastActivityAt: Number.isNaN(lastActivityAt) ? null : lastActivityAt,
          attention: attentionMap[path] ?? 'inactive',
        };
      }),
    [paths, manifests, agentActivity, attentionMap]
  );
  const displayNames = useMemo(
    () => disambiguateDisplayNames(paths, manifests ?? {}),
    [paths, manifests]
  );

  // ── Preferences ──
  const storedPrefs = useSidebarPrefs();
  const prefs = useMemo(() => toSidebarModelPrefs(storedPrefs), [storedPrefs]);

  const roomKinds = useMemo(() => {
    const map = new Map<string, 'channel' | 'dm'>();
    for (const room of rooms) map.set(room.id, room.kind === 'dm' ? 'dm' : 'channel');
    return map;
  }, [rooms]);
  const roomKindOf = useMemo(
    () => (roomId: string) => roomKinds.get(roomId) ?? ('channel' as const),
    [roomKinds]
  );
  // ── The pages mini apps added (spec `mini-app-placement` Part 2) ──
  // The registry's menu list — listed pages only, by title — narrowed to what
  // the model may hold. It changes only when an extension registers or drops a
  // page, so this memo holds across everything else.
  const menuPages = useMenuExtensionPages();
  const addOns = useMemo<SidebarAddOnPage[]>(
    () => menuPages.map(({ id, extensionId, path, title }) => ({ id, extensionId, path, title })),
    [menuPages]
  );
  const activeTarget = useActiveTarget(roomKindOf, addOns);

  return useMemo(
    () => ({
      now,
      sessions,
      workingSessionIds,
      blockedSessionIds,
      liveSessionCwds,
      rooms,
      agents,
      displayNames,
      prefs,
      mentions,
      addOns,
      activeTarget,
    }),
    [
      now,
      sessions,
      workingSessionIds,
      blockedSessionIds,
      liveSessionCwds,
      rooms,
      agents,
      displayNames,
      prefs,
      mentions,
      addOns,
      activeTarget,
    ]
  );
}
