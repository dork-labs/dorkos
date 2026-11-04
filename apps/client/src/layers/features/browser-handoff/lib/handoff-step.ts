import type {
  LocalBrowserHandoff,
  LocalBrowserMode,
  LocalBrowserSignIn,
} from '@dorkos/shared/local-browser';

/**
 * What the card asks of the person right now.
 *
 * - `wall`: finish the check in the agent's window, then Continue.
 * - `sign-in`: the page asks for a password, so offer the plain window.
 * - `panel-sign-in`: the same, in the Mac app's built-in browser. Its cookies live in the app's
 *   own store, so a plain window's sign-in wouldn't reach it, and it has a debugging channel,
 *   so nobody is told to type a password there. The card says so and offers only Stop task.
 * - `sign-in-open`, `saving`, `saved`, `failed`: where that plain window has got to.
 */
export type HandoffStep =
  'wall' | 'sign-in' | 'panel-sign-in' | 'sign-in-open' | 'saving' | 'saved' | 'failed';

/**
 * Work out the card's step. A sign-in counts only if it's for this handoff's site
 * and started after the agent asked, so an old one can't read as "Signed in".
 *
 * @param handoff - The open handoff.
 * @param signIn - The latest sign-in window, if any.
 * @param mode - How the browser is running.
 */
export function handoffStep(
  handoff: LocalBrowserHandoff,
  signIn: LocalBrowserSignIn | null | undefined,
  mode: LocalBrowserMode | null | undefined
): HandoffStep {
  if (handoff.reason === 'wall') return 'wall';
  if (mode === 'embedded') return 'panel-sign-in';
  const ours =
    signIn &&
    signIn.site === handoff.site &&
    Date.parse(signIn.startedAt) >= Date.parse(handoff.askedAt);
  if (!ours) return 'sign-in';
  return signIn.status === 'open' ? 'sign-in-open' : signIn.status;
}

/** Server refusals written for a person. Anything else gets the card's plain message. */
const PERSON_READABLE_REFUSALS: ReadonlySet<string> = new Set([
  'handoff_ended',
  'signing_in',
  'site_changed',
  'profile_busy',
  'sign_in_failed',
  'no_tab',
  'unsupported',
]);

/**
 * What to tell the person when a button's call fails.
 *
 * @param cause - The error the transport threw.
 */
export function handoffErrorMessage(cause: unknown): string {
  const error = cause as { code?: string; message?: string } | null;
  if (error?.code && error.message && PERSON_READABLE_REFUSALS.has(error.code))
    return error.message;
  return 'Couldn’t reach the browser. Try again.';
}
