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
import { useMemo, useRef } from 'react';
import { useRouterState, useSearch } from '@tanstack/react-router';
import { useShallow } from 'zustand/shallow';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { useNow } from '@/layers/shared/model';
import {
  disambiguateDisplayNames,
  useExecutionExceptions,
  useResolvedAgents,
} from '@/layers/entities/agent';
import { useAttentionSignals } from '@/layers/entities/attention';
import { mutedRoomIds, toSidebarModelPrefs, useSidebarPrefs } from '@/layers/entities/config';
import { useInteractionTimestamps } from '@/layers/entities/interactions';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useJumpBackIn } from '@/layers/entities/recents';
import { useRooms, useThreads } from '@/layers/entities/room';
import {
  useAgentAttentionMap,
  useRecentSessions,
  useSessionListStore,
} from '@/layers/entities/session';
import type { SidebarTarget } from './build-sidebar-model';
import { useDigestFacts } from './use-digest-facts';
import { useGettingStartedRetirement } from './use-getting-started-retirement';
import { useJourneyFacts } from './use-journey-facts';
import { useTodayRevealStore } from './today-reveal-store';
import type { AgentRosterEntry, SidebarModelPrefs, SidebarState } from './sidebar-state';

/**
 * How coarse the model's clock is, in milliseconds.
 *
 * One minute, because the only two rules that read `state.now` are the 04:00
 * overnight boundary (BC-18) and the once-a-day digest (BC-22). A finer clock
 * would rebuild the whole tree for an answer that did not change.
 */
export const SIDEBAR_CLOCK_TICK_MS = 60_000;

/**
 * The previous value, whenever the new one is shallow-equal to it.
 *
 * The guard the whole memo rests on. An activity event re-runs
 * `useAgentAttentionMap`'s own memo and hands back a structurally identical
 * record with a fresh identity; without this, that identity alone would rebuild
 * the model. Shallow rather than deep on purpose — it must not mask a real
 * change, and the values it is used on here are flat maps of primitives.
 *
 * @param value - This render's value.
 */
function useShallowStable<T extends Record<string, unknown>>(value: T): T {
  const held = useRef(value);
  const previous = held.current;
  if (previous !== value) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(value);
    const equal =
      previousKeys.length === nextKeys.length &&
      nextKeys.every((key) => Object.is(previous[key], value[key]));
    if (!equal) held.current = value;
  }
  return held.current;
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
  const held = useRef(value);
  const previous = held.current;
  if (
    previous !== value &&
    (previous.length !== value.length || value.some((entry, i) => previous[i] !== entry))
  ) {
    held.current = value;
  }
  return held.current;
}

/**
 * The router's answer to "what is on screen", as a {@link SidebarTarget}.
 *
 * Read off the URL rather than out of a store, for the reason every other
 * sidebar surface reads it there: identity travels as a search param, and the
 * URL is the one answer every window agrees on.
 *
 * @param roomKindOf - Resolves a room id to its kind, from the room list.
 */
function useActiveTarget(
  roomKindOf: (roomId: string) => 'channel' | 'dm' | 'thread'
): SidebarTarget | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useSearch({ strict: false }) as {
    id?: string;
    dir?: string;
    session?: string;
    thread?: string;
  };
  const sessionId = pathname === '/session' ? (search.session ?? null) : null;
  const cwd = pathname === '/session' ? (search.dir ?? null) : null;
  const roomId = pathname === '/channels' ? (search.id ?? null) : null;
  // **`?thread=` is part of what is open, not decoration.** A thread row now
  // navigates to it, so a reader that ignored it would answer "the room" for a
  // click on the thread — and the anchor, the active tint and the scroll would
  // all land on a different row from the one pressed. `?thread=` is the ROOT
  // ENTRY a thread hangs off, which is also what keys the row (`rowKey`).
  const rootEntryId = pathname === '/channels' ? (search.thread ?? null) : null;
  const roomKind = roomId === null ? null : roomKindOf(roomId);
  return useMemo(() => {
    if (sessionId !== null) return { kind: 'session', sessionId, agentPath: cwd ?? '', cwd };
    if (roomId === null || roomKind === null) return null;
    if (rootEntryId !== null) {
      return { kind: 'room', roomId, roomKind: 'thread', rootEntryId };
    }
    return { kind: 'room', roomId, roomKind };
  }, [sessionId, cwd, roomId, roomKind, rootEntryId]);
}

/**
 * Everything the sidebar is a function of, as one memoized snapshot.
 *
 * One field is still waiting for a source and says so where it is filled:
 * `userLastMessageAt`, the server half of Today's order key, which no route
 * carries yet. Its absence is the specified behaviour rather than a gap — the
 * operator's own interaction record governs alone (BC-16).
 */
export function useSidebarState(): SidebarState {
  const now = useNow(SIDEBAR_CLOCK_TICK_MS);

  // ── Sessions and their coarse lifecycle ──
  // Lifecycle ONLY, never `activity` — the standing rule the whole design rests
  // on. `useShallow` is what makes that true in practice as well as in type: the
  // status objects in the store carry the verb, so selecting them raw would put
  // a new identity in front of the memo on every tool call.
  const recentQuery = useRecentSessions();
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

  // ── Rooms and threads ──
  const roomsQuery = useRooms();
  const rooms = useMemo(() => roomsQuery.data ?? [], [roomsQuery.data]);
  const threadsQuery = useThreads();
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);

  // ── The fleet ──
  const meshQuery = useMeshAgentPaths();
  const meshData = meshQuery.data;
  const rawPaths = useStableList(
    useMemo(() => (meshData?.agents ?? []).map((entry) => entry.projectPath), [meshData])
  );
  const manifestsQuery = useResolvedAgents(rawPaths);
  const manifests = manifestsQuery.data;
  const { brokenPaths } = useExecutionExceptions();
  const attentionMap = useShallowStable(useAgentAttentionMap(rawPaths, brokenPaths));
  const agentActivity = useMemo(() => recentQuery.data?.agentActivity ?? {}, [recentQuery.data]);
  const agents = useMemo<readonly AgentRosterEntry[]>(
    () =>
      rawPaths.map((path) => {
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
    [rawPaths, manifests, agentActivity, attentionMap]
  );
  const displayNames = useMemo(
    () => disambiguateDisplayNames(rawPaths, manifests ?? {}),
    [rawPaths, manifests]
  );

  // ── What the operator opened, and when ──
  // Read before prefs because the digest is a function of it (BC-22), and the
  // digest is what the prefs handed to the model are adjusted for.
  const interactions = useInteractionTimestamps();

  // ── Preferences, and the recents list they filter ──
  const storedPrefs = useSidebarPrefs();
  const storedModelPrefs = useMemo(() => toSidebarModelPrefs(storedPrefs), [storedPrefs]);
  const digestFacts = useDigestFacts({
    now,
    sessions,
    workingSessionIds,
    interactions,
    storedLastShownDate: storedModelPrefs.digest.lastShownDate,
  });
  // **The one field of prefs the model does not read live.** Everything else
  // here is the stored value; `digest.lastShownDate` is the value this tab
  // loaded with, because writing it is what makes the row appear at most once a
  // day and reading the write back is what would make it vanish on sight. See
  // {@link DigestFacts.lastShownDate}.
  const prefs = useMemo<SidebarModelPrefs>(
    () => ({ ...storedModelPrefs, digest: { lastShownDate: digestFacts.lastShownDate } }),
    [storedModelPrefs, digestFacts.lastShownDate]
  );
  const mutedRooms = useMemo(() => mutedRoomIds(storedPrefs), [storedPrefs]);
  const jumpBackIn = useJumpBackIn({ mutedRoomIds: mutedRooms });
  // Today derives its OWN membership and order (BC-15, BC-16). What it takes
  // from here is the one-line summary each row already computed, so the sentence
  // under a row is derived once in the product rather than twice.
  const recents = useMemo(
    () => ({ items: jumpBackIn.items, automated: jumpBackIn.automated }),
    [jumpBackIn.items, jumpBackIn.automated]
  );

  const roomKinds = useMemo(() => {
    const map = new Map<string, 'channel' | 'dm'>();
    for (const room of rooms) map.set(room.id, room.kind === 'dm' ? 'dm' : 'channel');
    return map;
  }, [rooms]);
  const roomKindOf = useMemo(
    () => (roomId: string) => roomKinds.get(roomId) ?? ('channel' as const),
    [roomKinds]
  );
  const activeTarget = useActiveTarget(roomKindOf);

  // ── Whether Today's automated runs are unfolded (BC-19) ──
  const todayAutomatedExpanded = useTodayRevealStore((s) => s.automatedExpanded);

  // ── What needs the operator (BC-5) ──
  // The only source Now draws from, normalized once in `entities/attention` so
  // the home surface's triage header and this panel read the same list.
  const attention = useAttentionSignals();

  // ── How far along this operator is (BC-12) ──
  // `rosterResolved` is what keeps the loading placeholder out of permanent
  // retirement: a roster query that has not answered looks exactly like an
  // empty fleet, and Getting started's whole first suggestion turns on that.
  // An empty roster is `isSuccess` with no paths, in which case there are no
  // manifests to wait for and the manifests query stays disabled forever.
  const journey = useJourneyFacts({
    agents,
    agentActivity,
    sessionCount: sessions.length,
    rosterResolved:
      meshQuery.isSuccess &&
      recentQuery.isSuccess &&
      (rawPaths.length === 0 || manifestsQuery.isSuccess),
  });

  // ── The repo dimension (BC-38) ──
  const projects = useMemo(() => {
    const byCwd: Record<string, string> = {};
    for (const session of sessions) {
      if (!session.cwd) continue;
      byCwd[session.cwd] = displayNames[session.cwd] ?? session.cwd.split('/').pop() ?? session.cwd;
    }
    return { activeCount: Object.keys(byCwd).length, byCwd };
  }, [sessions, displayNames]);

  const state = useMemo(
    () => ({
      now,
      sessions,
      workingSessionIds,
      sessionStatuses,
      rooms,
      threads,
      agents,
      displayNames,
      attention,
      recents,
      prefs,
      interactions,
      // No field on the wire carries "when did the operator last WRITE here"
      // yet (§F makes it an additive field on `GET /api/sessions/recent`), and
      // no client source counts @mentions above a read cursor. A source that
      // cannot say has no entry — omission, never a guess (BC-16, BC-40).
      userLastMessageAt: {},
      mentions: {},
      todayAutomatedExpanded,
      activeTarget,
      journey: journey.facts,
      digest: digestFacts.digest,
      projects,
    }),
    [
      now,
      sessions,
      workingSessionIds,
      sessionStatuses,
      rooms,
      threads,
      agents,
      displayNames,
      attention,
      recents,
      prefs,
      interactions,
      todayAutomatedExpanded,
      activeTarget,
      journey.facts,
      digestFacts.digest,
      projects,
    ]
  );

  // **A write, inside the hook that gathers reads — deliberately.** Retirement
  // is permanent (BC-13), so its writer needs both the facts and the one bit
  // that says whether they are real; `SidebarState` carries the first and not
  // the second, and adding a resolution flag to the model's snapshot would put
  // a loading state into a pure function that has no business knowing about
  // one. Placing it here keeps that bit where it is produced.
  useGettingStartedRetirement(state, journey.isResolved);

  return state;
}
