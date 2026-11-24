import { browserRefusalCode } from '@/layers/entities/local-browser';
import type { LocalBrowserHandoff, LocalBrowserSignIn } from '@dorkos/shared/local-browser';

/**
 * What the card asks of the person right now.
 *
 * - `person`: finish in the detached native view, then Continue.
 * - `wall`: finish the check in the window, then Continue.
 * - `sign-in`: the page asks for a password, so offer the plain window.
 * - `sign-in-open`, `saving`, `saved`, `failed`: where that plain window has got to.
 * - `window-closed`: the agent's window is gone, so there's nowhere to finish.
 */
export type HandoffStep =
  'person' | 'wall' | 'sign-in' | 'sign-in-open' | 'saving' | 'saved' | 'failed' | 'window-closed';

/**
 * Work out the card's step. A sign-in counts only if it's for this handoff's site
 * and started after the agent asked, so an old one can't read as "Signed in".
 *
 * @param handoff - The open handoff.
 * @param signIn - The latest sign-in window, if any.
 * @param hasWindow - Whether the agent's window is open. Signing in can close it on
 *   purpose: Continue brings it back once the sign-in is saved.
 */
export function handoffStep(
  handoff: LocalBrowserHandoff,
  signIn: LocalBrowserSignIn | null | undefined,
  hasWindow = true,
  embedded = false
): HandoffStep {
  const ours =
    signIn &&
    signIn.site === handoff.site &&
    Date.parse(signIn.startedAt) >= Date.parse(handoff.askedAt);
  if (ours && signIn.status !== 'failed')
    return signIn.status === 'open' ? 'sign-in-open' : signIn.status;
  // A site that refused the in-app browser can't be finished there (DOR-4097).
  if (embedded && hasWindow) return handoff.refused ? 'sign-in' : 'person';
  if (!hasWindow) return 'window-closed';
  if (ours) return 'failed';
  return handoff.reason === 'wall' ? 'wall' : 'sign-in';
}

/**
 * Codes the browser routes answer with a sentence written for a person: the
 * server words every browser refusal itself (`routes/local-browser.ts`).
 * Anything else gets the card's plain message.
 */
const PERSON_READABLE_CODES: ReadonlySet<string> = new Set([
  'signing_in',
  'history_refused',
  'precondition_failed',
  'conflict',
]);

/**
 * What to tell the person when a button's call fails.
 *
 * @param cause - The error the transport threw.
 */
export function handoffErrorMessage(cause: unknown): string {
  const code = browserRefusalCode(cause);
  const message = (cause as { message?: string } | null)?.message;
  if (code && message && PERSON_READABLE_CODES.has(code)) return message;
  return 'Couldn’t reach the browser. Try again.';
}
