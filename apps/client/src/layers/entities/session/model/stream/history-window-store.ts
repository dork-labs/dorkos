/**
 * The part of a long conversation that sits before its snapshot (DOR-2889).
 *
 * A session's hydration snapshot carries only its newest messages and counts
 * the rest (`SessionSnapshot.earlierMessages`). This store holds, per session,
 * where that window starts, how many messages remain before it, and the older
 * pages the reader has asked for since. The stream store keeps the window
 * itself; nothing here changes what it holds.
 *
 * A snapshot whose window starts somewhere else starts the session over: a
 * page read against the old window might no longer join up with it. One that
 * starts on the same message (a reconnect) keeps the pages already read, since
 * nothing before that message can have changed.
 *
 * @module entities/session/model/stream/history-window-store
 */
import { create } from 'zustand';
import type { HistoryMessage } from '@dorkos/shared/types';

/** One session's history before its snapshot window. */
export interface HistoryWindowState {
  /** Id of the first message the snapshot carried, or null when it carried none. */
  windowStartId: string | null;
  /** Older pages read so far, oldest first. */
  earlier: HistoryMessage[];
  /** How many messages remain before `earlier` (or before the window). */
  remaining: number;
  /**
   * Bumped each time the pages start over, and 0 before any snapshot. A page
   * that lands after a bump was read against a window nobody holds any more.
   */
  generation: number;
}

interface HistoryWindowStore {
  sessions: Record<string, HistoryWindowState>;
  /**
   * A message a link asked the conversation to open on, per session, until the
   * pages before the window have been read far enough to hold it.
   */
  seeks: Record<string, string>;
  /** Ask for older pages to be read until `messageId` is loaded (or none remain). */
  seek: (sessionId: string, messageId: string) => void;
  /** The seek is over: found, or there is nothing more to read. */
  endSeek: (sessionId: string) => void;
  /** Record a new snapshot's window; drops pages read against an older one. */
  noteSnapshot: (sessionId: string, windowStartId: string | null, remaining: number) => void;
  /**
   * Put a page of older messages in front of what is loaded, unless the pages
   * started over since it was asked for (`generation` no longer matches).
   */
  prependPage: (
    sessionId: string,
    generation: number,
    page: HistoryMessage[],
    remaining: number
  ) => void;
}

/** The state of a session the store has not seen: nothing before the window. */
export const EMPTY_HISTORY_WINDOW: HistoryWindowState = {
  windowStartId: null,
  earlier: [],
  remaining: 0,
  generation: 0,
};

/** Per-session record of what sits before each snapshot's window. */
export const useHistoryWindowStore = create<HistoryWindowStore>()((set) => ({
  sessions: {},
  seeks: {},
  seek: (sessionId, messageId) =>
    set((state) => ({ seeks: { ...state.seeks, [sessionId]: messageId } })),
  endSeek: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.seeks)) return state;
      const { [sessionId]: _done, ...rest } = state.seeks;
      return { seeks: rest };
    }),
  noteSnapshot: (sessionId, windowStartId, remaining) =>
    set((state) => {
      const current = state.sessions[sessionId] ?? EMPTY_HISTORY_WINDOW;
      if (current.generation > 0 && current.windowStartId === windowStartId) {
        // Same window: the pages read before it still join up.
        if (current.earlier.length > 0 || current.remaining === remaining) return state;
        return { sessions: { ...state.sessions, [sessionId]: { ...current, remaining } } };
      }
      const generation = current.generation + 1;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { windowStartId, earlier: [], remaining, generation },
        },
      };
    }),
  prependPage: (sessionId, generation, page, remaining) =>
    set((state) => {
      const current = state.sessions[sessionId] ?? EMPTY_HISTORY_WINDOW;
      if (current.generation === 0 || current.generation !== generation) return state;
      const known = new Set(current.earlier.map((message) => message.id));
      const fresh = page.filter((message) => !known.has(message.id));
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...current, earlier: [...fresh, ...current.earlier], remaining },
        },
      };
    }),
}));

/**
 * One session's history-window state.
 *
 * @param sessionId - The session, or null for none.
 */
export function useHistoryWindow(sessionId: string | null): HistoryWindowState {
  return useHistoryWindowStore((state) =>
    sessionId === null ? EMPTY_HISTORY_WINDOW : (state.sessions[sessionId] ?? EMPTY_HISTORY_WINDOW)
  );
}
