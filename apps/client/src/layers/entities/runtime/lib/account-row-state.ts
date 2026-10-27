import type { AccountSigninIdentityView } from '@dorkos/shared/runtime-connect';
import type { AccountUsage } from '@dorkos/shared/account-usage';

/**
 * The one thing a Claude account row says about its sign-in, with the one
 * action that goes with it. Two features feed it — the login identity review
 * (DOR-3245) and the signed-out recovery (#3180) — so a row never shows two
 * status lines or two sign-in buttons.
 */
export type AccountRowState =
  /** On the Never use list (an excluded folder or organization). No action. */
  | { kind: 'blocked' }
  /** Signed in as someone other than the confirmed account. Action: Use this account. */
  | { kind: 'changed'; email?: string; previousEmail?: string }
  /**
   * Paused until the owner acts. `unconfirmed` is a new login the owner has
   * not accepted yet, so its action is Use this account (signing in again
   * would not bind it); `unreadable` is a sign-in DorkOS could not read, so its
   * action is Sign in again.
   */
  | { kind: 'paused'; reason: 'unconfirmed' | 'unreadable'; email?: string }
  /** The sign-in ran out. Action: Sign in. */
  | { kind: 'signed-out' }
  /** Nothing to say: the row stays quiet. */
  | { kind: 'healthy' };

/**
 * Pick a row's sign-in state, most urgent first: blocked, changed, paused,
 * signed out, healthy.
 *
 * @param input.identity - The owner-only identity review, when this viewer can see it.
 * @param input.signInState - The usage probe's signed-in reading.
 */
export function accountRowState(input: {
  identity?: AccountSigninIdentityView;
  signInState?: AccountUsage['signInState'];
}): AccountRowState {
  const { identity, signInState } = input;
  switch (identity?.state) {
    case 'never-use':
    case 'blocked':
      return { kind: 'blocked' };
    case 'changed':
      return { kind: 'changed', email: identity.email, previousEmail: identity.previousEmail };
    case 'unconfirmed':
    case 'unreadable':
      return { kind: 'paused', reason: identity.state, email: identity.email };
    default:
      return signInState === 'signed-out' ? { kind: 'signed-out' } : { kind: 'healthy' };
  }
}
