/**
 * Global session-list store — pure Zustand state fed by the global `/api/events`
 * stream (spec chat-stream-reconnection). Holds the fleet-wide session metadata
 * and per-session status projections the sidebar and fleet views read.
 *
 * Like the per-session stream store, this is pure state: it imports NOTHING from
 * the StreamManager. The binding (`session-stream-binding.ts`) feeds it from the
 * StreamManager's `onListEvent`. Phase 4 (#11) subscribes the sidebar here and
 * drops the polling fallback.
 *
 * @module entities/session/model/session-list-store
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Session } from '@dorkos/shared/types';
import type { SessionStatus, SessionListEvent } from '@dorkos/shared/session-stream';

interface SessionListStoreState {
  /** Session metadata keyed by id (from `session_upserted`). */
  sessions: Record<string, Session>;
  /** Per-session status projection keyed by id (from `session_status`). */
  statuses: Record<string, SessionStatus>;
}

interface SessionListActions {
  /** Insert or replace a session's metadata. */
  upsertSession: (session: Session) => void;
  /** Remove a session and its status by id. */
  removeSession: (sessionId: string) => void;
  /** Set a session's status projection. */
  setSessionStatus: (sessionId: string, status: SessionStatus) => void;
  /**
   * Apply any {@link SessionListEvent} — the single entry point the binding
   * routes the global stream through, dispatching by `type`.
   */
  applyListEvent: (event: SessionListEvent) => void;
}

/**
 * Zustand store for the global session list. Decoupled from the React lifecycle
 * so the sidebar and fleet views share one live source fed by `/api/events`.
 */
export const useSessionListStore = create<SessionListStoreState & SessionListActions>()(
  devtools(
    immer((set) => ({
      sessions: {},
      statuses: {},

      upsertSession: (session) =>
        set(
          (state) => {
            state.sessions[session.id] = session;
          },
          false,
          'session-list/upsertSession'
        ),

      removeSession: (sessionId) =>
        set(
          (state) => {
            delete state.sessions[sessionId];
            delete state.statuses[sessionId];
          },
          false,
          'session-list/removeSession'
        ),

      setSessionStatus: (sessionId, status) =>
        set(
          (state) => {
            state.statuses[sessionId] = status;
          },
          false,
          'session-list/setSessionStatus'
        ),

      applyListEvent: (event) =>
        set(
          (state) => {
            switch (event.type) {
              case 'session_upserted':
                state.sessions[event.session.id] = event.session;
                break;
              case 'session_removed':
                delete state.sessions[event.sessionId];
                delete state.statuses[event.sessionId];
                break;
              case 'session_status':
                state.statuses[event.sessionId] = event.status;
                break;
            }
          },
          false,
          `session-list/${event.type}`
        ),
    })),
    { name: 'SessionListStore', enabled: import.meta.env.DEV }
  )
);

/** Selector: all session metadata as an array (stable per-store-update identity). */
export function useSessionListSessions(): Session[] {
  return useSessionListStore(useCallback((s) => Object.values(s.sessions), []));
}

/** Selector: the status projection for a single session, or `null`. */
export function useSessionListStatus(sessionId: string): SessionStatus | null {
  return useSessionListStore(useCallback((s) => s.statuses[sessionId] ?? null, [sessionId]));
}
