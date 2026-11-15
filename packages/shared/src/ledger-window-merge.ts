/**
 * How one usage ledger window folds a new reading in (contract flow-cli-core
 * §1.2 "Merging", plus the DOR-3589 rule below). Used by `mergeLedger` in
 * `@dorkos/shared/account-usage`.
 *
 * A stored window holds two readings at once. The LATEST reading gives the
 * status, `resetsAt`, `source` and `windowMinutes`. Its share used comes from
 * the latest reading that had one in the same window, with that reading's
 * `observedAt`. When those are two different readings, the entry also carries
 * `statusObservedAt`, the latest reading's own time. So a limit notice with no
 * number (an SDK `rate_limit_event` without `utilization`) updates the status
 * and never blanks the share a probe measured.
 *
 * @module shared/ledger-window-merge
 */
import type { LedgerEntry, RateLimitStatus } from './account-usage.js';

/** How severe a window status is, for breaking a tie: higher wins, no status lowest. */
const STATUS_RANK: Readonly<Record<RateLimitStatus, number>> = {
  allowed: 1,
  allowed_warning: 2,
  rejected: 3,
};

/**
 * Whether a window reading replaces the stored one (contract §1.2 "Merging",
 * revision 6e, fixtures 4.0.0). Both are normalized entries (UTC times,
 * clamped `usedPct`).
 *
 * A strictly later `observedAt` wins. On an equal one (two sessions on one
 * account can see a limit in the same millisecond) the more severe reading
 * wins: status `rejected` > `allowed_warning` > `allowed` > none, then the
 * higher `usedPct`, then the later `resetsAt`, then the greater `source`
 * (code-unit order), then the longer `windowMinutes` (a missing value lowest
 * in each). A reading equal on all of these keeps the stored one. It is a
 * strict total order, so the merge is deterministic whatever order readings
 * arrive in, a replay changes nothing, and a same-millisecond `rejected` is
 * never lost.
 */
function replacesWindow(next: LedgerEntry, stored: LedgerEntry): boolean {
  const nextAt = Date.parse(next.observedAt);
  const storedAt = Date.parse(stored.observedAt);
  if (nextAt !== storedAt) return nextAt > storedAt;
  const rank = (e: LedgerEntry) => (e.status === null ? 0 : STATUS_RANK[e.status]);
  if (rank(next) !== rank(stored)) return rank(next) > rank(stored);
  const used = (e: LedgerEntry) => e.usedPct ?? -1;
  if (used(next) !== used(stored)) return used(next) > used(stored);
  const resets = (e: LedgerEntry) => (e.resetsAt === null ? -Infinity : Date.parse(e.resetsAt));
  if (resets(next) !== resets(stored)) return resets(next) > resets(stored);
  if (next.source !== stored.source) return next.source > stored.source;
  return (next.windowMinutes ?? -1) > (stored.windowMinutes ?? -1);
}

/** A share used and the time it was observed. */
interface Share {
  usedPct: number;
  observedAt: string;
}

/** The share a reading measured, or `null` when it gave none. */
function shareOf(entry: LedgerEntry): Share | null {
  return entry.usedPct === null ? null : { usedPct: entry.usedPct, observedAt: entry.observedAt };
}

/** Split a stored entry into its latest reading and the share it shows. */
function split(entry: LedgerEntry): { latest: LedgerEntry; share: Share | null } {
  const { statusObservedAt, ...rest } = entry;
  const latest =
    statusObservedAt === undefined
      ? rest
      : { ...rest, usedPct: null, observedAt: statusObservedAt };
  return { latest, share: shareOf(rest) };
}

/**
 * The readings a normalized entry stands for, to merge one by one: itself, or,
 * for an entry that kept an earlier share, that share's reading and then the
 * later status reading. So a stored entry fed back in as an observation (the
 * server re-merges memory into the file) keeps both of its times.
 *
 * @param entry - A normalized entry or observation.
 */
export function readingsOf(entry: LedgerEntry): LedgerEntry[] {
  if (entry.statusObservedAt === undefined) return [entry];
  const { latest } = split(entry);
  return [
    { ...latest, usedPct: entry.usedPct, status: null, observedAt: entry.observedAt },
    latest,
  ];
}

/** The later share, a tie going to the higher one; equal shares keep `a`. */
function laterShare(a: Share | null, b: Share | null): Share | null {
  if (a === null || b === null) return a ?? b;
  const aAt = Date.parse(a.observedAt);
  const bAt = Date.parse(b.observedAt);
  if (aAt !== bAt) return bAt > aAt ? b : a;
  return b.usedPct > a.usedPct ? b : a;
}

/**
 * Whether a share measured in a window whose reset was `shareResetsAt` still
 * belongs beside `latest`: not when that reset had passed by the time `latest`
 * was seen, nor when `latest` names a later reset (a new window).
 */
function sameWindow(shareResetsAt: string | null, latest: LedgerEntry): boolean {
  if (shareResetsAt === null) return true;
  const resetsMs = Date.parse(shareResetsAt);
  if (resetsMs <= Date.parse(latest.observedAt)) return false;
  return latest.resetsAt === null || Date.parse(latest.resetsAt) <= resetsMs;
}

/**
 * Fold one normalized reading into a stored window, or into nothing. Returns
 * the entry to store. Pure and order-independent: the latest reading wins by
 * {@link replacesWindow}, and the share is the latest one measured in the same
 * window, so a reading with no `usedPct` never blanks a number.
 *
 * @param stored - The stored entry, normalized, or `null` when there is none.
 * @param next - The new reading, normalized.
 */
export function mergeWindow(stored: LedgerEntry | null, next: LedgerEntry): LedgerEntry {
  if (stored === null) return next;
  const held = split(stored);
  const latest = replacesWindow(next, held.latest) ? next : held.latest;
  if (latest.usedPct !== null) return latest;
  // The stored share was in the window the stored reading named.
  const candidates: Array<{ share: Share | null; resetsAt: string | null }> = [
    { share: held.share, resetsAt: stored.resetsAt },
    { share: shareOf(next), resetsAt: next.resetsAt },
  ];
  let share: Share | null = null;
  for (const c of candidates) {
    if (c.share !== null && sameWindow(c.resetsAt, latest)) share = laterShare(share, c.share);
  }
  if (share === null) return latest;
  const fallback = candidates.find((c) => c.share === share)!;
  return {
    ...latest,
    usedPct: share.usedPct,
    resetsAt: latest.resetsAt ?? fallback.resetsAt,
    observedAt: share.observedAt,
    statusObservedAt: latest.observedAt,
  };
}
