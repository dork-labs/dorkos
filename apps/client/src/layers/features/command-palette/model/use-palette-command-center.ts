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
  /** Live conversations, waiting-on-you first. Empty when nothing is live. */
  continueRows: PaletteContinueRow[];
  /** The last things you were in, across sessions, rooms and agents. */
  recent: PaletteRecentEntry[];
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
 */
export function usePaletteCommandCenter(
  agents: readonly AgentPathEntry[],
  rooms: readonly RoomSummary[],
  unreadRoomIds: ReadonlySet<string>
): PaletteCommandCenter {
  const { data } = useRecentSessions(PALETTE_SESSION_WINDOW);

  // Both maps are replaced only when they change (immer), so a plain selector
  // is a stable reference and needs no `useShallow` — which could not be used
  // here anyway: a selector deriving fresh objects re-renders forever under
  // zustand v5's `useSyncExternalStore`.
  const statuses = useSessionListStore((s) => s.statuses);
  const streamed = useSessionListStore(useShallow((s) => Object.values(s.sessions)));

  const sessions = useMemo(
    () => toPaletteSessionItems(data?.sessions ?? [], agents),
    [data?.sessions, agents]
  );

  const streamedSessions = useMemo(
    () => toPaletteSessionItems(streamed, agents),
    [streamed, agents]
  );

  const continueRows = useMemo(() => {
    const byId = new Map<string, PaletteSessionItem>();
    for (const item of streamedSessions) byId.set(item.id, item);
    for (const item of sessions) if (!byId.has(item.id)) byId.set(item.id, item);
    return selectContinueEntries(statuses).flatMap((entry) => {
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
  }, [statuses, streamedSessions, sessions]);

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

  return { sessions, continueRows, recent };
}
