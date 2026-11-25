/**
 * The projector's lifecycle fan-out: every session's lifecycle transition,
 * told to whoever registered for it (the session list, the notification
 * emitters, rooms, projects). Its own module so the projector stays a
 * projection; `session-state-projector.ts` re-exports the registration.
 *
 * @module services/session/projector/status-change
 */
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { logger } from '../../../lib/logger.js';

/**
 * A lifecycle-bearing status update fanned out to global listeners (the
 * session-list broadcaster turns these into `session_status` events on
 * `/api/events`, which drive the sidebar's liveness indicators).
 */
export interface ProjectorStatusUpdate {
  /** The id the projector is CURRENTLY registered under (canonical post-rekey). */
  sessionId: string;
  /** Working directory of the session, when known — lets clients group liveness per agent. */
  cwd: string | undefined;
  /**
   * On a rekey re-announce only: the request UUID this projector streamed
   * under before the canonical id resolved. Listeners must retire any state
   * held under it — pre-rekey transitions fanned out under that id, and no
   * removal event will ever follow for it.
   */
  retiredSessionId?: string;
  /**
   * The turn this transition belongs to, when one is open or just ended: the
   * `seq` of its `turn_start`, the id the run record keeps as
   * `runtime_turn_ref`. A `turn_end`'s own transition carries the turn it
   * closed. So a listener can tell which turn finished, never guess by time.
   */
  turnRef?: number;
  /** A copy of the full projected status. */
  status: SessionStatus;
}

/** Listener invoked whenever any projector's `lifecycle` transitions. */
type StatusChangeListener = (update: ProjectorStatusUpdate) => void;

/** Global lifecycle-transition listeners (registry-level, not per-projector). */
const statusChangeListeners = new Set<StatusChangeListener>();

/**
 * Register a listener invoked whenever ANY session's projected `lifecycle`
 * transitions (idle/streaming/blocked/error/interrupted). Notification is
 * lifecycle-gated deliberately: per-chunk `status_change` deltas (output-token
 * counts) do NOT fan out, so listeners see only the infrequent transitions the
 * sidebar actually renders.
 *
 * @param listener - Receives the projector's current id, cwd (when known), and status.
 * @returns Unsubscribe function.
 */
export function onProjectorStatusChange(listener: StatusChangeListener): () => void {
  statusChangeListeners.add(listener);
  return () => statusChangeListeners.delete(listener);
}

/**
 * Fan an update to all global listeners, throw-isolated.
 *
 * @param build - The update, built only when someone listens.
 */
export function fanOutStatusChange(build: () => ProjectorStatusUpdate): void {
  if (statusChangeListeners.size === 0) return;
  const update = build();
  for (const listener of statusChangeListeners) {
    try {
      listener(update);
    } catch (err) {
      logger.warn('[SessionStateProjector] status-change listener threw', {
        sessionId: update.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
