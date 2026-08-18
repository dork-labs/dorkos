/**
 * Turn a refused approval decision into something a person can act on.
 *
 * ## Why this exists at all
 *
 * The server writes careful, specific sentences for every way a decision can be
 * refused, and `fetchJSON` carries both the sentence and its code onto the thrown
 * error. The global mutation handler in `query-client.ts` then replaces all of it
 * with "Action failed. Please try again." That is merely unhelpful for most
 * refusals and actively wrong for one of them.
 *
 * `STANDING_PERMISSION_NOT_RECORDED` is the case that forces the issue. It is a
 * 500, so it looks like a failure, and it is not one: **the destructive action was
 * allowed and will run.** Only the permission to stop asking was not recorded.
 * Telling a person "Action failed. Please try again." about an irreversible action
 * that succeeded invites them to do it twice, which is the worst thing this whole
 * feature could cause. Spec §3.5 is explicit that a caller who asked for two things
 * is told which one failed; this is the surface that was supposed to tell them.
 *
 * @module shared/lib/decision-refusal
 */

/** How loudly a refusal should read. */
export type RefusalTone = 'error' | 'warning';

/** What a surface should say about a refused decision. */
export interface DecisionRefusal {
  /** The sentence to show. The server's own wording when it sent one. */
  message: string;
  /**
   * `warning` when something DID happen and the person needs to know what.
   * `error` when nothing happened.
   */
  tone: RefusalTone;
}

/** The one code where the action ran and only the permission failed. */
const PARTIAL_SUCCESS_CODE = 'STANDING_PERMISSION_NOT_RECORDED';

/**
 * Codes whose server sentence is already the right thing to show a person.
 *
 * Listed rather than "show the message for every code", because a code that is not
 * here has not been read by anyone and its wording has not been checked against the
 * `writing-for-humans` bar. An unrecognised refusal falls back to a plain sentence
 * of our own rather than piping raw server text at somebody.
 */
const SHOW_SERVER_MESSAGE = new Set([
  // Asked for a standing permission with Require login off.
  'standing_grants_require_login',
  // Asked for one from something that is not a signed-in person.
  'operator_cookie_required',
  // Asked for one while the master switch is off.
  'STANDING_GRANTS_DISABLED',
  // Asked for one on a request DorkOS cannot attribute to an agent.
  'APPROVAL_HAS_NO_AGENT',
  // The request was already decided, or its window closed, while the card was up.
  'APPROVAL_NOT_PENDING',
  'APPROVAL_EXPIRED',
  'UNKNOWN_APPROVAL',
]);

/**
 * Describe a refused decision.
 *
 * @param error - Whatever the mutation rejected with.
 * @param askedForStanding - Whether the person asked to stop being asked.
 * @returns The sentence to show and how loudly.
 */
export function describeDecisionRefusal(
  error: unknown,
  askedForStanding: boolean
): DecisionRefusal {
  const code = (error as { code?: string } | null)?.code;
  const serverMessage = error instanceof Error ? error.message : '';

  if (code === PARTIAL_SUCCESS_CODE) {
    return {
      // A warning, never an error: the action went ahead. Saying "failed" here
      // would invite somebody to repeat something that cannot be undone.
      tone: 'warning',
      message:
        serverMessage ||
        'DorkOS allowed this one action, but could not record the permission to stop asking. The agent will ask again next time.',
    };
  }

  if (code && SHOW_SERVER_MESSAGE.has(code) && serverMessage) {
    return { tone: 'error', message: serverMessage };
  }

  return {
    tone: 'error',
    message: askedForStanding
      ? 'DorkOS could not answer that. Nothing was allowed and no permission was created.'
      : 'DorkOS could not record your answer. Nothing was allowed.',
  };
}
