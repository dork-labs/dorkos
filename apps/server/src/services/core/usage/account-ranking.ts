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
 * **Only accounts that may work in the project are ever ranked** (spec
 * `flow-multiproject` §8.4). The candidates are filtered by the account rules
 * before anyone ranks them, so the advisor only sees eligible accounts, and
 * its answer is filtered again. The context's folder is resolved to a project
 * once per ranking; an empty folder is "no project".
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
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import { configManager } from '../config-manager.js';
import {
  accountEligibility,
  joinNames,
  NOT_USED_IN_ANY_PROJECT,
  projectOfFolder,
  refusalFor,
  type EligibilityConfigReader,
  type Ineligible,
} from './account-eligibility.js';
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
  /** `true` for an account that may not work in the project ({@link notAllowedAccounts}). */
  notAllowed?: true;
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

/** Whether an account may work in the project (spec `flow-multiproject` §8.2). */
function mayWorkIn(
  account: RuntimeAccount,
  project: ProjectRef | null,
  config: EligibilityConfigReader = configManager
): boolean {
  return accountEligibility(config, account.runtime, account.id, project).eligible;
}

/**
 * The routable accounts of one runtime that may work in the project, in
 * registry order, each with its usage.
 */
function candidatesOf(
  runtime: string,
  project: ProjectRef | null,
  config: EligibilityConfigReader = configManager
): Candidate[] {
  const store = getAccountUsageStore();
  if (!store || !isLedgerRuntime(runtime)) return [];
  return store
    .listAccounts(runtime)
    .filter((account) => account.routable && mayWorkIn(account, project, config))
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
function defaultRanking(
  ctx: AdvisorContext,
  project: ProjectRef | null,
  config: EligibilityConfigReader = configManager
): AccountRanking {
  const rows = candidatesOf(ctx.runtime, project, config)
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
async function advisedRanking(
  ctx: AdvisorContext,
  project: ProjectRef | null
): Promise<AccountRanking | null | 'failed'> {
  if (!hasAccountAdvisor()) return null;
  const candidates: AccountCandidate[] = candidatesOf(ctx.runtime, project).map(
    ({ account, usage }) => ({
      id: account.id,
      label: account.label,
      color: account.color,
      usage: toExtensionAccountUsage(usage),
    })
  );
  const answer: AdvisorRanking | undefined = await callAdvisor('rank', candidates, ctx);
  if (answer === undefined) return 'failed';
  // Read the accounts after the answer, so a row is filled from what is true now.
  const byKey = new Map<string, Candidate>();
  for (const runtime of LEDGER_RUNTIMES) {
    // Only eligible accounts are known, so an ineligible id the advisor
    // returns anyway is dropped with the unknown ones.
    for (const candidate of candidatesOf(runtime, project)) {
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
  const project = await projectOfFolder(ctx.cwd);
  const advised = await advisedRanking(ctx, project);
  if (advised === null || advised === 'failed') return defaultRanking(ctx, project);
  return advised;
}

/**
 * The account ids of one runtime that may work in the project, in core's own
 * ranking order (weekly headroom, then 5-hour headroom, then registry order;
 * out-of-usage accounts after). What the launch ladder falls back through when
 * its automatic choice may not work in the project. Never asks the advisor, so
 * a launch never waits on an extension. Empty with no usage store.
 *
 * @param runtime - The runtime.
 * @param project - The launch's project, or null for no project.
 * @param config - Where the rules live: the ladder passes its own reader.
 */
export function launchFallbackOrder(
  runtime: string,
  project: ProjectRef | null,
  config: EligibilityConfigReader = configManager
): string[] {
  return defaultRanking({ purpose: 'launch', caller: 'person', cwd: '', runtime }, project, config)
    .accounts.filter((row) => row.runtime === runtime)
    .map((row) => row.id);
}

/**
 * The accounts of one runtime that may NOT work in the folder's project, each
 * as a ranked row that is not eligible and says why ("Only for client-app").
 * For pickers that show such an account disabled rather than hiding it
 * (`GET /api/sessions/:id/continue-options`).
 *
 * @param ctx - The same context the ranking was asked with.
 */
export async function notAllowedAccounts(ctx: AdvisorContext): Promise<RankedAccount[]> {
  const store = getAccountUsageStore();
  if (!store || !isLedgerRuntime(ctx.runtime)) return [];
  const project = await projectOfFolder(ctx.cwd);
  return store
    .listAccounts(ctx.runtime)
    .filter((account) => account.routable && account.id !== ctx.excludeAccountId)
    .flatMap((account) => {
      const verdict = accountEligibility(configManager, account.runtime, account.id, project);
      if (verdict.eligible) return [];
      return {
        runtime: account.runtime,
        id: account.id,
        label: account.label,
        color: account.color,
        usage: store.usageOfAccount(account),
        eligible: false,
        reason: notAllowedReason(verdict, project),
        notAllowed: true,
      } satisfies RankedAccount;
    });
}

/**
 * The short line a picker shows beside an account that may not work here:
 * "Only for client-app", or "Not used in dorkos".
 *
 * @param verdict - Why the account may not work here.
 * @param project - The project, or null.
 */
export function notAllowedReason(verdict: Ineligible, project: ProjectRef | null): string {
  if (verdict.reason === 'project-allowlist') return `Not used in ${verdict.project.name}`;
  const names = verdict.allowedProjects.map((p) => p.name);
  if (names.length === 0) return NOT_USED_IN_ANY_PROJECT;
  return `Only for ${joinNames(names)}`;
}

/**
 * Whether an agent (`session_start`) or a relay message may launch a session on
 * the account it names. Refused first when the account may not work in the
 * folder's project, with the plain sentence. Then refused with no advisor registered, refused when the
 * advisor fails, and otherwise allowed only when the advisor's `launch` ranking
 * marks the account eligible (refused with its reason when not).
 *
 * @param request - The account named, where, on which runtime, and by whom.
 */
export async function checkAccountLaunch(
  request: AccountLaunchRequest
): Promise<AccountLaunchDecision> {
  // The account rules first, before the advisor is asked: an account that may
  // not work in this project is refused with the plain sentence whatever the
  // advisor would say (spec `flow-multiproject` §8.4).
  const project = await projectOfFolder(request.cwd);
  const verdict = accountEligibility(configManager, request.runtime, request.accountId, project);
  if (!verdict.eligible) {
    return {
      allowed: false,
      reason: refusalFor(configManager, request.accountId, project, verdict).message,
    };
  }
  const advised = await advisedRanking(
    {
      purpose: 'launch',
      caller: request.caller,
      cwd: request.cwd,
      runtime: request.runtime,
    },
    project
  );
  if (advised === null) return { allowed: false, reason: NO_ADVISOR_REASON };
  if (advised === 'failed') return { allowed: false, reason: ADVISOR_FAILED_REASON };
  const row = advised.accounts.find(
    (a) => a.runtime === request.runtime && a.id === request.accountId
  );
  if (!row) return { allowed: false, reason: ACCOUNT_HIDDEN_REASON };
  return row.eligible ? { allowed: true } : { allowed: false, reason: row.reason };
}
