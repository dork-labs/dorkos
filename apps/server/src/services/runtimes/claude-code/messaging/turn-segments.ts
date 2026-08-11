/**
 * Multi-segment turn tracking (DOR-1149).
 *
 * A turn that runs background tasks does not end at its first `result`. When a
 * task settles, the CLI queues its `<task-notification>`, closes the segment it
 * was working on, and then delivers that notification as a NEW segment in the
 * SAME query stream. Phantom cancellations land in those delivery segments —
 * which is why steering was dead exactly where it was needed: closing the held
 * prompt at the first `result` makes every later `push()` a no-op.
 *
 * What this module counts is the thing that has to survive: **notifications
 * owed a delivery**. A `system/task_notification` says a task settled, so a
 * delivery is now owed; the `<task-notification>` user message that follows is
 * that delivery arriving. Between those two the input stream must stay open.
 *
 * Counting RUNNING TASKS instead — opening on `task_started`, closing on
 * `task_notification` — looks equivalent and is not. The settle precedes the
 * segment-ending `result` (observed 6 ms before it in session `32d40230`), so a
 * turn with a single background task would have zero tasks outstanding at the
 * very `result` that needed deferring, and the fix would miss the commonest
 * shape entirely. It also inherited a failure this keying does not have: a task
 * that starts and never reports (a killed helper, a detached `nohup`) would
 * have pinned the stream open, whereas a task that never settles simply never
 * owes a delivery here. That is also why `task_updated` / `killed` needs no
 * handling, and why the SDK's `background_tasks_changed` level signal — the
 * right tool for "is background work running" — is not what this needs.
 *
 * @module services/runtimes/claude-code/messaging/turn-segments
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * How many times one turn may hold its input stream open past a `result`.
 *
 * A deferral resolves as soon as the owed notification is delivered, which is
 * normally immediate. This bounds the pathological case — a notification that
 * settles but is never delivered — so a turn can never defer without end.
 */
export const MAX_DEFERRED_SEGMENT_CLOSES = 8;

/**
 * Deadline for a single deferral, measured from the `result` that deferred.
 *
 * A DEADLINE, deliberately, not an idle timer. An idle timer is re-armed by any
 * message, so unrelated `task_progress` frames from other still-running tasks
 * would keep pushing it back and the bound it was supposed to provide would
 * never arrive. Measured from the deferral, the wait is bounded no matter how
 * chatty the stream is.
 *
 * The window this protects is normally sub-second — the gap between a task
 * settling and its notification being delivered. Expiring early costs only the
 * steering opportunity: the turn then behaves exactly as it did before
 * DOR-1149, never worse.
 */
export const DEFERRED_CLOSE_TIMEOUT_MS = 30_000;

/** Tracks whether a turn's stream still owes a queued-notification segment. */
export interface TurnSegments {
  /**
   * Feed every SDK message as it streams. Ignores everything that is neither a
   * task settling nor a notification being delivered.
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
  /** How many settled notifications have not yet been delivered. */
  owedCount: () => number;
}

/** Lifecycle subtype announcing that a background task has settled. */
const TASK_NOTIFICATION = 'task_notification';

/** Opening tag of the notification the CLI injects as a user message. */
const NOTIFICATION_TAG = '<task-notification>';

/** Pulls every `<task-id>…</task-id>` out of a delivered notification. */
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/g;

/**
 * Flatten an SDK message's content to text. The CLI's notification arrives as
 * plain text on some paths and as text blocks on others.
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join('\n');
}

/**
 * Create a per-turn segment tracker. One instance belongs to one
 * `executeSdkQuery` frame — a turn's owed deliveries never outlive its stream.
 */
export function createTurnSegments(): TurnSegments {
  const owed = new Set<string>();
  let deferrals = 0;

  return {
    observe: (message) => {
      if (
        message.type === 'system' &&
        'subtype' in message &&
        message.subtype === TASK_NOTIFICATION
      ) {
        const taskId = (message as { task_id?: unknown }).task_id;
        // An unidentifiable settle cannot be matched to its delivery, so
        // counting it would only risk deferring to the deadline for nothing.
        if (typeof taskId === 'string') owed.add(taskId);
        return;
      }
      if (message.type !== 'user' || owed.size === 0) return;
      const text = contentText((message as { message?: { content?: unknown } }).message?.content);
      if (!text.includes(NOTIFICATION_TAG)) return;
      const delivered = [...text.matchAll(TASK_ID_RE)].map((m) => m[1]);
      // A delivery whose id we cannot parse still proves the queue drained, so
      // clear the whole set rather than wait out the deadline on a wording
      // change upstream.
      if (delivered.length === 0) owed.clear();
      else for (const id of delivered) owed.delete(id);
    },
    holdOpenAtResult: () => {
      if (owed.size === 0) return false;
      if (deferrals >= MAX_DEFERRED_SEGMENT_CLOSES) return false;
      deferrals++;
      return true;
    },
    owedCount: () => owed.size,
  };
}
