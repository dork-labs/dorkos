/**
 * Turn a refused approval decision into something a person can act on.
 *
 * ## Why this exists at all
 *
 * The server writes careful, specific sentences for every way a decision can be
 * refused, and `fetchJSON` carries both the sentence and its code onto the thrown
 * error. The global mutation handler in `query-client.ts` then replaces all of it
 * with "Action failed. Please try again." That is unhelpful for a refusal whose
 * reason the person can act on, like an answer that came too late or an Always
 * allow the request does not offer.
 *
 * Every refusal here means nothing was allowed. The grant route checks every
 * reason to refuse before it grants, and when an Always allow cannot be saved it
 * allows nothing at all (spec `agent-permissions` D7), so no refusal ever has to
 * say "it went ahead anyway".
 *
 * @module shared/lib/decision-refusal
 */

/** What a surface should say about a refused decision. */
export interface DecisionRefusal {
  /** The sentence to show. The server's own wording when it sent one. */
  message: string;
}

/**
 * Codes whose server sentence is already the right thing to show a person.
 *
 * Listed rather than "show the message for every code", because a code that is not
 * here has not been read by anyone and its wording has not been checked against the
 * `writing-for-humans` bar. An unrecognised refusal falls back to a plain sentence
 * of our own rather than piping raw server text at somebody.
 */
const SHOW_SERVER_MESSAGE = new Set([
  // Answered by something that is not a signed-in person while login is on.
  'operator_cookie_required',
  // Always allow on a request that does not offer it.
  'ALWAYS_NOT_OFFERED',
  // Always allow could not be saved, so nothing was allowed.
  'ALWAYS_ALLOW_NOT_RECORDED',
  // The request was already decided, or its window closed, while the card was up.
  'APPROVAL_NOT_PENDING',
  'APPROVAL_EXPIRED',
  'UNKNOWN_APPROVAL',
]);

/**
 * Describe a refused decision.
 *
 * @param error - Whatever the mutation rejected with.
 * @param askedForAlways - Whether the person answered Always allow.
 * @returns The sentence to show.
 */
export function describeDecisionRefusal(error: unknown, askedForAlways: boolean): DecisionRefusal {
  const code = (error as { code?: string } | null)?.code;
  const serverMessage = error instanceof Error ? error.message : '';

  if (code && SHOW_SERVER_MESSAGE.has(code) && serverMessage) {
    return { message: serverMessage };
  }

  return {
    message: askedForAlways
      ? 'DorkOS could not answer that. Nothing was allowed and nothing was changed.'
      : 'DorkOS could not record your answer. Nothing was allowed.',
  };
}
