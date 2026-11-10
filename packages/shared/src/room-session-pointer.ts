/**
 * The words in a session-pointer notice that send the reader there — "Open
 * Ana's chat". A client turns exactly these words into the link, so the line
 * says it once rather than once as a sentence and again as a button. The
 * server's notice-copy test holds every notice in
 * {@link SESSION_POINTER_NOTICE_CODES} to containing them.
 *
 * Built from the agent's name rather than matched by pattern, because a notice
 * STARTS with that name: an agent called "Open Interpreter" would otherwise have
 * the link begin at the first word of the sentence.
 *
 * @param agentName - The display name the notice was written with.
 */
export function sessionPointerPhrase(agentName: string): string {
  return `Open ${agentName}'s chat`;
}

/**
 * The same words when the agent's name is not known to the reader (it left the
 * roster, or was renamed after the notice was written). Looser than
 * {@link sessionPointerPhrase} and used only in its place. It also matches
 * "session", the word notices written before DOR-2789 used, because those
 * lines stay in the room log as they were written.
 */
export const SESSION_POINTER_PATTERN = /Open .+?'s (?:chat|session)/;
