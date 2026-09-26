/**
 * Codex's `rate_limits` payload as usage ledger observations (contract
 * flow-cli-core §1.2 "Codex"). Re-exported from `@dorkos/shared/account-usage`.
 *
 * @module shared/account-usage-codex
 */
import type { LedgerObservation, LedgerSource, RateLimitStatus } from './account-usage.js';
import { ledgerSlug } from './ledger-slug.js';

// === Codex rate limits (contract §1.2 "Codex") ===

/** One Codex window as a rate-limit payload names it, before validation. */
interface CodexWindowInput {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

/** A usable Codex window: an integer length and a numeric percentage. */
interface CodexWindow {
  usedPct: number;
  windowMinutes: number;
  resetsAt: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCodexWindow(value: unknown): CodexWindow | null {
  if (!isPlainObject(value)) return null;
  const { used_percent, window_minutes, resets_at } = value as CodexWindowInput;
  if (typeof used_percent !== 'number' || !Number.isFinite(used_percent)) return null;
  if (
    typeof window_minutes !== 'number' ||
    !Number.isInteger(window_minutes) ||
    window_minutes < 1
  ) {
    return null;
  }
  const resetsAt =
    typeof resets_at === 'number' && Number.isFinite(resets_at)
      ? new Date(resets_at * 1000).toISOString()
      : null;
  return { usedPct: used_percent, windowMinutes: window_minutes, resetsAt };
}

/**
 * The main-limit windows a reached limit rejects: every window at 100% or
 * more, else the single tightest one (the highest `used_percent`, a tie going
 * to the shorter window, which resets first). Rejecting every window would
 * keep a week-long window rejected long after a 5-hour limit reset.
 */
function windowsThatHitTheLimit(windows: readonly CodexWindow[]): Set<CodexWindow> {
  const full = windows.filter((w) => w.usedPct >= 100);
  if (full.length > 0) return new Set(full);
  const tightest = windows.reduce<CodexWindow | null>((best, w) => {
    if (!best) return w;
    if (w.usedPct !== best.usedPct) return w.usedPct > best.usedPct ? w : best;
    return w.windowMinutes < best.windowMinutes ? w : best;
  }, null);
  return new Set(tightest ? [tightest] : []);
}

/** The main limit's key for a window: by length, never by slot. */
function codexWindowKey(windowMinutes: number): string {
  if (windowMinutes === 300) return 'five_hour';
  if (windowMinutes === 10080) return 'seven_day';
  return `window:${windowMinutes}`;
}

/**
 * Convert one Codex `rate_limits` payload into ledger observations (contract
 * §1.2 "Codex").
 *
 * Only the main limit (`limit_id` `"codex"`, or none) maps to plain windows,
 * keyed by `window_minutes`: 300 → `five_hour`, 10080 → `seven_day`, else
 * `window:<minutes>`. Any other limit becomes ONE `model:<slug>` bucket (slug
 * from `limit_name`, else `limit_id`) holding its tightest window: the highest
 * `used_percent`, a tie going to the longer window. A window with no integer
 * length or numeric percentage is skipped. `status` is `null`, except when
 * `rate_limit_reached_type` is set: then only the windows that hit the limit
 * are `rejected` (every window at 100% or more, else the single tightest, a
 * tie going to the shorter window), and a model bucket's one window is
 * `rejected`. `plan_type` becomes a `plan`
 * fact and `credits` a `credits` fact. Order: windows (primary before
 * secondary), then plan, then credits. Anything that is not an object gives
 * nothing.
 *
 * @param rateLimits - One `rate_limits` payload, as parsed JSON.
 * @param observedAt - When it was seen, ISO-8601.
 * @param source - The ledger source to stamp, normally `rollout`.
 */
export function codexObservations(
  rateLimits: unknown,
  observedAt: string,
  source: LedgerSource
): LedgerObservation[] {
  if (!isPlainObject(rateLimits)) return [];
  const reached =
    rateLimits.rate_limit_reached_type !== null && rateLimits.rate_limit_reached_type !== undefined;
  const slots = [rateLimits.primary, rateLimits.secondary]
    .map(readCodexWindow)
    .filter((w): w is CodexWindow => w !== null);
  const toObservation = (
    key: string,
    w: CodexWindow,
    status: RateLimitStatus | null
  ): LedgerObservation => ({
    key,
    usedPct: w.usedPct,
    resetsAt: w.resetsAt,
    windowMinutes: w.windowMinutes,
    status,
    observedAt,
    source,
  });

  const observations: LedgerObservation[] = [];
  const limitId = rateLimits.limit_id;
  if (limitId === undefined || limitId === null || limitId === 'codex') {
    const hit = reached ? windowsThatHitTheLimit(slots) : new Set<CodexWindow>();
    for (const w of slots) {
      const key = codexWindowKey(w.windowMinutes);
      observations.push(toObservation(key, w, hit.has(w) ? 'rejected' : null));
    }
  } else {
    const name =
      typeof rateLimits.limit_name === 'string' && rateLimits.limit_name !== ''
        ? rateLimits.limit_name
        : typeof limitId === 'string'
          ? limitId
          : '';
    const slug = ledgerSlug(name);
    const tightest = slots.reduce<CodexWindow | null>((best, w) => {
      if (!best) return w;
      if (w.usedPct !== best.usedPct) return w.usedPct > best.usedPct ? w : best;
      return w.windowMinutes > best.windowMinutes ? w : best;
    }, null);
    if (slug !== null && tightest) {
      observations.push(toObservation(`model:${slug}`, tightest, reached ? 'rejected' : null));
    }
  }

  if (typeof rateLimits.plan_type === 'string' && rateLimits.plan_type !== '') {
    observations.push({ kind: 'plan', name: rateLimits.plan_type, observedAt, source });
  }
  const credits = rateLimits.credits;
  if (
    isPlainObject(credits) &&
    typeof credits.has_credits === 'boolean' &&
    typeof credits.unlimited === 'boolean'
  ) {
    observations.push({
      kind: 'credits',
      hasCredits: credits.has_credits,
      unlimited: credits.unlimited,
      balance: typeof credits.balance === 'string' ? credits.balance : null,
      observedAt,
      source,
    });
  }
  return observations;
}
