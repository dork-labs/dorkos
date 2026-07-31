/**
 * Saying "I turned someone away" once per chat, instead of never or endlessly.
 *
 * An access rule that silently drops messages is indistinguishable, from the
 * outside, from a bot that is broken — and the moment it bites is usually right
 * after setup, when the allowlist is still empty. Both chat adapters used to
 * drop at `debug`, which nobody has on, so the common first experience of a new
 * integration was silence with no explanation anywhere.
 *
 * Warning per message is not the answer either: one person retrying, or one
 * chatty group, would drown the log and give an unauthenticated stranger a way
 * to fill an operator's disk. So the rule is **once per chat**: the first time a
 * conversation is turned away it is explained in full, and after that it is
 * quiet.
 *
 * Held per adapter instance, never module-level, so stopping one integration
 * cannot reset (or silence) another's notices — the same rule the sibling
 * inbound caches follow.
 *
 * @module relay/adapters/denied-chat-notices
 */

/**
 * How many distinct chats are remembered before the oldest is forgotten.
 *
 * A bound, because the keys come from strangers: without one, anybody able to
 * message the bot could grow this map by opening new chats. The cost of the
 * bound is that a chat turned away, then displaced by {@link MAX_REMEMBERED}
 * other chats, is explained a second time — which is the harmless direction.
 */
const MAX_REMEMBERED = 200;

/** One adapter instance's record of which chats have already been explained. */
export interface DeniedChatNotices {
  /** Chat keys already reported, in insertion order (oldest first). */
  readonly reported: Set<string>;
}

/** Create an empty notice record for a single adapter instance. */
export function createDeniedChatNotices(): DeniedChatNotices {
  return { reported: new Set<string>() };
}

/**
 * Whether this chat's rejection should be reported now.
 *
 * Returns `true` the first time it sees a chat and `false` afterwards, so the
 * caller can log unconditionally and let this decide.
 *
 * @param notices - The adapter instance's notice record.
 * @param chatKey - A stable key for the conversation being turned away.
 * @returns `true` when the caller should write the log line.
 */
export function shouldReportDeniedChat(notices: DeniedChatNotices, chatKey: string): boolean {
  if (notices.reported.has(chatKey)) return false;
  if (notices.reported.size >= MAX_REMEMBERED) {
    // Sets iterate in insertion order, so the first key is the oldest.
    const oldest = notices.reported.keys().next().value;
    if (oldest !== undefined) notices.reported.delete(oldest);
  }
  notices.reported.add(chatKey);
  return true;
}
