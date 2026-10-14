/**
 * The history a settled turn adds, read as a tail instead of the whole chat.
 *
 * The end-of-turn reconcile used to reload the whole history after every turn
 * and replace what the store held with it: a long chat paid for every message
 * it had ever had, every turn (DOR-2890). Everything before the newest person's
 * message the store holds is settled, so the reload names that message
 * (`since`) and gets it back with the turn that followed it, and the store
 * keeps the rest as it was. That keeps the history a windowed snapshot left the
 * store with, too, where a whole reload would have replaced it.
 *
 * Anchored on a USER message on purpose: Claude Code merges an assistant reply
 * that is still growing (a wake-up continuation, a turn that paused on an
 * approval) and renames it after its newest record, so an assistant anchor goes
 * missing exactly when a turn ran long. A user message keeps its id.
 *
 * @module features/chat/lib/turn-history
 */
import type { HistoryMessage, HistoryRead } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';

/**
 * Join a history read onto what the store holds.
 *
 * A whole read replaces. A tail replaces from its first message, which is the
 * anchor the read named, to the end; everything before it is kept as it was.
 *
 * @param held - The history the store holds now.
 * @param read - The server's answer.
 * @returns The joined history, or `null` when a tail no longer lines up with
 *   what the store holds (it lost the anchor while the read was out).
 */
export function joinHistory(held: HistoryMessage[], read: HistoryRead): HistoryMessage[] | null {
  if (!read.tail) return read.messages;
  const anchor = read.messages[0]?.id;
  const at = anchor === undefined ? -1 : held.findIndex((message) => message.id === anchor);
  return at === -1 ? null : [...held.slice(0, at), ...read.messages];
}

/**
 * Read the history a settled turn needs: the tail from the newest person's
 * message the store holds, joined on, or the whole history when there is no
 * such message or the tail no longer lines up.
 *
 * @param transport - Where to read from.
 * @param sessionId - The session whose turn settled.
 * @param cwd - The directory its reads name, if any.
 * @param getHeld - The store's current history, asked before the read and
 *   again when it lands, since a snapshot may replace it meanwhile.
 */
export async function readTurnHistory(
  transport: Pick<Transport, 'getMessages'>,
  sessionId: string,
  cwd: string | undefined,
  getHeld: () => HistoryMessage[]
): Promise<HistoryMessage[]> {
  const since = newestUserMessageId(getHeld());
  if (since !== undefined) {
    const read = await transport.getMessages(sessionId, cwd, { since });
    // The store as it is NOW, after the read: a snapshot may have replaced it.
    const joined = joinHistory(getHeld(), read);
    if (joined) return joined;
  }
  return (await transport.getMessages(sessionId, cwd)).messages;
}

/** The id of the newest message the person sent, or undefined when none is held. */
function newestUserMessageId(history: HistoryMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'user') return history[i]!.id;
  }
  return undefined;
}
