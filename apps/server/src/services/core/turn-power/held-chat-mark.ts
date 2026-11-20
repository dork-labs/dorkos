/**
 * A chat that took in words DorkOS cannot vouch for stays marked until the owner's own clean turn
 * (DOR-4515, Security's ruling). Its transcript keeps those words, so a later turn nobody newly
 * asked for (a scheduled run, a heartbeat, another chat's message) re-reads them. Each such turn
 * carries the outsider mark, which gates sends, raises, secrets and destructive actions and lowers
 * nothing else. Waiting never clears it.
 *
 * Only the dispatcher says a turn is the owner's own clean send (`isOwnersCleanSend`), once, by
 * the message id it minted for that send. No `MessageOpts` field carries the verdict, so a task,
 * a tool, a route or a relay cannot claim it by what it passes.
 *
 * Room turns are left as they are: a room turn's marks are worked out from the posts it answers,
 * and it sets and ends its own notes.
 *
 * @module services/core/turn-power/held-chat-mark
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { lastTurnHeld } from './continuation-hold.js';

/** How many vouched message ids are remembered, oldest dropped first. */
const MEMORY = 10_000;

/**
 * Message ids the dispatcher found to be the owner's own clean send, each with the chat it was
 * found for (under that chat's first id), waiting for their turn.
 */
const ownersCleanSends = new Map<string, string>();

/** The options objects of turns that are the owner's own clean send, as the seam handed them on. */
const ownersCleanTurns = new WeakSet<MessageOpts>();

/**
 * Note that the message about to launch in this chat is the owner's own clean send. Called by the
 * dispatcher alone, as it launches the message, with the id the runtime will be handed.
 *
 * @param messageId - The id the launching turn is sent with.
 * @param sessionId - The chat it launches in.
 */
export function noteOwnersCleanSend(messageId: string, sessionId: string): void {
  ownersCleanSends.delete(messageId);
  ownersCleanSends.set(messageId, primaryOf(sessionId));
  if (ownersCleanSends.size > MEMORY)
    ownersCleanSends.delete(ownersCleanSends.keys().next().value!);
}

/**
 * Drop any earlier verdict for a message whose launch now is not the owner's own clean send (a
 * relaunch after a pause held it to the default, say), so a verdict never outlives the launch it
 * was found for. Called by the dispatcher on every other launch.
 *
 * @param messageId - The id the launching turn is sent with.
 */
export function forgetOwnersCleanSend(messageId: string): void {
  ownersCleanSends.delete(messageId);
}

/**
 * The options a turn is started with: the outsider mark added when its chat is held and the turn
 * is not the owner's own clean send. Takes the dispatcher's verdict for the turn's message, so it
 * counts once. A continuation keeps the answer the last real turn gave, and is left alone.
 *
 * @param sessionId - The chat.
 * @param opts - The options the turn was sent with.
 */
export function withHeldChatMark(
  sessionId: string,
  opts: MessageOpts | undefined
): MessageOpts | undefined {
  const messageId = opts?.messageId;
  const vouchedFor = messageId === undefined ? undefined : ownersCleanSends.get(messageId);
  if (messageId !== undefined && vouchedFor !== undefined) {
    ownersCleanSends.delete(messageId);
    // Only in the chat it was found for: the same id sent anywhere else is not the owner's.
    if (vouchedFor === primaryOf(sessionId)) {
      const own = { ...opts };
      ownersCleanTurns.add(own);
      return own;
    }
  }
  if (opts?.continuationHold === true || opts?.roomTurn !== undefined) return opts;
  if (opts?.carriedMarks?.outsider === true || !lastTurnHeld(sessionId)) return opts;
  return { ...opts, carriedMarks: { ...opts?.carriedMarks, outsider: true } };
}

/**
 * Whether a turn's options are the owner's own clean send, as {@link withHeldChatMark} handed
 * them on. Only such a turn ends a read's mark an earlier turn left.
 *
 * @param opts - The options the seam received.
 */
export function isOwnersCleanTurn(opts: MessageOpts | undefined): boolean {
  return opts !== undefined && ownersCleanTurns.has(opts);
}

/** Forget every vouched send. For tests. */
export function resetHeldChatMarks(): void {
  ownersCleanSends.clear();
}
