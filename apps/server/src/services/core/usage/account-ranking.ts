/**
 * Which accounts a session may launch or continue on, in what order (spec
 * `claude-account-fleet` D9 "Ranking", D5 "Account check").
 *
 * {@link rankAccounts} asks the account advisor when one is registered and
 * validates its answer; without one, or when it fails, core's default ranks by
 * weekly headroom. {@link checkAccountLaunch} is the gate for an account an
 * AGENT or a RELAY message names: it needs an advisor, because routing policy
 * is the Flow extension's and nothing is spent until the operator opts in. A
 * person's own pick never goes through it.
 *
 * @module services/core/usage/account-ranking
 */
import {
  LEDGER_RUNTIMES,
  type AccountUsage,
  type LedgerRuntime,
} from '@dorkos/shared/account-usage';
import type {
  AccountCandidate,
  AdvisorContext,
  AdvisorRanking,
} from '@dorkos/extension-api/server';
import {
  callAdvisor,
  hasAccountAdvisor,
  toExtensionAccountUsage,
  validateAdvisorRanking,
} from './account-advisor.js';
import { getAccountUsageStore } from './current-usage-store.js';
import type { RuntimeAccount } from './runtime-accounts.js';

/** One ranked account, with what a surface needs to show it. */
export interface RankedAccount {
  /** The runtime the account belongs to (another runtime is a cross-runtime fallback). */
  runtime: string;
  /** The registry id, or `default` for a runtime's standalone implicit account. */
  id: string;
  /** What the operator calls the account, or `null` when unnamed. */
  label: string | null;
  /** The resolved display color. */
  color: string;
  /** The account's current usage. */
  usage: AccountUsage;
  /** Whether work may go to it now. */
  eligible: boolean;
  /** Why, in plain words. */
  reason: string;
  /** The advisor's badge, when it gave one. */
  badge?: 'recommended' | 'reserved';
}

/** The answer to {@link rankAccounts}. */
export interface AccountRanking {
  /** Eligible accounts first, in the order to offer them; hidden accounts are absent. */
  accounts: RankedAccount[];
  /** The account to suggest first, or `null` when none is eligible. */
  recommendedId: string | null;
  /** True when the registered advisor's ranking was used, false for core's default. */
  advised: boolean;
}

/** What an agent or relay launch names, for {@link checkAccountLaunch}. */
export interface AccountLaunchRequest {
  /** The account named. */
  accountId: string;
  /** The working directory of the session being launched. */
  cwd: string;
  /** The runtime the session runs on. */
  runtime: string;
  /** Who named it: an agent (`session_start`) or a relay message. */
  caller: 'agent' | 'relay';
}

/** The answer to {@link checkAccountLaunch}. */
export type AccountLaunchDecision = { allowed: true } | { allowed: false; reason: string };

/** Refusal when no advisor is registered (spec D5). */
export const NO_ADVISOR_REASON =
  'Agents can pick an account only after Flow is set up to say which accounts they may use.';

/** Refusal when the advisor throws, times out or answers nonsense (spec D5). */
export const ADVISOR_FAILED_REASON = 'The account policy could not be checked.';

/** Refusal when the advisor's ranking leaves the named account out. */
export const ACCOUNT_HIDDEN_REASON = 'The account policy does not offer this account.';

function isLedgerRuntime(runtime: string): runtime is LedgerRuntime {
  return (LEDGER_RUNTIMES as readonly string[]).includes(runtime);
}

/** A routable account with its current usage. */
interface Candidate {
  account: RuntimeAccount;
  usage: AccountUsage;
}

/** The routable accounts of one runtime, in registry order, each with its usage. */
function candidatesOf(runtime: string): Candidate[] {
  const store = getAccountUsageStore();
  if (!store || !isLedgerRuntime(runtime)) return [];
  return store
    .listAccounts(runtime)
    .filter((account) => account.routable)
    .map((account) => ({ account, usage: store.usageOfAccount(account) }));
}

function usedPct(usage: AccountUsage, key: string): number | null {
  return usage.windows.find((w) => w.key === key)?.usedPct ?? null;
}

/**
 * A reset time as a person reads it at a glance, in the server's local time:
 * `Tue 3pm`, or `Tue 3:30pm` off the hour.
 *
 * @param iso - An ISO timestamp.
 * @returns The short form, or `null` for an unparsable time.
 */
export function formatShortLocalTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const weekday = at.toLocaleDateString('en-US', { weekday: 'short' });
  const hours = at.getHours();
  const minutes = at.getMinutes();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const clock = minutes === 0 ? `${hour12}` : `${hour12}:${String(minutes).padStart(2, '0')}`;
  return `${weekday} ${clock}${hours < 12 ? 'am' : 'pm'}`;
}

/** Core's plain-words reason for an account's place in the default ranking. */
function defaultReason(usage: AccountUsage, eligible: boolean): string {
  if (!eligible) {
    const resetsAt = usage.limit?.resetsAt;
    const when = resetsAt ? formatShortLocalTime(resetsAt) : null;
    return when ? `Out until ${when}` : 'Out of usage';
  }
  const weekly = usedPct(usage, 'seven_day');
  if (weekly === null) return 'Usage unknown';
  const left = Math.round(Math.min(100, Math.max(0, 100 - weekly)));
  return `${left}% of the week left`;
}

/** Headroom for sorting: known values descending, unknown after every known one. */
function compareHeadroom(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function headroom(usage: AccountUsage, key: string): number | null {
  const used = usedPct(usage, key);
  return used === null ? null : 100 - used;
}

/**
 * Core's default ranking: every candidate except `excludeAccountId`; eligible
 * unless its usage reads `limited`; eligible first by weekly headroom (unknown
 * after known), then 5-hour headroom, then registry order; ineligible after.
 */
function defaultRanking(ctx: AdvisorContext): AccountRanking {
  const rows = candidatesOf(ctx.runtime)
    .filter(({ account }) => account.id !== ctx.excludeAccountId)
    .map(({ account, usage }, order) => {
      const eligible = usage.state !== 'limited';
      return {
        order,
        row: {
          runtime: account.runtime,
          id: account.id,
          label: account.label,
          color: account.color,
          usage,
          eligible,
          reason: defaultReason(usage, eligible),
        } satisfies RankedAccount,
      };
    });
  rows.sort((a, b) => {
    if (a.row.eligible !== b.row.eligible) return a.row.eligible ? -1 : 1;
    if (a.row.eligible) {
      const weekly = compareHeadroom(
        headroom(a.row.usage, 'seven_day'),
        headroom(b.row.usage, 'seven_day')
      );
      if (weekly !== 0) return weekly;
      const fiveHour = compareHeadroom(
        headroom(a.row.usage, 'five_hour'),
        headroom(b.row.usage, 'five_hour')
      );
      if (fiveHour !== 0) return fiveHour;
    }
    return a.order - b.order;
  });
  const accounts = rows.map((r) => r.row);
  return {
    accounts,
    recommendedId: accounts.find((a) => a.eligible)?.id ?? null,
    advised: false,
  };
}

/**
 * Ask the advisor to rank the candidates and validate its answer.
 *
 * @returns The validated ranking, `null` when there is no advisor, or
 *   `'failed'` when it threw, timed out or answered something that is not a ranking.
 */
async function advisedRanking(ctx: AdvisorContext): Promise<AccountRanking | null | 'failed'> {
  if (!hasAccountAdvisor()) return null;
  const candidates: AccountCandidate[] = candidatesOf(ctx.runtime).map(({ account, usage }) => ({
    id: account.id,
    label: account.label,
    color: account.color,
    usage: toExtensionAccountUsage(usage),
  }));
  const answer: AdvisorRanking | undefined = await callAdvisor('rank', candidates, ctx);
  if (answer === undefined) return 'failed';
  // Read the accounts after the answer, so a row is filled from what is true now.
  const byKey = new Map<string, Candidate>();
  for (const runtime of LEDGER_RUNTIMES) {
    for (const candidate of candidatesOf(runtime)) {
      byKey.set(`${runtime}\u0000${candidate.account.id}`, candidate);
    }
  }
  const validated = validateAdvisorRanking(answer, {
    runtime: ctx.runtime,
    isKnown: (runtime, id) =>
      !(runtime === ctx.runtime && id === ctx.excludeAccountId) &&
      byKey.has(`${runtime}\u0000${id}`),
  });
  if (!validated) return 'failed';
  return {
    accounts: validated.accounts.flatMap((row) => {
      const candidate = byKey.get(`${row.runtime}\u0000${row.id}`);
      if (!candidate) return [];
      const { account, usage } = candidate;
      return {
        runtime: row.runtime,
        id: row.id,
        label: account.label,
        color: account.color,
        usage,
        eligible: row.eligible,
        reason: row.reason,
        ...(row.badge ? { badge: row.badge } : {}),
      };
    }),
    recommendedId: validated.recommendedId,
    advised: true,
  };
}

/**
 * Rank the accounts a session may launch or continue on: the registered
 * advisor's ranking (validated: unknown ids dropped, hidden ids absent), else
 * core's default (see the module TSDoc and spec D9 "Ranking").
 *
 * @param ctx - What is being decided, and for which runtime.
 */
export async function rankAccounts(ctx: AdvisorContext): Promise<AccountRanking> {
  const advised = await advisedRanking(ctx);
  if (advised === null || advised === 'failed') return defaultRanking(ctx);
  return advised;
}

/**
 * Whether an agent (`session_start`) or a relay message may launch a session on
 * the account it names. Refused with no advisor registered, refused when the
 * advisor fails, and otherwise allowed only when the advisor's `launch` ranking
 * marks the account eligible (refused with its reason when not).
 *
 * @param request - The account named, where, on which runtime, and by whom.
 */
export async function checkAccountLaunch(
  request: AccountLaunchRequest
): Promise<AccountLaunchDecision> {
  const advised = await advisedRanking({
    purpose: 'launch',
    caller: request.caller,
    cwd: request.cwd,
    runtime: request.runtime,
  });
  if (advised === null) return { allowed: false, reason: NO_ADVISOR_REASON };
  if (advised === 'failed') return { allowed: false, reason: ADVISOR_FAILED_REASON };
  const row = advised.accounts.find(
    (a) => a.runtime === request.runtime && a.id === request.accountId
  );
  if (!row) return { allowed: false, reason: ACCOUNT_HIDDEN_REASON };
  return row.eligible ? { allowed: true } : { allowed: false, reason: row.reason };
}
