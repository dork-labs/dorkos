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
import type {
  SessionStatus,
  SessionListEvent,
  SessionContextUsage,
} from '@dorkos/shared/session-stream';

/**
 * A retained per-session live context reading (survives settle). Decision 3
 * splits liveness from the reading into two maps so the liveness/border prune
 * can never cross-regress a settled session's last reading.
 */
export interface SessionContextReading {
  /** The live SDK usage breakdown (carries totalTokens + maxTokens). */
  contextUsage: SessionContextUsage;
  /** Client receive time (ISO) — the live reading's freshness stamp. */
  receivedAt: string;
}

interface SessionListStoreState {
  /** Session metadata keyed by id (from `session_upserted`). */
  sessions: Record<string, Session>;
  /** Per-session status projection keyed by id (from `session_status`). */
  statuses: Record<string, SessionStatus>;
  /**
   * Working directory per status-bearing session, when the server knows it
   * (from `session_status.cwd`). Lets agent rows aggregate liveness by cwd
   * even for sessions whose metadata was never fetched.
   */
  statusCwds: Record<string, string>;
  /**
   * Retained live context reading per session (from `session_status.contextUsage`).
   * Unlike {@link statuses}, this is NOT pruned when a session settles to
   * idle/interrupted — a settled session keeps showing its last known context
   * usage instead of blanking (Decision 3). Bounded by "sessions seen streaming
   * since connect": cleared on remove, on rekey-retire, and on stream reconnect
   * ({@link SessionListActions.resetStatuses}) so a stale reading can't outlive a
   * server restart the way a status can't.
   */
  contextReadings: Record<string, SessionContextReading>;
  /**
   * Sessions that settled while NOT being viewed (background work the operator
   * has not acknowledged), keyed by id with the session's cwd as the value when
   * the settle event carried one (`null` otherwise). The cwd lets a collapsed
   * agent row light up for an unseen settle the same way `statusCwds` does for
   * live statuses. Marked by the stream binding on a background streaming→settled
   * edge; cleared when the session becomes active (or is removed).
   */
  unseen: Record<string, string | null>;
  /**
   * Retired request UUIDs mapped to the canonical id that superseded them,
   * recorded from `session_status.retiredSessionId` (the create-on-first-message
   * rekey re-announce). Consumers use this to follow the rekey after the fact:
   * the chat view replaces a retired URL id with its canonical id, and the
   * query-cache reconciler drops the retired placeholder row (NF-2/NF-3,
   * acceptance run 20260611-145454). Entries are two UUID strings each and a
   * client mints at most one per session creation, so the map needs no pruning.
   */
  rekeys: Record<string, string>;
}

interface SessionListActions {
  /** Insert or replace a session's metadata. */
  upsertSession: (session: Session) => void;
  /** Remove a session and its status by id. */
  removeSession: (sessionId: string) => void;
  /** Set a session's status projection (and its cwd, when carried). */
  setSessionStatus: (sessionId: string, status: SessionStatus, cwd?: string) => void;
  /**
   * Apply any {@link SessionListEvent} — the single entry point the binding
   * routes the global stream through, dispatching by `type`.
   */
  applyListEvent: (event: SessionListEvent) => void;
  /** Flag a session as having settled unseen in the background. */
  markUnseen: (sessionId: string, cwd?: string) => void;
  /** Acknowledge a session's unseen-activity flag (it became active). */
  clearUnseen: (sessionId: string) => void;
  /**
   * Drop every status projection and retained context reading (NOT metadata,
   * NOT unseen flags). Called by the binding when the global stream
   * (re)connects: `session_status` is
   * fan-out-only with no replay for late joiners, so a status held across a
   * disconnect — e.g. a 'streaming' that settled while the server restarted —
   * would otherwise pin a stale border until that session's NEXT transition,
   * which after a restart may never come. Live sessions re-assert themselves
   * on their next real transition.
   */
  resetStatuses: () => void;
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
      statusCwds: {},
      contextReadings: {},
      unseen: {},
      rekeys: {},

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
            delete state.statusCwds[sessionId];
            delete state.contextReadings[sessionId];
            delete state.unseen[sessionId];
          },
          false,
          'session-list/removeSession'
        ),

      setSessionStatus: (sessionId, status, cwd) =>
        set(
          (state) => {
            state.statuses[sessionId] = status;
            if (cwd !== undefined) state.statusCwds[sessionId] = cwd;
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
                delete state.statusCwds[event.sessionId];
                delete state.contextReadings[event.sessionId];
                delete state.unseen[event.sessionId];
                break;
              case 'session_status': {
                // A rekey re-announce names the request UUID the session
                // streamed under pre-rekey; no session_removed ever fires for
                // it, so drop EVERYTHING keyed by it here — a lingering status
                // pins liveness forever, a lingering unseen flag would never
                // clear (a retired UUID can never become active), and a
                // lingering metadata row renders as a dead duplicate beside the
                // canonical row (NF-3). The retirement is also RECORDED so
                // late-bound consumers (URL rekey, query-cache reconciler) can
                // follow it.
                if (event.retiredSessionId !== undefined) {
                  delete state.sessions[event.retiredSessionId];
                  delete state.statuses[event.retiredSessionId];
                  delete state.statusCwds[event.retiredSessionId];
                  delete state.contextReadings[event.retiredSessionId];
                  delete state.unseen[event.retiredSessionId];
                  state.rekeys[event.retiredSessionId] = event.sessionId;
                }
                // Retain the reading on EVERY status carrying contextUsage,
                // including a settling one — a settled session keeps showing its
                // last known usage instead of blanking (Decision 3). This is the
                // ONLY map that survives settle; the liveness maps below still
                // prune, so the border signal stays memory-bounded.
                if (event.status.contextUsage) {
                  state.contextReadings[event.sessionId] = {
                    contextUsage: event.status.contextUsage,
                    receivedAt: new Date().toISOString(),
                  };
                }
                // Settled lifecycles carry no liveness signal
                // (borderKindFromLifecycle treats absent and idle identically),
                // so prune the status/cwd instead of storing — `session_removed`
                // only fires on transcript deletion, so on a long-lived client
                // every session that ever transitioned would otherwise
                // accumulate an entry scanned per agent row.
                const lifecycle = event.status.lifecycle;
                if (lifecycle === 'idle' || lifecycle === 'interrupted') {
                  delete state.statuses[event.sessionId];
                  delete state.statusCwds[event.sessionId];
                } else {
                  state.statuses[event.sessionId] = event.status;
                  if (event.cwd !== undefined) state.statusCwds[event.sessionId] = event.cwd;
                }
                break;
              }
            }
          },
          false,
          `session-list/${event.type}`
        ),

      markUnseen: (sessionId, cwd) =>
        set(
          (state) => {
            state.unseen[sessionId] = cwd ?? null;
          },
          false,
          'session-list/markUnseen'
        ),

      clearUnseen: (sessionId) =>
        set(
          (state) => {
            delete state.unseen[sessionId];
          },
          false,
          'session-list/clearUnseen'
        ),

      resetStatuses: () =>
        set(
          (state) => {
            state.statuses = {};
            state.statusCwds = {};
            // A reading held across a disconnect could be stale after a server
            // restart (same reasoning as the status drop), so clear it too.
            state.contextReadings = {};
          },
          false,
          'session-list/resetStatuses'
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

/**
 * Selector: the retained live context reading for a single session, or `null`.
 * Survives settle (unlike {@link useSessionListStatus}) so a background session
 * keeps its last known usage; the merge resolver prefers this over the list
 * reading when present (live wins).
 */
export function useSessionContextReading(sessionId: string): SessionContextReading | null {
  return useSessionListStore(useCallback((s) => s.contextReadings[sessionId] ?? null, [sessionId]));
}

/**
 * Selector: the canonical id that superseded `sessionId` via the
 * create-on-first-message rekey, or `null` when the id is current (or unknown).
 * The chat view uses this to replace a retired URL id in place.
 */
export function useSessionRekeyTarget(sessionId: string | null): string | null {
  return useSessionListStore(
    useCallback((s) => (sessionId ? (s.rekeys[sessionId] ?? null) : null), [sessionId])
  );
}
