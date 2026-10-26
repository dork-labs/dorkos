/**
 * The lasting notices a runtime's transcript never records, mapped from their
 * `StreamEvent` into the session stream: a turn that ran on another model
 * (DOR-2636), and background commands a Stop could not end (DOR-3285).
 *
 * Its own module so `session-event-normalizer.ts` stays within the size rule.
 * Each one is forwarded whole, because the event is the only lasting record
 * of what it says.
 *
 * @module services/session/turn-stream/notice-events
 */
import type { StreamEvent, WorkLeftEndStatus } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { RawSessionEvent } from '../session-state-projector.js';

/** A `StreamEvent`'s `data` payload, read defensively as a loose record. */
type StreamData = Record<string, unknown>;

/** The `seq`-less shape of one {@link SessionEvent} member. */
type RawOf<T extends SessionEvent['type']> = Omit<Extract<SessionEvent, { type: T }>, 'seq'>;

/** The three ways a left-running command can end; anything else reads as stopped. */
const END_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);

/** Read one `{ taskId, command }` entry, dropping anything without a task id. */
function toWorkLeftTasks(raw: unknown): RawOf<'work_left_running'>['tasks'] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const task = (entry ?? {}) as StreamData;
    if (typeof task.taskId !== 'string' || task.taskId === '') return [];
    return [{ taskId: task.taskId, command: typeof task.command === 'string' ? task.command : '' }];
  });
}

/**
 * Map a notice `StreamEvent` to its session event, or `null` for any other
 * type.
 *
 * @param event - A DorkOS `StreamEvent` whose type is one of the notices.
 */
export function toNoticeEvent(event: StreamEvent): RawSessionEvent | null {
  const data = (event.data ?? {}) as StreamData;
  switch (event.type) {
    case 'model_substituted': {
      const substituted: RawOf<'model_substituted'> = {
        type: 'model_substituted',
        from: String(data.from ?? ''),
        fromName: String(data.fromName ?? data.from ?? ''),
        to: String(data.to ?? ''),
        toName: String(data.toName ?? data.to ?? ''),
        reason: 'credits-not-covered',
      };
      return substituted;
    }
    case 'work_left_running': {
      const running: RawOf<'work_left_running'> = {
        type: 'work_left_running',
        tasks: toWorkLeftTasks(data.tasks),
      };
      return running.tasks.length > 0 ? running : null;
    }
    case 'work_left_ended': {
      if (typeof data.taskId !== 'string' || data.taskId === '') return null;
      const status = String(data.status ?? '');
      const ended: RawOf<'work_left_ended'> = {
        type: 'work_left_ended',
        taskId: data.taskId,
        status: END_STATUSES.has(status) ? (status as WorkLeftEndStatus) : 'stopped',
      };
      return ended;
    }
    default:
      return null;
  }
}
