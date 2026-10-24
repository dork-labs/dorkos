import { canonicalAccountPath } from '../core/usage/runtime-accounts.js';

/** Observed sign-in state; never reads credentials or starts a vendor command. */
const states = new Map<string, 'signed-in' | 'signed-out'>();

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
}
