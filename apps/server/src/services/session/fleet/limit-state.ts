/**
 * The pure rules of a limited session's state (spec `claude-account-fleet` D9,
 * "The states core emits"): which of the eight states a limit is in, which
 * sessions may carry their work to another account, and which model the same
 * account can keep going on when only one model ran out.
 *
 * Nothing here reads a store or a clock: the out-of-usage service gathers the
 * facts and asks these functions, so every rule is one table-driven test.
 *
 * @module services/session/fleet/limit-state
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { LimitPlan, LimitState, SessionLimit } from '@dorkos/shared/schemas';

/**
 * The launch origins (`TurnOrigin.kind`) whose sessions may carry their work
 * to another account: a person's own session, one an agent started for them,
 * and one that is itself a carry-over. Every other surface (a room, a
 * schedule, a binding, an agent DM, a connector event, the test harness) and a
 * session bound before `launch_origin` existed can only wait for the reset.
 * Deny by default: a kind added later is not in this list until someone decides.
 */
export const CARRY_OVER_ORIGINS: ReadonlySet<string> = new Set([
  'interactive',
  'agent-launch',
  'account-handoff',
]);

/**
 * Whether a session with this recorded launch origin may carry its work over.
 *
 * @param launchOrigin - `session_metadata.launch_origin`, or `null` when none was recorded.
 */
export function carryOverAllowed(launchOrigin: string | null): boolean {
  return launchOrigin !== null && CARRY_OVER_ORIGINS.has(launchOrigin);
}

/**
 * The model the same account can keep going on when only one model's window
 * ran out and no advisor said otherwise: `sonnet` when the stopped window is
 * `seven_day_opus` or a `model:*` bucket that is not Sonnet's, else none.
 *
 * @param window - The window key that stopped the turn.
 */
export function defaultModelFallback(window: string): string | undefined {
  if (window === 'seven_day_opus') return 'sonnet';
  if (window.startsWith('model:') && !window.toLowerCase().includes('sonnet')) return 'sonnet';
  return undefined;
}

/** One account the session could move to, as the state rules read it. */
export interface StateCandidate {
  /** The account's id. */
  id: string;
  /** Whether work may go to it now. */
  eligible: boolean;
  /** When its current limit resets, or `null` when unknown or not limited. */
  resetsAt: string | null;
}

/** Everything {@link deriveLimitState} decides from. */
export interface LimitStateInput {
  /** The limit, with its current plan. */
  limit: Pick<SessionLimit, 'accountId' | 'resetsAt' | 'scope' | 'plan'>;
  /** The model offered in place of the one that ran out, when there is one. */
  modelFallback: string | undefined;
  /** The limited account's own usage, when known. */
  accountUsage: Pick<AccountUsage, 'windows'> | null;
  /**
   * The other accounts the session could move to (the ranking, the limited
   * account excluded), including any other runtime's account an advisor offered.
   */
  candidates: readonly StateCandidate[];
}

/** What {@link deriveLimitState} answers. */
export interface DerivedLimitState {
  /** The state. */
  state: LimitState;
  /** With `all-accounts-out`: the account that comes back first, and when. */
  allOut?: { accountId: string; resetsAt: string | null };
}

/** Whether a window of the account still has room: absent, or not rejected and under 100%. */
function windowHasRoom(usage: Pick<AccountUsage, 'windows'> | null, key: string): boolean {
  const window = usage?.windows.find((w) => w.key === key);
  if (!window) return true;
  if (window.status === 'rejected') return false;
  return (window.usedPct ?? 0) < 100;
}

/** Whether the plan says this session can only wait. */
function carryOverRefused(plan: LimitPlan): boolean {
  return (plan.mode === 'ask' || plan.mode === 'waiting') && plan.carryOver === false;
}

/**
 * The account that comes back first: the earliest known reset among the
 * candidates and the limited account itself, else the limited account (or the
 * first candidate) with an unknown reset.
 */
function earliestReset(input: LimitStateInput): { accountId: string; resetsAt: string | null } {
  const pool: StateCandidate[] = [...input.candidates];
  if (input.limit.accountId) {
    pool.push({ id: input.limit.accountId, eligible: false, resetsAt: input.limit.resetsAt });
  }
  let best: { accountId: string; resetsAt: string | null } | undefined;
  for (const candidate of pool) {
    if (candidate.resetsAt === null) continue;
    const at = Date.parse(candidate.resetsAt);
    if (Number.isNaN(at)) continue;
    if (!best || best.resetsAt === null || at < Date.parse(best.resetsAt)) {
      best = { accountId: candidate.id, resetsAt: candidate.resetsAt };
    }
  }
  if (best) return best;
  const fallbackId = input.limit.accountId ?? pool[0]?.id ?? 'default';
  return { accountId: fallbackId, resetsAt: null };
}

/**
 * The state of a limited session, by the spec's precedence when more than one
 * applies: `moved` > `handing-off` > `reset-ready` > `waiting-reset` >
 * `model-limited` > `wait-only` > `all-accounts-out` > `limited`.
 *
 * @param input - The limit and the facts around it.
 */
export function deriveLimitState(input: LimitStateInput): DerivedLimitState {
  const { plan } = input.limit;
  if (plan.mode === 'continued') return { state: 'moved' };
  if (plan.mode === 'auto') return { state: 'handing-off' };
  if (plan.mode === 'waiting') {
    return {
      state:
        plan.resetConfirmedAt !== undefined || plan.unconfirmed ? 'reset-ready' : 'waiting-reset',
    };
  }
  if (
    input.limit.scope === 'model' &&
    input.modelFallback !== undefined &&
    windowHasRoom(input.accountUsage, 'five_hour') &&
    windowHasRoom(input.accountUsage, 'seven_day')
  ) {
    return { state: 'model-limited' };
  }
  if (carryOverRefused(plan) || input.candidates.length === 0) return { state: 'wait-only' };
  if (!input.candidates.some((c) => c.eligible)) {
    return { state: 'all-accounts-out', allOut: earliestReset(input) };
  }
  return { state: 'limited' };
}
