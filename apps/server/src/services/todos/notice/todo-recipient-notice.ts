/**
 * Tell whoever a promise was made to that its agent moved or dropped it, with the agent's reason
 * (DOR-3034). Before this the tool description only advised it.
 *
 * - A person hears it in the Inbox (`todo.changed`).
 * - An agent hears it as a message from the promising agent's chat.
 * - Someone outside the business (`external:<name>`) is not reachable from here; the agent's own
 *   reply to them is the way they hear it.
 *
 * Only an agent's own change is told. A person who moves or drops a promise already knows.
 *
 * @module services/todos/notice/todo-recipient-notice
 */
import { TODO_EXTERNAL_PREFIX, type TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import type { TodoChangePayloads } from './todo-change-notifications.js';
import { logger } from '../../../lib/logger.js';

/** One change to tell about. */
export interface TodoChangeNotice {
  /** The promise as it stands after the change. */
  todoPromise: TodoPromise;
  /** What happened to it. */
  change: 'moved' | 'dropped';
  /** The reason the agent gave with this change, or null. Never an older note left on the row. */
  reason: string | null;
  /** The chat the agent changed it from, when known: an agent recipient hears it from there. */
  sessionId?: string;
  /** The changing agent's home folder, when known. */
  agentPath?: string;
}

/** Who hears about a change. */
export type TodoRecipient = { kind: 'person' } | { kind: 'agent'; agentId: string } | null;

/** What the notice is built from. */
export interface TodoRecipientNoticeDeps {
  /** Whether an id is an agent on this team. */
  isAgent: (id: string) => boolean;
  /** An agent's name, or undefined when the team does not know it. */
  agentName: (id: string) => string | undefined;
  /** A date in the person's own words, on their clock ("Fri, Nov 20"). */
  dateWords: (iso: string) => string;
  /** Raise the Inbox event for a person. */
  notifyPerson: (payload: TodoChangePayloads['todo.changed']) => Promise<void> | void;
  /** Send one message from the promising agent's chat to another agent. */
  sendToAgent: (
    from: { sessionId: string; agentPath: string },
    toAgentId: string,
    text: string
  ) => Promise<void>;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/**
 * Who a promise's `to` names: a person, an agent on the team, or nobody this can reach.
 *
 * @param to - The stored recipient.
 * @param isAgent - Whether an id is an agent on this team.
 */
export function recipientOf(to: string | null, isAgent: (id: string) => boolean): TodoRecipient {
  if (!to || to.startsWith(TODO_EXTERNAL_PREFIX)) return null;
  if (isAgent(to)) return { kind: 'agent', agentId: to };
  return { kind: 'person' };
}

/**
 * The message an agent recipient reads.
 *
 * @param agentName - The promising agent's name.
 * @param notice - The change.
 */
export function agentNoticeText(agentName: string, notice: TodoChangeNotice): string {
  const { what, dueAt } = notice.todoPromise;
  const reason = notice.reason ? ` Why: ${notice.reason}` : ' No reason given.';
  if (notice.change === 'dropped') {
    return `${agentName} dropped the promise it made you: "${what}".${reason}`;
  }
  const when = dueAt ? `now due ${dueAt}` : 'now with no date';
  return `${agentName} moved the promise it made you: "${what}", ${when}.${reason}`;
}

/**
 * Build the teller.
 *
 * @param deps - How to reach a person and an agent.
 * @returns A function that tells about one change. It never throws: a notice that fails is logged.
 */
export function createTodoRecipientNotice(
  deps: TodoRecipientNoticeDeps
): (notice: TodoChangeNotice) => Promise<void> {
  const now = deps.now ?? (() => new Date());
  return async (notice) => {
    const { todoPromise } = notice;
    const recipient = recipientOf(todoPromise.to, deps.isAgent);
    // A promise to itself has nobody else to tell.
    if (!recipient || (recipient.kind === 'agent' && recipient.agentId === todoPromise.agentId)) {
      return;
    }
    const agentName = deps.agentName(todoPromise.agentId) ?? todoPromise.agentId;
    try {
      if (recipient.kind === 'person') {
        await deps.notifyPerson({
          todoId: todoPromise.id,
          agentId: todoPromise.agentId,
          agentName,
          what: todoPromise.what,
          change: notice.change,
          note: notice.reason,
          newDue:
            notice.change === 'moved' && todoPromise.dueAt
              ? deps.dateWords(todoPromise.dueAt)
              : null,
          at: now().toISOString(),
        });
        return;
      }
      if (!notice.sessionId || !notice.agentPath) return;
      await deps.sendToAgent(
        { sessionId: notice.sessionId, agentPath: notice.agentPath },
        recipient.agentId,
        agentNoticeText(agentName, notice)
      );
    } catch (err) {
      logger.warn('[to-dos] could not tell the recipient about a changed promise', {
        todoId: todoPromise.id,
        change: notice.change,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
