/**
 * The status bar's usage, read from the session's ACCOUNT rather than only from
 * its last turn (spec `claude-account-ui` §6.8): the pure rules that turn an
 * {@link AccountUsage} into the {@link UsageStatus} the usage item already
 * draws, and that pick between that reading and the turn's own usage.
 *
 * @module features/status/lib/account-usage-status
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { UsageStatus } from '@dorkos/shared/types';
import { nearestWindow, type AccountWindow } from '@/layers/shared/lib';

/**
 * Whether a {@link UsageStatus} has a metric worth rendering. A subscription
 * renders when it has utilization or cost; pay-as-you-go renders when it has
 * cost. The status line builds the item only for a usage that passes this, and
 * the registry promotes it only then (spec `claude-account-ui` §6.8).
 *
 * @param usage - The runtime-neutral usage descriptor.
 */
export function hasRenderableUsage(usage: UsageStatus): boolean {
  if (usage.kind === 'subscription') {
    return usage.utilization != null || usage.costUsd != null;
  }
  return usage.costUsd != null;
}

/**
 * Whether a window's reset has passed: the server says so (`expired`), or its
 * `resetsAt` is already behind `now` and the server has not caught up yet. An
 * expired window no longer says anything about how much is used.
 *
 * @param window - One of the account's windows.
 * @param now - The moment to read from.
 */
export function isWindowExpired(window: AccountWindow, now: Date): boolean {
  if (window.expired) return true;
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now.getTime();
}

/**
 * An account's usage with every window whose reset has passed marked the way
 * the server marks one (`expired`, 0%, status cleared), so the chip, the
 * popovers and the bars all agree on expiry even before the server catches up.
 * When a window is marked here, the account's `state` and `limit` are read
 * again from the windows still in force, as the server would. Returns the same
 * object when nothing changed.
 *
 * @param usage - The account's usage, or nothing when there is no reading.
 * @param now - The moment to read expiry from.
 */
export function withExpiredWindows(
  usage: AccountUsage | null | undefined,
  now: Date
): AccountUsage | null {
  if (!usage) return null;
  let changed = false;
  const windows = usage.windows.map((entry) => {
    if (!isWindowExpired(entry, now) || (entry.expired && entry.usedPct === 0)) return entry;
    changed = true;
    return { ...entry, expired: true, usedPct: 0, status: null };
  });
  if (!changed) return usage;
  const inForce = windows.filter((entry) => !entry.expired);
  const limit =
    usage.limit && inForce.some((entry) => entry.key === usage.limit!.window) ? usage.limit : null;
  const readable = inForce.some((entry) => entry.usedPct !== null);
  const state = readable ? ACCOUNT_STATE_OF[stateOfWindows(inForce, limit)!] : 'unknown';
  return { ...usage, windows, limit, state };
}

/** The usage item's state as the account's own `state`. */
const ACCOUNT_STATE_OF: Record<NonNullable<UsageStatus['state']>, AccountUsage['state']> = {
  ok: 'ok',
  warning: 'warning',
  exhausted: 'limited',
};

/** The share from which a window is near its limit (S4's usage `state` rule). */
const WARNING_PCT = 90;

/**
 * How the windows still in force read, by S4's rule: out when the account's
 * limit names one of them, or one rejected work or is full; near when one is at
 * 90% or warned; else fine.
 */
function stateOfWindows(
  windows: readonly AccountWindow[],
  limit: AccountUsage['limit']
): UsageStatus['state'] {
  if (limit && windows.some((w) => w.key === limit.window)) return 'exhausted';
  if (windows.some((w) => w.status === 'rejected' || (w.usedPct ?? 0) >= 100)) return 'exhausted';
  if (windows.some((w) => w.status === 'allowed_warning' || (w.usedPct ?? 0) >= WARNING_PCT)) {
    return 'warning';
  }
  return 'ok';
}

/**
 * The windows the usage popover lists: every window with a reading, in the
 * server's order. An expired window is kept (the popover shows it as "reset");
 * a window with no reading is left out, so nothing is drawn as 0%.
 *
 * @param usage - The account's usage, or nothing when there is no reading.
 */
export function readableWindows(usage: AccountUsage | null | undefined): AccountWindow[] {
  return (usage?.windows ?? []).filter((window) => window.usedPct !== null || window.expired);
}

/**
 * When the newest of `windows` was observed, ISO-8601, or `null` when there
 * are none. The freshness line reads this: the popover is as fresh as the
 * newest number it shows.
 *
 * @param windows - The windows shown.
 */
export function newestObservedAt(windows: readonly AccountWindow[]): string | null {
  let newest: string | null = null;
  for (const window of windows) {
    if (newest === null || Date.parse(window.observedAt) > Date.parse(newest)) {
      newest = window.observedAt;
    }
  }
  return newest;
}

/** How the account's overall `state` reads on the usage item. */
const STATE_OF: Partial<Record<AccountUsage['state'], UsageStatus['state']>> = {
  ok: 'ok',
  warning: 'warning',
  limited: 'exhausted',
};

/**
 * An account's usage as the status bar's {@link UsageStatus}: its most-used
 * readable window that has not reset (`nearestWindow`), as a subscription
 * utilization with the server's window label and reset time.
 *
 * Returns `null` when no window has a reading, which includes a spend-only
 * record (OpenCode reports money, not windows), so the session's own
 * pay-as-you-go cost keeps showing and nothing reads as 0%.
 *
 * @param usage - The account's usage, or nothing when there is no reading.
 * @param now - The moment to read expiry from.
 */
export function accountUsageToStatus(
  usage: AccountUsage | null | undefined,
  now: Date
): UsageStatus | null {
  if (!usage) return null;
  const live = usage.windows.filter((window) => !isWindowExpired(window, now));
  const window = nearestWindow({ ...usage, windows: live });
  if (!window || window.usedPct === null) return null;
  // The account's overall state may be about a window that has since reset
  // (the 5-hour window hit 100%, then reset): then it is read again from the
  // windows still in force.
  const state =
    live.length < usage.windows.length ? stateOfWindows(live, usage.limit) : STATE_OF[usage.state];
  return {
    kind: 'subscription',
    utilization: window.usedPct / 100,
    windowLabel: window.label,
    ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    ...(state ? { state } : {}),
  };
}

/** Where the usage the status bar shows came from. */
export type UsageSource = 'live' | 'account' | 'snapshot';

/** Inputs to {@link pickUsage}. */
export interface PickUsageInput {
  /** The session's own usage (`status.usage`): a live frame, or a snapshot's copy. */
  liveTurnUsage: UsageStatus | null;
  /** When a live frame set {@link liveTurnUsage} (ms), or `null` when it came from a snapshot. */
  liveTurnAt: number | null;
  /** The account's reading as a {@link UsageStatus} (`accountUsageToStatus`), or `null`. */
  accountStatus: UsageStatus | null;
  /** When the account's newest window was observed, ISO-8601, or `null`. */
  accountObservedAt: string | null;
}

/** What {@link pickUsage} chose. */
export interface PickedUsage {
  /** The usage to show, or `null` when there is none. */
  usage: UsageStatus | null;
  /** Where it came from, or `null` when there is none. */
  source: UsageSource | null;
  /** When it was observed, ISO-8601, or `null` when that is not known (a snapshot's usage). */
  observedAt: string | null;
}

/**
 * Choose between a session's own usage and its account's reading.
 *
 * The account's reading wins, except over a LIVE turn frame that arrived after
 * the account's newest window was observed. A snapshot's usage (`status.usage`
 * on reopen) has no time, so it never beats the account and is shown only when
 * there is no account reading at all; its freshness is unknown, so it is never
 * labelled "just now". A session billed per token (`pay-as-you-go`) keeps its
 * own cost: its account's windows are not what it spends.
 *
 * When the account wins, the session's own cost figures ride along, as the
 * server does for a subscription session.
 *
 * @param input - The session's usage, its arrival time, and the account's reading.
 */
export function pickUsage({
  liveTurnUsage,
  liveTurnAt,
  accountStatus,
  accountObservedAt,
}: PickUsageInput): PickedUsage {
  const live = liveTurnUsage !== null && liveTurnAt !== null;
  const liveResult = (): PickedUsage => ({
    usage: liveTurnUsage,
    source: 'live',
    observedAt: new Date(liveTurnAt!).toISOString(),
  });

  if (accountStatus && liveTurnUsage?.kind !== 'pay-as-you-go') {
    const accountAt = accountObservedAt === null ? Number.NaN : Date.parse(accountObservedAt);
    if (live && (Number.isNaN(accountAt) || liveTurnAt! > accountAt)) return liveResult();
    return {
      usage: {
        ...accountStatus,
        ...(liveTurnUsage?.costUsd !== undefined ? { costUsd: liveTurnUsage.costUsd } : {}),
        ...(liveTurnUsage?.costBasis !== undefined ? { costBasis: liveTurnUsage.costBasis } : {}),
        ...(liveTurnUsage?.detail !== undefined ? { detail: liveTurnUsage.detail } : {}),
      },
      source: 'account',
      observedAt: accountObservedAt,
    };
  }
  if (liveTurnUsage === null) return { usage: null, source: null, observedAt: null };
  if (live) return liveResult();
  return { usage: liveTurnUsage, source: 'snapshot', observedAt: null };
}

/**
 * The class that dims a stale number (Q17, refined by the orchestrator on
 * 2026-09-28): on the number only, never on its icon or the words around it.
 * The status line is already muted, so a healthy number goes a step lighter
 * (`/70`, the lightest step that keeps 3:1 contrast in both themes: 3.58:1
 * light, 4.31:1 dark). An amber or red number turns muted. Empty when fresh.
 *
 * @param stale - Whether the reading is older than an hour (`isStale`).
 * @param toned - Whether the number wears a warning or error color.
 */
export function staleNumberClass(stale: boolean, toned = false): string {
  if (!stale) return '';
  return toned ? 'text-muted-foreground' : 'text-muted-foreground/70';
}
