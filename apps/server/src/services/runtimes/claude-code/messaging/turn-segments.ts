/**
 * Multi-segment turn tracking (DOR-1149).
 *
 * A turn that spawns background tasks does not end at its first `result`. The
 * CLI closes the segment it was working on, then delivers each queued
 * `<task-notification>` as a fresh segment in the SAME query stream — which is
 * why one production turn ran for nine minutes across four cancellations
 * (session `32d40230`, 2026-08-11). Treating that first `result` as the end of
 * the turn is what killed phantom steering exactly where phantoms happen: the
 * corrective note's only channel is the held prompt stream, and closing it at
 * the first `result` makes every later `push()` a no-op.
 *
 * This module answers the one question the send loop needs: does the CLI still
 * owe us a segment? It counts background tasks from their SDK lifecycle
 * messages — `task_started` opens one, `task_notification` (completed / failed
 * / stopped) closes it — so a `result` arriving while any task is unreported is
 * a segment boundary, not the end of the turn.
 *
 * @module services/runtimes/claude-code/messaging/turn-segments
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * How many times one turn may keep the input stream open past a `result`.
 *
 * The deferral is bounded because the alternative failure is a deadlock, not a
 * leak: the send loop only reaches the `finally` that force-closes the stream
 * once the subprocess exits, and the subprocess only exits once the stream is
 * closed. A background task that never reports at all (a killed helper, a
 * crashed subagent) would otherwise hold both sides open forever. In practice a
 * turn owes one segment per task it spawned; on hitting this cap the loop
 * degrades to the old close-at-first-result behavior, which is survivable.
 */
export const MAX_DEFERRED_SEGMENT_CLOSES = 8;

/** Tracks whether a turn's stream still owes segments. */
export interface TurnSegments {
  /**
   * Feed every SDK message as it streams. Ignores everything that is not a
   * background-task lifecycle message.
   */
  observe: (message: SDKMessage) => void;
  /**
   * Whether the `result` just observed closes a mere segment rather than the
   * turn — in which case the caller must keep the held prompt open so a
   * corrective note can still reach the model.
   *
   * Records the deferral, so call it EXACTLY ONCE per `result` message.
   */
  holdOpenAtResult: () => boolean;
  /** How many background tasks have started but not yet reported. @internal Exported for testing only. */
  outstandingCount: () => number;
}

/** Lifecycle subtype that opens a background task. */
const TASK_STARTED = 'task_started';
/** Lifecycle subtype that closes one, whatever its outcome. */
const TASK_NOTIFICATION = 'task_notification';

/**
 * Create a per-turn segment tracker. One instance belongs to one
 * `executeSdkQuery` frame — background tasks never outlive their turn's stream.
 */
export function createTurnSegments(): TurnSegments {
  const outstanding = new Set<string>();
  let deferrals = 0;

  return {
    observe: (message) => {
      if (message.type !== 'system' || !('subtype' in message)) return;
      const { subtype } = message;
      if (subtype !== TASK_STARTED && subtype !== TASK_NOTIFICATION) return;
      // A lifecycle message without a task id tells us nothing to count; the
      // alternative — counting it under a placeholder key — would let one
      // malformed message pin the stream open to the cap.
      const taskId = (message as { task_id?: unknown }).task_id;
      if (typeof taskId !== 'string') return;
      if (subtype === TASK_STARTED) outstanding.add(taskId);
      else outstanding.delete(taskId);
    },
    holdOpenAtResult: () => {
      if (outstanding.size === 0) return false;
      if (deferrals >= MAX_DEFERRED_SEGMENT_CLOSES) return false;
      deferrals++;
      return true;
    },
    outstandingCount: () => outstanding.size,
  };
}
