/**
 * A session's subscription usage, read from its account's plan windows.
 * Re-exported from `@dorkos/shared/account-usage`.
 *
 * The server derives a Claude Code session's subscription `usage` from its
 * account's record (spec `claude-account-fleet` §6 U), and a client applying an
 * `account_usage` event must reach the same answer, so the rule lives here once.
 *
 * @module shared/account-plan-usage
 */
import type { AccountUsage } from './account-usage.js';
import type { UsageStatus } from './schemas.js';

/**
 * The windows the binding window is chosen from: the plan windows the SDK's
 * usage call reports, the same set `mapSdkUsageResponse` has always picked
 * from. Model-scoped and overage windows describe a slice of the plan, not the
 * plan, so they never stand for it.
 */
export const PLAN_WINDOW_KEYS: ReadonlySet<string> = new Set([
  'five_hour',
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
]);

/**
 * The binding window of an account as a subscription {@link UsageStatus}, or
 * `undefined` when no plan window has a percentage (an API-key account, or
 * nothing observed yet). The window with the HIGHEST share used wins, as
 * `mapSdkUsageResponse` picks it: it is the one that stops work first.
 *
 * @param usage - The account's usage from the store.
 */
export function subscriptionUsageOf(usage: AccountUsage): UsageStatus | undefined {
  let binding: AccountUsage['windows'][number] | undefined;
  for (const window of usage.windows) {
    if (!PLAN_WINDOW_KEYS.has(window.key) || window.usedPct === null) continue;
    if (!binding || window.usedPct > binding.usedPct!) binding = window;
  }
  if (!binding) return undefined;
  const utilization = binding.usedPct! / 100;
  const state =
    binding.status === 'rejected' || utilization >= 1
      ? ('exhausted' as const)
      : binding.status === 'allowed_warning'
        ? ('warning' as const)
        : undefined;
  return {
    kind: 'subscription',
    utilization,
    windowLabel: binding.label,
    ...(binding.resetsAt ? { resetsAt: binding.resetsAt } : {}),
    ...(state ? { state } : {}),
  };
}

/**
 * A session's `usage` with its subscription fields taken from the account and
 * its own cost kept: the account's binding window plus the session's
 * `costUsd`/`costBasis` and its `detail` line (such as "Using overage
 * capacity"). Returns `held` unchanged when the account has no plan window with
 * a percentage.
 *
 * @param held - The session's current `usage`, or `null`.
 * @param account - The account the session bills.
 */
export function withAccountSubscription(
  held: UsageStatus | null,
  account: AccountUsage
): UsageStatus | null {
  const subscription = subscriptionUsageOf(account);
  if (!subscription) return held;
  return {
    ...subscription,
    ...(held?.costUsd !== undefined ? { costUsd: held.costUsd } : {}),
    ...(held?.costBasis !== undefined ? { costBasis: held.costBasis } : {}),
    ...(held?.detail !== undefined ? { detail: held.detail } : {}),
  };
}
