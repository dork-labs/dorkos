/**
 * What the diagnostic read surface is told about one session's projector.
 *
 * A named contract rather than an inline return type, and its own module rather
 * than another entry in a 1,200-line file, because it is read from three sides:
 * the projector that fills it, the `/api/debug/sessions/:id` handler that
 * serialises it, and the CLI that renders it. All three should be able to see
 * the shape without opening the projector.
 *
 * Content-free by construction — every field is a count, a cursor, or a coarse
 * enum. The events themselves are never reachable from here: the buffers hold
 * message text, and this answers "how much" and "what state", never "what was
 * said".
 *
 * @module services/session/session-debug-counters
 */
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { ProjectorPersistenceMode } from './session-state-projector.js';

/** One projector's own bookkeeping, as the debug surface reports it. */
export interface SessionDebugCounters {
  /** The projected lifecycle: idle, streaming, blocked, error, interrupted. */
  lifecycle: SessionLifecycle;
  /** The seq of the latest ingested event — the stream's high-water mark. */
  seq: number;
  /** Active `subscribe()` generators — how many clients hold this stream. */
  subscribers: number;
  /** Of those, how many are parked awaiting the next event right now. */
  waiters: number;
  /** Events retained for gap replay. */
  eventLogSize: number;
  /** Events retained for the turn in progress. */
  ringSize: number;
  /** Whether completed turns are persisted, and what for. */
  persistence: ProjectorPersistenceMode | 'off';
}
