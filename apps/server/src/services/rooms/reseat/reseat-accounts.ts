import { accountLoginIdentity } from '../../runtimes/claude-code/accounts/account-login-metadata.js';
/**
 * Which account a room seat moves to when its own runs out (Security Must 4).
 *
 * The candidates are core's own ranking for the folder's project
 * (`coreRanking` in `account-ranking.ts`): the accounts a person allowed in
 * Settings → Runtimes, in weekly-then-5-hour headroom order. Never the
 * account advisor, so a move never waits on an extension, and nothing from the
 * agent's own folder. From those this takes the first that is on the same
 * runtime, is not the seat's own, is not DorkOS credits (credits spend money,
 * and only a person picks them), is not kept out of automatic moves (a
 * person's `noAutoMove` on the account; only a person naming it may move a
 * seat there), and is neither out nor nearly out.
 *
 * Pure: the ranking is an input.
 *
 * @module services/rooms/reseat/reseat-accounts
 */
import { CREDITS_ACCOUNT_ID, type AccountUsage } from '@dorkos/shared/account-usage';
import type { RankedAccount } from '../../core/usage/account-ranking.js';

/** The share of the 5-hour or weekly window at which an account counts as nearly out. */
export const NEARLY_OUT_PCT = 95;

/** The windows {@link NEARLY_OUT_PCT} is read against. */
const WATCHED_WINDOWS = ['five_hour', 'seven_day'] as const;

/** Where a seat may move, or when the soonest account is usable again. */
export type ReseatPick =
  { kind: 'move'; account: RankedAccount } | { kind: 'none'; earliestResetAt: string | null };

/**
 * Whether an account is out of usage, or at {@link NEARLY_OUT_PCT} or more of
 * its 5-hour or weekly window. Unknown usage is not nearly out: an account
 * nobody has measured yet is still worth trying.
 *
 * @param usage - The account's usage.
 */
export function nearlyOut(usage: AccountUsage): boolean {
  if (usage.state === 'limited') return true;
  return usage.windows.some(
    (w) =>
      (WATCHED_WINDOWS as readonly string[]).includes(w.key) &&
      w.usedPct !== null &&
      w.usedPct >= NEARLY_OUT_PCT
  );
}

/**
 * The accounts a seat on this runtime may move to: the same runtime, never
 * DorkOS credits, never one the project does not allow, and never one a person
 * kept out of automatic moves unless `opts.keptOut` says a person is choosing.
 * The one filter every pick and every offer goes through. The seat's own
 * account is still in the list; callers that offer a move leave it out.
 *
 * @param ranking - Core's ranking for the folder's project, best first.
 * @param runtime - The seat's runtime.
 * @param opts.keptOut - `true` to keep accounts kept out of automatic moves in
 *   the list: only for a person's own pick, never for a move DorkOS makes.
 */
export function reseatCandidates(
  ranking: readonly RankedAccount[],
  runtime: string,
  opts: { keptOut?: boolean; signinHealthy?: (root: string) => boolean } = {}
): RankedAccount[] {
  return ranking.filter(
    (row) =>
      row.runtime === runtime &&
      row.id !== CREDITS_ACCOUNT_ID &&
      (runtime !== 'claude-code' ||
        (row.usage.path !== null &&
          (opts.signinHealthy?.(row.usage.path) ??
            accountLoginIdentity(row.usage.path).state === 'confirmed'))) &&
      !row.notAllowed &&
      (opts.keptOut === true || !row.noAutoMove)
  );
}

/**
 * Whether an account can take a moved seat now: eligible and not nearly out.
 *
 * @param row - The ranked account.
 */
export function canTakeWork(row: RankedAccount): boolean {
  return row.eligible && !nearlyOut(row.usage);
}

/** When an out or nearly-out account is usable again, or `null` when unknown. */
function usableAgainAt(usage: AccountUsage): string | null {
  if (usage.state === 'limited') return usage.limit?.resetsAt ?? null;
  const times = usage.windows
    .filter(
      (w) =>
        (WATCHED_WINDOWS as readonly string[]).includes(w.key) &&
        w.usedPct !== null &&
        w.usedPct >= NEARLY_OUT_PCT
    )
    .map((w) => w.resetsAt);
  // A nearly-out account is usable again only once EVERY full window resets.
  if (times.some((t) => t === null)) return null;
  return (times as string[]).sort().at(-1) ?? null;
}

/**
 * Pick the account a seat moves to. An account kept out of automatic moves is
 * never picked, however much room it has, unless `opts.keptOut` says a person
 * named it.
 *
 * @param ranking - Core's ranking for the folder's project, best first.
 * @param seat.runtime - The seat's runtime; a move never crosses runtimes.
 * @param seat.currentAccountId - The account the seat runs on now, or `null` when unknown.
 * @param opts.keptOut - `true` only when a person named the one account in `ranking`.
 * @returns The account to move to; or, when none qualifies, the earliest time
 *   any account the move could use (the seat's own included) is usable again,
 *   `null` when no reset time is known.
 */
export function pickReseatAccount(
  ranking: readonly RankedAccount[],
  seat: { runtime: string; currentAccountId: string | null },
  opts: { keptOut?: boolean; signinHealthy?: (root: string) => boolean } = {}
): ReseatPick {
  const candidates = reseatCandidates(ranking, seat.runtime, opts);
  const account = candidates.find((row) => row.id !== seat.currentAccountId && canTakeWork(row));
  if (account) return { kind: 'move', account };
  const resets = candidates
    .map((row) => usableAgainAt(row.usage))
    .filter((at): at is string => at !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { kind: 'none', earliestResetAt: resets[0] ?? null };
}
