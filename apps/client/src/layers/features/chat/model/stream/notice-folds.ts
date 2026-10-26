/**
 * Projection of the lasting notices a runtime's transcript never records: a
 * turn that ran on another model (DOR-2636), and the line a Stop leaves for
 * background commands it could not end (DOR-3285).
 *
 * The line usually arrives AFTER its turn, and each command's end arrives
 * later still, possibly once the line is already in history. So the ends are
 * folded over the WHOLE rendered list, not just the live turn, and the line
 * updates in place wherever it is drawn.
 *
 * @module features/chat/model/stream/notice-folds
 */
import type { MessagePart, WorkLeftEndStatus, WorkLeftRunningPart } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { ChatMessage } from '../chat-types';

/** The notice events {@link noticePart} turns into a part. */
type NoticeEvent = Extract<SessionEvent, { type: 'model_substituted' | 'work_left_running' }>;

/**
 * The part one notice event becomes.
 *
 * @param event - A `model_substituted` or `work_left_running` event.
 */
export function noticePart(event: NoticeEvent): MessagePart {
  if (event.type === 'work_left_running') {
    return {
      type: 'work_left_running',
      tasks: event.tasks.map((task) => ({ taskId: task.taskId, command: task.command })),
    };
  }
  return {
    type: 'model_substituted',
    from: event.from,
    fromName: event.fromName,
    to: event.to,
    toName: event.toName,
    reason: event.reason,
  };
}

/** The task ids a line names, as one key: a line is identified by what it lists. */
function lineKey(part: WorkLeftRunningPart): string {
  return part.tasks.map((task) => task.taskId).join('\u0000');
}

/** Whether a part is the line a Stop left. */
function isWorkLeft(part: MessagePart): part is WorkLeftRunningPart {
  return part.type === 'work_left_running';
}

/**
 * Fold every live `work_left_ended` into the line it belongs to, and drop a
 * live copy of a line history already draws.
 *
 * The live copy is the one the stream carried before history had the line
 * (`keptWorkLeft` in the session store); once a reload supplies it, both can
 * be on screen for a beat, and the history one is canonical. Never mutates:
 * history messages are shared with the store.
 *
 * @param messages - The rendered list, history first and the live turn last.
 * @param inProgressTurn - The live turn's events, read for `work_left_ended`.
 * @returns `messages` by reference when there is nothing to change.
 */
export function applyWorkLeftEnded(
  messages: ChatMessage[],
  inProgressTurn: readonly SessionEvent[]
): ChatMessage[] {
  const ends = new Map<string, WorkLeftEndStatus>();
  for (const event of inProgressTurn) {
    if (event.type === 'work_left_ended') ends.set(event.taskId, event.status);
  }
  const settled = new Set<string>();
  for (const message of messages) {
    if (message._streaming) continue;
    for (const part of message.parts) if (isWorkLeft(part)) settled.add(lineKey(part));
  }
  if (ends.size === 0 && settled.size === 0) return messages;
  let changed = false;
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (!message.parts.some(isWorkLeft)) {
      out.push(message);
      continue;
    }
    const parts = message.parts.flatMap((part): MessagePart[] => {
      if (!isWorkLeft(part)) return [part];
      if (message._streaming && settled.has(lineKey(part))) return [];
      if (!part.tasks.some((task) => !task.ended && ends.has(task.taskId))) return [part];
      return [
        {
          ...part,
          tasks: part.tasks.map((task) => {
            const ended = task.ended ?? ends.get(task.taskId);
            return ended ? { ...task, ended } : task;
          }),
        },
      ];
    });
    if (parts.length === message.parts.length && parts.every((p, i) => p === message.parts[i])) {
      out.push(message);
      continue;
    }
    changed = true;
    if (parts.length > 0) out.push({ ...message, parts });
  }
  return changed ? out : messages;
}
