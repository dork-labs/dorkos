/**
 * The one event the to-do tools raise when an agent makes a to-do or a promise
 * from a chat's turn (DOR-5266), so the work graph can record that the chat
 * produced it without this domain importing it. Startup's composition root
 * subscribes the work graph (`startup/steps/work-graph.ts`).
 *
 * ## The chat comes from server-held state only
 *
 * Never from a tool's input or a request body. A call names its chat in up to
 * two ways, both set by the server: the in-session server's live session
 * (`context.sessionId`, which only the in-session surface sets) and the chat a
 * live process holding the caller's agent token runs (`identity.chatId`,
 * `core/agent-identity/token-chats.ts`). An inactive token names none. A
 * person's to-do or promise, made in the app or over HTTP, names no chat and
 * raises nothing.
 *
 * @module services/todos/links/todo-made-in-chat
 */
import { logger } from '../../../lib/logger.js';

/** A to-do or a promise an agent made from a chat's turn. */
export interface TodoMadeInChat {
  /**
   * Every id the server holds for the chat the call was made from: the live
   * session's and the token's, when both are set. They name one chat (maybe
   * under ids a re-key joined); the listener decides what to record when they
   * do not.
   */
  chatIds: readonly string[];
  /** The to-do's id (a promise is a to-do too). */
  todoId: string;
}

/** What a call's server-held facts are read from: the capability context's own fields. */
export interface TodoCallFacts {
  /** The live session the in-session server set, when the call came through it. */
  readonly sessionId?: string;
  /** The verified identity, when an agent token was presented. */
  readonly identity?: { readonly chatId?: string; readonly inactive?: unknown };
}

const listeners = new Set<(event: TodoMadeInChat) => void>();

/**
 * Hear each to-do or promise an agent makes from a chat's turn, once it is
 * stored. A listener that throws is logged and never fails the create.
 *
 * @param listener - Called once per new to-do made from a chat.
 * @returns A function that stops listening.
 */
export function onTodoMadeInChat(listener: (event: TodoMadeInChat) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tell every listener that the call behind `facts` made `todoId`, when the
 * server knows the chat it was made from. Nothing is raised for a call with no
 * chat. Never throws.
 *
 * @param facts - The capability context of the call that made it.
 * @param todoId - The new to-do's id.
 */
export function announceTodoMadeInChat(facts: TodoCallFacts, todoId: string): void {
  const tokenChat = facts.identity && !facts.identity.inactive ? facts.identity.chatId : undefined;
  const chatIds = [...new Set([facts.sessionId, tokenChat].filter((id): id is string => !!id))];
  if (chatIds.length === 0) return;
  for (const listener of listeners) {
    try {
      listener({ chatIds, todoId });
    } catch (err) {
      logger.warn('[todos] a to-do listener failed; the to-do stands', {
        todoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
