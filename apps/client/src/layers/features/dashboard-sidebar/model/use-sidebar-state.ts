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
import { useCallback, useMemo, useRef } from 'react';
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
 * **`/` is deliberately NOT a room target here**, even though it draws #team.
 * This value is the sidebar's notion of what is open, and it feeds far more than
 * a row tint: the scroll anchor, the working rollup, and which rows Today
 * gathers all read it. Making Home answer "the #team room" pinned #team into
 * Today and moved the anchor on every visit to the dashboard — a large behaviour
 * change smuggled in behind a highlight. The highlight is handled on its own,
 * next to the row that needs it (`SidebarChrome`'s `activeRoomId`).
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
  // `?thread=` is spelled the same on both routes and means the same thing.
  const rootEntryId = pathname === '/channels' || pathname === '/' ? (search.thread ?? null) : null;
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

/** What a caller may tell {@link useSidebarState} about its own surface. */
export interface UseSidebarStateOptions {
  /**
   * Signal ids this surface is already drawing as cards above Heads up.
   *
   * The phone's Home tab and nothing else — see
   * {@link SidebarState.coveredSignalIds}. Must be referentially stable across
   * renders that do not change it, like every other list in this hook: a fresh
   * array each render would rebuild the whole model.
   */
  coveredSignalIds?: readonly string[];
}

/**
 * Everything the sidebar is a function of, as one memoized snapshot.
 *
 * One field is still waiting for a source and says so where it is filled:
 * `mentions`, which no client source can count above a read cursor. Its absence
 * is the specified behaviour rather than a gap — omission, never a guess
 * (BC-40).
 *
 * @param options - What the calling surface draws for itself. Desktop passes
 * nothing.
 */
export function useSidebarState(options: UseSidebarStateOptions = {}): SidebarState {
  const { coveredSignalIds } = options;
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
  // Whose each of those is, from the same event that made it live — the REST
  // window above is up to thirty seconds behind, and a folded section that
  // waited for it lost the working signal for exactly that long (BC-31,
  // DOR-1137). A plain selector is stable here: immer replaces `statusCwds`
  // only when it changes, which is the same read `useAgentAttentionMap` makes.
  const liveSessionCwds = useSessionListStore(useCallback((s) => s.statusCwds, []));

  // ── Rooms and threads ──
  const roomsQuery = useRooms();
  const rooms = useMemo(() => roomsQuery.data ?? [], [roomsQuery.data]);
  const threadsQuery = useThreads();
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);

  // ── What the operator opened, and when ──
  // Read before the fleet because attention is a function of it — an agent you
  // opened this week is not dormant, whatever it ran (D3) — and before prefs
  // because the digest is a function of it too (BC-22).
  const interactions = useInteractionTimestamps();
  // The agent half of that record, re-keyed by path and parsed once. Guarded for
  // stability like every other map here: a fresh object each render would defeat
  // `useAgentAttentionMap`'s memo on every store tick.
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
          lastInteractionAt: agentInteractionAt[path] ?? null,
          attention: attentionMap[path] ?? 'inactive',
        };
      }),
    [rawPaths, manifests, agentActivity, attentionMap, agentInteractionAt]
  );
  const displayNames = useMemo(
    () => disambiguateDisplayNames(rawPaths, manifests ?? {}),
    [rawPaths, manifests]
  );

  // ── When the operator last WROTE, the server's half of Today's key ──
  //
  // The other half of BC-16's `max(userLastMessageAt, userLastOpenedAt)`, from
  // `Session.userLastMessageAt` on `GET /api/sessions/recent` (DOR-1081). A
  // session that carries no value contributes no entry, and the operator's own
  // interaction record governs alone — omission, never a guess.
  //
  // **Read from the REST window and from nothing else, deliberately.** The live
  // session-list stream carries session records too, and it is the wrong source
  // for this one field: `SessionListBroadcaster` applies only the stored-settings
  // overlay, not the room and task origin overlays that suppress the field for
  // turns a person did not start. A room turn's prompt arrives as plain user
  // text no content rule can tell from something you typed, so on the stream it
  // would look like your writing and reorder Today for work an agent did. The
  // REST read applies those overlays and is the only source that has answered
  // the question.
  //
  // Stability-guarded like every other map here: a session's other fields churn
  // (`updatedAt` moves on every agent write) and rebuilding this map identically
  // would rebuild the whole model with it.
  const userLastMessageAt = useShallowStable(
    useMemo(() => {
      const written: Record<string, string> = {};
      for (const session of sessions) {
        const at = session.userLastMessageAt;
        if (at !== undefined) written[`session:${session.id}`] = at;
      }
      return written;
    }, [sessions])
  );

  // ── Preferences, and the recents list they filter ──
  const storedPrefs = useSidebarPrefs();
  const storedModelPrefs = useMemo(() => toSidebarModelPrefs(storedPrefs), [storedPrefs]);
  const digestFacts = useDigestFacts({
    now,
    sessions,
    workingSessionIds,
    sessionStatuses,
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
  // The only source Heads up draws from, normalized once in `entities/attention` so
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
    rooms,
    rosterResolved:
      meshQuery.isSuccess &&
      recentQuery.isSuccess &&
      (rawPaths.length === 0 || manifestsQuery.isSuccess),
  });

  const state = useMemo(
    () => ({
      now,
      sessions,
      workingSessionIds,
      liveSessionCwds,
      sessionStatuses,
      rooms,
      threads,
      agents,
      displayNames,
      attention,
      recents,
      prefs,
      interactions,
      userLastMessageAt,
      // No client source counts @mentions above a read cursor. A source that
      // cannot say has no entry — omission, never a guess (BC-40).
      mentions: {},
      ...(coveredSignalIds === undefined ? {} : { coveredSignalIds }),
      todayAutomatedExpanded,
      activeTarget,
      journey: journey.facts,
      digest: digestFacts.digest,
    }),
    [
      coveredSignalIds,
      now,
      sessions,
      workingSessionIds,
      liveSessionCwds,
      sessionStatuses,
      rooms,
      threads,
      agents,
      displayNames,
      attention,
      recents,
      prefs,
      interactions,
      userLastMessageAt,
      todayAutomatedExpanded,
      activeTarget,
      journey.facts,
      digestFacts.digest,
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
