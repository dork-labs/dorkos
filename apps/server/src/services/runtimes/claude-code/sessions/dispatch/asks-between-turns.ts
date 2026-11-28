/**
 * Asks raised while no turn is open on a warm process, and how they reach the
 * chat (DOR-2698).
 *
 * A background helper keeps working after the agent's reply ends, and on CLI
 * 0.3.304 its tool calls still reach DorkOS's approval gate (`canUseTool`, with
 * the helper's `agentID`). The card goes onto `session.eventQueue` and the
 * handler calls `session.eventQueueNotify`. Only a turn's stream reads that
 * queue, and it sets `eventQueueNotify` only while it runs, so between turns
 * the card sat unread: the chat looked idle, the session's state never showed
 * it, the helper waited until the wait ran out, and a person's next message
 * cleared the queue and the card with it.
 *
 * Two pieces close it:
 *
 * - {@link openTurnsForAsks} gives the session a between-turns notifier. While
 *   a turn's stream runs, its own notifier is used exactly as before; when none
 *   does, a queued ask opens a window for it (`SessionTurnWindows.openForAsk`),
 *   whose turn carries the card to the chat and the session's state. A turn's
 *   stream that ends with an ask still queued wakes it too
 *   (`pump-turn-stream.ts`), so an ask raised as a turn closes is not stranded
 *   behind that turn's `done`.
 * - {@link keptAsks} is what a new turn's fresh queue starts with: any ask
 *   still waiting on a person that no turn has shown yet, so a dispatch never
 *   silently drops one.
 *
 * @module services/runtimes/claude-code/sessions/dispatch/asks-between-turns
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { isInteractiveEvent } from '../../../shared/empty-stream-guard.js';
import type { AgentSession } from '../../agent-types.js';

/** The session fields this module reads and writes. */
type AskSession = Pick<AgentSession, 'eventQueue' | 'eventQueueNotify' | 'pendingInteractions'>;

/**
 * Whether this queued event waits on a person: an approval card, a question or
 * a form.
 *
 * A tool call's wait for a heavy-job slot (`LOAD_WAIT_STATUS`) is deliberately
 * not one. It is a status, nobody is being waited on, and the CLI writes no
 * frame until the slot frees, so a window opened for it would hold the session,
 * and a person's next message, for the whole wait. It stays on the queue for
 * the next turn to show.
 *
 * @param event - An event on the session's queue
 */
export function isAskEvent(event: StreamEvent): boolean {
  return isInteractiveEvent(event);
}

/** The open-a-window callback each session's notifier calls, swapped as its wiring is rebuilt. */
const openers = new WeakMap<AskSession, () => boolean>();

/**
 * Give `session` a notifier that opens a window for an ask raised while no
 * turn's stream is reading its queue.
 *
 * `eventQueueNotify` becomes an accessor: a turn's stream still sets and clears
 * its own notifier exactly as before, and reading it returns that one while it
 * is set. When none is set, it returns the between-turns notifier, which calls
 * `open` if the queue holds an ask. Installing again for the same session (a
 * relaunched process's new wiring) only swaps `open`.
 *
 * @param session - The session whose asks should reach the chat
 * @param open - Opens a window for the ask; answers false when it did not
 *   (one was already open, or this wiring is no longer the live one)
 */
export function openTurnsForAsks(session: AskSession, open: () => boolean): void {
  const installed = openers.has(session);
  openers.set(session, open);
  if (installed) return;
  let streaming = session.eventQueueNotify;
  const betweenTurns = (): void => {
    if (session.eventQueue.some(isAskEvent)) openers.get(session)?.();
  };
  Object.defineProperty(session, 'eventQueueNotify', {
    configurable: true,
    enumerable: true,
    get: () => streaming ?? betweenTurns,
    set: (notify: (() => void) | undefined) => {
      streaming = notify;
    },
  });
}

/**
 * The events a new turn's queue starts with: asks no turn has shown yet that
 * still wait on a person. Everything else on the old queue belonged to the
 * turn before and is dropped, as it always was.
 *
 * @param session - The session about to run a turn
 */
export function keptAsks(session: AskSession): StreamEvent[] {
  return session.eventQueue.filter((event) => {
    if (!isInteractiveEvent(event)) return false;
    const data = event.data as { toolCallId?: unknown; interactionId?: unknown };
    const id = data.toolCallId ?? data.interactionId;
    return typeof id === 'string' && session.pendingInteractions.has(id);
  });
}
