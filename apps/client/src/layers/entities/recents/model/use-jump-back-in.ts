/**
 * The one query path behind "Jump back in" (spec `team-room-home` §D2.3).
 *
 * @module entities/recents/model/use-jump-back-in
 */
import { useMemo } from 'react';
import type { SessionListWarning } from '@dorkos/shared/types';
import { useRooms } from '@/layers/entities/room';
import { useRecentSessions } from '@/layers/entities/session';
// Same-slice import via the sibling module rather than the slice barrel, which
// would be a self-referential import.
import { mergeJumpBackIn, MAX_JUMP_BACK_IN, type JumpBackInModel } from '../lib/jump-back-in';

/**
 * How many sessions to ask for, per row of list.
 *
 * `GET /api/sessions/recent` truncates before this hook sees anything, and every
 * room turn and scheduled run inside that window is then dropped from the rows.
 * Asking for exactly the cap therefore starves the list on a busy install: eight
 * room turns arrive, eight rows are dropped, and a person with plenty of
 * conversations sees none of them.
 *
 * A ceiling, not a guarantee — an install whose last two dozen sessions are ALL
 * automated still shows rooms only, which is honest. Three, because the fetch is
 * one server-side fan-out and tripling it is cheap next to being wrong.
 */
const FETCH_WINDOW_FACTOR = 3;

/** The smallest window worth asking for — `useRecentSessions`' own default. */
const MIN_FETCH_WINDOW = 10;

/** Options for {@link useJumpBackIn}. */
export interface UseJumpBackInOptions {
  /** Row cap. Defaults to {@link MAX_JUMP_BACK_IN}. */
  limit?: number;
  /**
   * Room ids the operator has muted (`ui.sidebar.muted`). Muted rooms are
   * dropped from the list entirely — see {@link mergeJumpBackIn}. Absent means
   * nothing is muted.
   */
  mutedRoomIds?: ReadonlySet<string>;
  /**
   * Read anything at all. `false` holds both queries idle and answers with an
   * empty model — for a caller that is mounted but not offering the list, which
   * is the room composer in every room but the home one. Defaults to `true`.
   */
  enabled?: boolean;
}

/** What {@link useJumpBackIn} answers with. */
export interface UseJumpBackIn extends JumpBackInModel {
  /**
   * True only while both sources are still loading their FIRST answer. It goes
   * false as soon as they have one, empty or not — a person with no threads
   * yet sees an empty list, never a spinner that never resolves.
   */
  isLoading: boolean;
  /**
   * Per-runtime degradation from the session fan-out (ADR-0310). A surface that
   * shows this list is not the place to explain a runtime outage, so callers
   * log it rather than draw it.
   */
  warnings: SessionListWarning[];
}

/**
 * Every thread you were last in — sessions, direct messages and channels —
 * as one list, most recent first.
 *
 * Both reads are queries the cockpit already makes (`useRecentSessions`,
 * `useRooms`), so this shares their caches and their live invalidation rather
 * than opening a third door onto the same data: the sidebar section and the
 * composer popover show the same rows because they are literally the same
 * query results, not because two code paths agree.
 *
 * @param options - Row cap and the operator's muted rooms.
 */
export function useJumpBackIn({
  limit = MAX_JUMP_BACK_IN,
  mutedRoomIds,
  enabled = true,
}: UseJumpBackInOptions = {}): UseJumpBackIn {
  const recentQuery = useRecentSessions(Math.max(limit * FETCH_WINDOW_FACTOR, MIN_FETCH_WINDOW), {
    enabled,
  });
  const roomsQuery = useRooms({ enabled });

  const sessions = recentQuery.data?.sessions;
  const rooms = roomsQuery.data;

  const model = useMemo(
    () => mergeJumpBackIn({ sessions: sessions ?? [], rooms: rooms ?? [], mutedRoomIds, limit }),
    [sessions, rooms, mutedRoomIds, limit]
  );

  return {
    ...model,
    // A disabled query is `isLoading` forever in TanStack's reading — it is
    // pending and not fetching — and a caller that asked for nothing is not
    // waiting for anything. So "off" reads as loaded-and-empty.
    isLoading: enabled && (recentQuery.isLoading || roomsQuery.isLoading),
    warnings: recentQuery.data?.warnings ?? [],
  };
}
