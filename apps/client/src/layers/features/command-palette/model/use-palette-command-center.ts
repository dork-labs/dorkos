/**
 * The zero-query command center: Continue, then Recent (design-decisions §15).
 *
 * The wiring layer over {@link palette-recent}'s pure rules — it reads the two
 * sources the cockpit already has (the cross-agent recent-session query and the
 * fleet-wide session-list stream) and hands back rows.
 *
 * @module features/command-palette/model/use-palette-command-center
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { activityVerb } from '@/layers/shared/lib';
import type { StatusSignal } from '@/layers/shared/ui';
import {
  partitionSessionsByOrigin,
  useRecentSessions,
  useSessionListStore,
} from '@/layers/entities/session';
import {
  buildPaletteRecent,
  selectContinueEntries,
  type PaletteRecentEntry,
} from './palette-recent';
import {
  PALETTE_SESSION_WINDOW,
  toPaletteSessionItems,
  type PaletteSessionItem,
} from './palette-sessions';

/** A live conversation, and what it is honestly doing. */
export interface PaletteContinueRow {
  /** The session, in row shape. */
  session: PaletteSessionItem;
  /**
   * What to say it is doing, from the shared ladder — or `null` when nothing
   * can be said honestly, in which case the row draws no second line at all.
   */
  verb: string | null;
  /**
   * The dot beside the verb, in the cockpit's one dot vocabulary — `working`
   * for a turn in flight, `needs-you` for one that has stopped and is waiting
   * on a person. Derived from the same lifecycle the verb is, so the colour and
   * the words can never disagree.
   */
  signal: StatusSignal;
}

/** What the zero-query palette draws, and the corpus search reads. */
export interface PaletteCommandCenter {
  /** Every session in the window, automated runs included — the search corpus. */
  sessions: PaletteSessionItem[];
  /**
   * Live conversations, waiting-on-you first. Empty when nothing is live.
   *
   * Human-origin only, like every other liveness count in the cockpit (§18) —
   * an automated run that needs you arrives in Heads up, not here.
   */
  continueRows: PaletteContinueRow[];
  /** The last things you were in, across sessions, rooms and agents. */
  recent: PaletteRecentEntry[];
  /**
   * Each agent's latest session time, keyed by `projectPath`, ISO-8601 — the
   * `agentActivity` map `GET /api/sessions/recent` already returns.
   *
   * Handed out as well as used, because it is the only freshness an AGENT has:
   * a conversation and a room each carry their own `lastActivityAt`, and an
   * agent carries none, so without this the ranker would score every agent as
   * equally stale (`palette-ranking`'s recency signal).
   */
  agentActivity: Readonly<Record<string, string>>;
}

/**
 * Assemble the command center.
 *
 * Two sources, because they answer two different questions. `GET
 * /api/sessions/recent` says what EXISTS and when it was last touched; the
 * session-list stream says what is happening RIGHT NOW. A live session that
 * started after the last fetch is in the second and not yet the first, which is
 * why Continue resolves its metadata from the stream's own session map before
 * falling back to the query's window — the alternative is a live row that
 * cannot say whose conversation it is until the query refetches.
 *
 * @param agents - Every agent the cockpit can see, for session attribution.
 * @param rooms - Every room, archived included, for the Recent mix.
 * @param unreadRoomIds - Rooms with something waiting, which lead Recent.
 * @param archivedBefore - The cockpit's day boundary, epoch ms. Conversations
 *   older than it are labelled archived. Passed in rather than derived here
 *   because it changes once a day: a clock read on this line would rebuild the
 *   whole corpus — and the Fuse index over it — every minute the app is open.
 */
export function usePaletteCommandCenter(
  agents: readonly AgentPathEntry[],
  rooms: readonly RoomSummary[],
  unreadRoomIds: ReadonlySet<string>,
  archivedBefore: number
): PaletteCommandCenter {
  // Asked for at BOOT, not when the palette opens — and that is a decision, not
  // an oversight.
  //
  // `CommandPaletteDialog` mounts at the app root and never unmounts, so this
  // fires whether or not anyone presses ⌘K. It is a real cost: the query key
  // carries the limit, so this is a SECOND cross-runtime `/api/sessions/recent`
  // fan-out beside the sidebar's limit-10 one, not a cache hit on it.
  //
  // It is worth paying because a front door for recall that spins on its first
  // keystroke is not a front door. The window is what SEARCH reads, so gating it
  // on `open` would put a cross-runtime fan-out between ⌘K and the first result
  // every single time — the palette would feel slow exactly when a person is in
  // a hurry, which is the only time they open it.
  //
  // `useRecentSessions` does take `{ enabled }`, and it is deliberately not used
  // here. (Sharing one window with the sidebar would remove the second fan-out
  // outright, but that is the sidebar's query to widen, and the sidebar is
  // another task's territory.)
  const { data } = useRecentSessions(PALETTE_SESSION_WINDOW);

  // Both maps are replaced only when they change (immer), so a plain selector
  // is a stable reference and needs no `useShallow` — which could not be used
  // here anyway: a selector deriving fresh objects re-renders forever under
  // zustand v5's `useSyncExternalStore`.
  const statuses = useSessionListStore((s) => s.statuses);
  const streamed = useSessionListStore(useShallow((s) => Object.values(s.sessions)));

  const sessions = useMemo(
    () => toPaletteSessionItems(data?.sessions ?? [], agents, archivedBefore),
    [data?.sessions, agents, archivedBefore]
  );

  const streamedSessions = useMemo(
    () => toPaletteSessionItems(streamed, agents, archivedBefore),
    [streamed, agents, archivedBefore]
  );

  // Every session record the palette can see, from both sources, so Continue
  // can read an id's origin off whichever one carries it.
  //
  // **Order does not matter here, and it is worth saying so.**
  // `humanOriginSessionIds` collects the AUTOMATED ids across all the records it
  // is given, so one record marking a session automated excludes it however many
  // unmarked copies sit beside it. Automated wins regardless of order — the safe
  // direction — and the concatenation is only about coverage.
  //
  // **What each source does and does not know.** Both carry `origin`: the
  // server applies the same overlays to the REST routes and to the global
  // session-list stream, from one shared rule, so a room turn is marked on
  // whichever of the two a client hears it from first (DOR-1141). The stream's
  // map is additionally where a run that started after the last fetch exists at
  // all, and it supplies that session's title and cwd.
  //
  // A gap survives only where NEITHER source has spoken yet, and it closes the
  // moment either does. Until then Continue counts the session as human, which
  // is the documented direction: unknown is not automated.
  //
  // `data` whole rather than its one field, for the same React Compiler reason
  // the Recent memo below spells out.
  const knownSessions = useMemo(() => [...streamed, ...(data?.sessions ?? [])], [streamed, data]);

  const continueRows = useMemo(() => {
    const byId = new Map<string, PaletteSessionItem>();
    for (const item of streamedSessions) byId.set(item.id, item);
    for (const item of sessions) if (!byId.has(item.id)) byId.set(item.id, item);
    return selectContinueEntries(statuses, knownSessions).flatMap((entry) => {
      const session = byId.get(entry.sessionId);
      // A live session nothing knows the name of gets no row rather than a
      // placeholder one: "Untitled › working…" is a row you cannot act on.
      if (!session) return [];
      return [
        {
          session,
          verb: activityVerb(entry.lifecycle, entry.activity),
          signal: entry.lifecycle === 'blocked' ? ('needs-you' as const) : ('working' as const),
        },
      ];
    });
  }, [statuses, streamedSessions, sessions, knownSessions]);

  const recent = useMemo(() => {
    const conversations = new Set(
      partitionSessionsByOrigin(data?.sessions ? [...data.sessions] : []).conversations.map(
        (session) => session.id
      )
    );
    return buildPaletteRecent({
      sessions: sessions.filter((session) => conversations.has(session.id)),
      rooms,
      unreadRoomIds,
      agents,
      agentActivity: data?.agentActivity ?? {},
      excludeSessionIds: new Set(continueRows.map((row) => row.session.id)),
    });
    // `data` whole rather than its two fields: the React Compiler cannot
    // preserve a memo whose declared dependencies are narrower than the ones it
    // infers, and it skips optimizing the whole hook when they disagree. The
    // query hands back a new object only when the answer changes, so this is
    // the same cache with a shape the compiler can keep.
  }, [data, sessions, rooms, unreadRoomIds, agents, continueRows]);

  return { sessions, continueRows, recent, agentActivity: data?.agentActivity ?? EMPTY_ACTIVITY };
}

/**
 * The empty activity map, as one shared object.
 *
 * A fresh `{}` per render would be a new identity every time, and this value
 * feeds a `useMemo` dependency list in the corpus above — so the corpus would
 * rebuild on every render for as long as the query has not answered.
 */
const EMPTY_ACTIVITY: Readonly<Record<string, string>> = Object.freeze({});
