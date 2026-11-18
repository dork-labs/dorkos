import { logger } from '../../lib/logger.js';
import { canonicalAccountPath } from '../core/usage/runtime-accounts.js';

/** Observed sign-in state; never reads credentials or starts a vendor command. */
const states = new Map<string, 'signed-in' | 'signed-out'>();

/** One change to what this process knows about an account's sign-in. */
export type AccountSigninChange =
  | {
      kind: 'recorded';
      runtime: string;
      accountRoot: string | undefined;
      state: 'signed-in' | 'signed-out';
    }
  | {
      /** Every observation was forgotten (tests). */
      kind: 'reset';
    };

/** Hears every recorded observation. It runs inside a turn, so it must be quick. */
export type AccountSigninListener = (change: AccountSigninChange) => void;

const listeners = new Set<AccountSigninListener>();

/**
 * Hear every sign-in observation as it is recorded: the seam the
 * credential-change watch starts and stops on. A listener that throws is
 * logged and never reaches the turn that recorded it.
 *
 * @param listener - Told about each observation, and about a reset.
 * @returns A function that stops telling it.
 */
export function onAccountSigninChange(listener: AccountSigninListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell every listener, never letting one cost the caller. */
function tell(change: AccountSigninChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      logger.debug('[Runtimes] A sign-in listener failed', { err });
    }
  }
}

/** Record proof from a completed login or a runtime turn. */
export function recordAccountSignin(
  runtime: string,
  accountRoot: string | undefined,
  state: 'signed-in' | 'signed-out'
): void {
  states.set(
    JSON.stringify([
      runtime,
      accountRoot === undefined ? null : canonicalAccountPath(accountRoot, undefined),
    ]),
    state
  );
  tell({ kind: 'recorded', runtime, accountRoot, state });
}

/** Read the last observed state; a restart honestly starts at not checked. */
export function accountSigninState(
  runtime: string,
  accountRoot: string | undefined
): 'signed-in' | 'signed-out' | 'unknown' {
  return (
    states.get(
      JSON.stringify([
        runtime,
        accountRoot === undefined ? null : canonicalAccountPath(accountRoot, undefined),
      ])
    ) ?? 'unknown'
  );
}

/** Clear observations with the episode store in tests. */
export function resetAccountSignins(): void {
  states.clear();
  tell({ kind: 'reset' });
}
