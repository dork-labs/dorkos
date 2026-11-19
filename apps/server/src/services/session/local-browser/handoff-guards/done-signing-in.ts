/**
 * Done signing in (DOR-4731). On a Mac, closing Chrome's last window leaves Chrome running,
 * so DorkOS never sees a sign-in window close and the sign-in would stay open forever. The
 * person's Done signing in quits that window instead; once it saves, the handoff it answers
 * is handed back as Continue would. The handover decides WHEN; this holds the rules.
 *
 * @module services/session/local-browser/handoff-guards/done-signing-in
 */
import type { LocalBrowserHandoff, LocalBrowserSignIn } from '@dorkos/shared/local-browser';
import { logger } from '../../../../lib/logger.js';
import { LocalBrowserError } from '../errors.js';

/**
 * What an agent is told while a person's sign-in window is open. Only the person can end
 * it, with Done signing in, so the agent is told to ask them, never to retry.
 */
export const SIGNING_IN_REFUSAL = 'A sign-in window is still open. Ask the person to finish it.';

/** The refusal every agent call gets while a sign-in window holds its browser. */
export function signingInRefusal(): LocalBrowserError {
  return new LocalBrowserError('signing_in', SIGNING_IN_REFUSAL);
}

/**
 * Whether a sign-in is the handoff's own: its site, started after the agent asked.
 *
 * @param signIn - The latest sign-in window, if any.
 * @param handoff - The open handoff.
 */
export function isOwnSignIn(
  signIn: LocalBrowserSignIn | null,
  handoff: LocalBrowserHandoff
): signIn is LocalBrowserSignIn {
  return (
    !!signIn &&
    signIn.site === handoff.site &&
    Date.parse(signIn.startedAt) >= Date.parse(handoff.askedAt)
  );
}

/**
 * What Done signing in does for an open handoff: hand back now when its sign-in already
 * saved, or quit the window and hand back once it saves. Anything else is refused: another
 * site's window, no window, or a failed save, which the card answers with Try again.
 *
 * @param signIn - The latest sign-in window, if any.
 * @param active - Whether a sign-in window is open or saving.
 * @param handoff - The open handoff the person answered.
 */
export function doneStep(
  signIn: LocalBrowserSignIn | null,
  active: boolean,
  handoff: LocalBrowserHandoff
): 'hand-back' | 'quit' {
  const ours = isOwnSignIn(signIn, handoff);
  if (!ours && active) throw new LocalBrowserError('signing_in', 'Finish the other sign-in first.');
  if (!ours || signIn.status === 'failed')
    throw new LocalBrowserError(
      'sign_in_failed',
      'Couldn’t save your sign-in. Open the sign-in window again.'
    );
  return signIn.status === 'saved' ? 'hand-back' : 'quit';
}

/**
 * The one handoff whose Done signing in waits on its window's save. It is handed back once,
 * and only if that save landed while it was still open. Stop and the handoff's end clear it.
 */
export class PendingHandBack {
  private waiting: string | null = null;

  /** Wait on the window's save for this handoff. Set before the quit, so an instant save finds it. */
  arm(handoffId: string): void {
    this.waiting = handoffId;
  }

  /** Stop waiting, for this handoff or for any. */
  clear(handoffId?: string): void {
    if (handoffId === undefined || this.waiting === handoffId) this.waiting = null;
  }

  /**
   * The handoff to hand back now, or null: once the window leaves open and saving, the wait
   * ends either way, and only a save for the handoff still open hands back.
   *
   * @param status - The sign-in window's status now.
   * @param openHandoffId - The handoff still open, if any.
   */
  settle(status: LocalBrowserSignIn['status'] | undefined, openHandoffId: string | null) {
    const waiting = this.waiting;
    if (!waiting || status === 'open' || status === 'saving') return null;
    this.waiting = null;
    return status === 'saved' && openHandoffId === waiting ? waiting : null;
  }
}

/**
 * Log a hand back after Done signing in that the handover refused. Never throws.
 *
 * @param handoffId - The handoff it tried to hand back.
 * @param error - Why it couldn't.
 */
export function logHandBackFailure(handoffId: string, error: unknown): void {
  logger.warn('[Browser] Couldn’t hand back after Done signing in', {
    handoffId,
    code: (error as { code?: string } | null)?.code,
  });
}
