/**
 * Codex account rate limits on app-server: `account/rateLimits/read` and the
 * sparse `account/rateLimits/updated`, reshaped for the account usage ledger
 * (spec `codex-app-server-transport` §7 "Usage").
 *
 * @module services/runtimes/codex/app-server/rate-limits
 */

/**
 * One `RateLimitSnapshot` (camelCase, app-server) in the rollout's snake_case
 * shape, which `codexObservations` already reads.
 *
 * @param snapshot - From `account/rateLimits/read` or `…/updated`.
 */
export function rateLimitsToRolloutShape(snapshot: unknown): Record<string, unknown> | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const s = snapshot as Record<string, unknown>;
  const windowOf = (w: unknown) => {
    if (typeof w !== 'object' || w === null) return null;
    const win = w as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
    return {
      used_percent: win.usedPercent,
      window_minutes: win.windowDurationMins,
      resets_at: win.resetsAt,
    };
  };
  const credits = s.credits as
    { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined;
  return {
    limit_id: s.limitId ?? null,
    limit_name: s.limitName ?? null,
    primary: windowOf(s.primary),
    secondary: windowOf(s.secondary),
    plan_type: s.planType ?? null,
    rate_limit_reached_type: s.rateLimitReachedType ?? null,
    ...(credits
      ? {
          credits: {
            has_credits: credits.hasCredits,
            unlimited: credits.unlimited,
            balance: credits.balance,
          },
        }
      : {}),
  };
}

/**
 * Merge a sparse `account/rateLimits/updated` snapshot into the last full
 * reading: a field the update leaves null keeps its previous value.
 *
 * @param previous - The last reading, if any.
 * @param update - The sparse update.
 */
export function mergeRateLimits(previous: unknown, update: unknown): unknown {
  if (typeof update !== 'object' || update === null) return previous;
  if (typeof previous !== 'object' || previous === null) return update;
  const merged: Record<string, unknown> = { ...(previous as Record<string, unknown>) };
  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}
