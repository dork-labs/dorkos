/**
 * What happens next for a session whose account ran out (spec
 * `claude-account-fleet` D9 "The plan" and "The states core emits", and §X
 * "One writer for a flow run").
 *
 * When a session starts holding a new usage limit, this works out its plan and
 * state and keeps them current:
 *
 * - **The plan.** A session that did not start here (its server-held
 *   `launch_origin` is not one of {@link CARRY_OVER_ORIGINS}) can only wait:
 *   `{ mode: 'ask', carryOver: false }`, and the advisor is not asked. For the
 *   rest, the account advisor (when one is registered) is asked once whether it
 *   CLAIMS the session (a flow run, which only flow moves) and what to do
 *   (`onLimited`). No advisor, or any failure, means `ask`.
 * - **The state** ({@link deriveLimitState}), recomputed on every plan change
 *   and whenever an account's usage changes.
 * - **The claim is stored**, never asked live (`claimed_by`), and asked again of
 *   every newly registered advisor for rows nobody claimed.
 * - **A claimed handoff settles in 10 minutes**: a claimed `auto` plan with no
 *   `markContinued` 10 minutes after `fireAt` goes back to `ask`. The timer is
 *   in memory, and at boot every `auto` plan reads `ask`. An UNCLAIMED `auto`
 *   plan is core's own handoff: the continue service fires it at `fireAt`.
 *
 * Every write goes to the `session_limits` row first (the truth, read by every
 * route) and is then pushed onto the session's live stream, when it has one.
 *
 * @module services/session/fleet/limit-plans
 */
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { LimitPlan, SessionLimit } from '@dorkos/shared/schemas';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { LimitedSessionInfo, SessionInfo } from '@dorkos/extension-api/server';
import { logger } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  accountAdvisorOwner,
  callAdvisor,
  hasAccountAdvisor,
  onAccountAdvisorRegistered,
  validateLimitedPlan,
} from '../../core/usage/account-advisor.js';
import { rankAccounts, type AccountRanking } from '../../core/usage/account-ranking.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { onProjectorLimitSet, peekProjector } from '../session-state-projector.js';
import { flowRunsFor } from './flow-run-link.js';
import { carryOverAllowed, defaultModelFallback, deriveLimitState } from './limit-state.js';
import {
  getSessionLimitStore,
  type SessionLimitStore,
  type StoredSessionLimit,
} from './session-limit-store.js';

/**
 * Whether core resumes a waiting session by itself once its reset is
 * confirmed. On since the reset-and-resume engine (`resume-service.ts`, task
 * 5.2) landed; it was off before so no unclaimed `waiting` plan promised a
 * resume nothing would run. A claimed session's `autoResume` is the advisor's
 * to honour, and is kept.
 */
export const CORE_AUTO_RESUME_AVAILABLE: boolean = true;

/** How long a claimed handoff may go unreported before the plan goes back to `ask`. */
export const CLAIMED_HANDOFF_SETTLE_MS = 10 * 60_000;

/** The runtime whose sessions carry usage limits today. */
export const LIMIT_RUNTIME = 'claude-code';

/** The clock, swappable in tests. */
let now: () => Date = () => new Date();

/**
 * The id a session's `session_limits` row is kept under: the canonical id its
 * live projector answers to, else the id as given.
 *
 * @param sessionId - The session id a caller named.
 */
export function limitRowId(sessionId: string): string {
  return peekProjector(sessionId)?.sessionId ?? sessionId;
}

/**
 * A session's stored limit, under whichever id the caller named.
 *
 * @param sessionId - The session id a caller named.
 */
export function readStoredLimit(sessionId: string): StoredSessionLimit | undefined {
  const store = getSessionLimitStore();
  if (!store) return undefined;
  return store.get(limitRowId(sessionId)) ?? store.get(sessionId);
}

/** The session's recorded launch origin, or `null` when unknown or unreadable. */
function launchOriginOf(sessionId: string): string | null {
  try {
    return runtimeRegistry.getSessionLaunchOrigin(sessionId);
  } catch {
    return null;
  }
}

/**
 * Whether a stored limit's session may carry its work to another account.
 *
 * @param stored - The session's stored limit.
 */
export function mayCarryOver(stored: StoredSessionLimit): boolean {
  return carryOverAllowed(launchOriginOf(stored.sessionId));
}

/**
 * Whether a stored limit belongs to a session bound to Claude Code, the one
 * runtime core can continue from today. Codex and OpenCode record limits in the
 * same table, but until a carry-over can start from them their sessions only
 * wait: no model fallback, no advisor, and no ranking of Claude accounts. Deny
 * by default: an unbound or unreadable session is not one.
 *
 * @param stored - The session's stored limit.
 */
export async function isClaudeCodeLimit(stored: StoredSessionLimit): Promise<boolean> {
  try {
    const resolved = await runtimeRegistry.resolveSessionRuntime(stored.sessionId);
    return resolved.bound && resolved.type === LIMIT_RUNTIME;
  } catch {
    return false;
  }
}

/**
 * {@link isClaudeCodeLimit}, read synchronously from the binding row, for a
 * caller that must decide in the same step it acts (the automatic handoff's
 * timer and fire, which mark their move in flight before any await). The same
 * answer: bound to Claude Code, deny by default.
 *
 * @param stored - The session's stored limit.
 */
export function isClaudeCodeLimitNow(stored: StoredSessionLimit): boolean {
  try {
    return (
      runtimeRegistry.getSessionBindings([stored.sessionId]).get(stored.sessionId)?.runtime ===
      LIMIT_RUNTIME
    );
  } catch {
    return false;
  }
}

/** The working directory a stored limit's session ran in. */
export function cwdOf(stored: StoredSessionLimit): string | undefined {
  return stored.cwd ?? peekProjector(stored.sessionId)?.cwd;
}

async function trackerItemOf(
  sessionId: string,
  cwd: string | undefined
): Promise<{ id: string } | undefined> {
  if (!cwd) return undefined;
  try {
    const link = (await flowRunsFor(cwd)).get(sessionId);
    return link ? { id: link.identifier } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session as the account advisor's single-writer methods see it.
 *
 * @param stored - The session's stored limit.
 */
export async function sessionInfoOf(stored: StoredSessionLimit): Promise<SessionInfo> {
  const cwd = cwdOf(stored) ?? '';
  const trackerItem = await trackerItemOf(stored.sessionId, cwd || undefined);
  return {
    sessionId: stored.sessionId,
    cwd,
    runtime: LIMIT_RUNTIME,
    accountId: stored.limit.accountId,
    ...(trackerItem ? { trackerItem } : {}),
  };
}

/**
 * The limited session as the account advisor's answering methods see it.
 *
 * @param stored - The session's stored limit.
 */
export async function limitedInfoOf(stored: StoredSessionLimit): Promise<LimitedSessionInfo> {
  const cwd = cwdOf(stored) ?? '';
  const trackerItem = await trackerItemOf(stored.sessionId, cwd || undefined);
  const model = await runtimeRegistry
    .getSessionSettings(stored.sessionId)
    .then((settings) => settings?.model ?? null)
    .catch(() => null);
  return {
    sessionId: stored.sessionId,
    cwd,
    accountId: stored.limit.accountId,
    window: stored.limit.window,
    resetsAt: stored.limit.resetsAt,
    scope: stored.scope,
    model,
    ...(trackerItem ? { trackerItem } : {}),
  };
}

/**
 * The accounts a limited session could continue on, ranked the way a person
 * is shown them (`caller: 'person'`, the limited account excluded).
 *
 * @param stored - The session's stored limit.
 */
export function rankForLimit(stored: StoredSessionLimit): Promise<AccountRanking> {
  return rankAccounts({
    purpose: 'continue',
    caller: 'person',
    cwd: cwdOf(stored) ?? '',
    runtime: LIMIT_RUNTIME,
    sessionId: stored.sessionId,
    ...(stored.limit.accountId ? { excludeAccountId: stored.limit.accountId } : {}),
  });
}

/**
 * The limited account's own usage, when the store knows it: by its id, else by
 * the folder the session ran in (a memory-only root).
 *
 * @param stored - The session's stored limit.
 */
export function limitedAccountUsage(stored: StoredSessionLimit): AccountUsage | null {
  const store = getAccountUsageStore();
  if (!store) return null;
  try {
    if (stored.limit.accountId) {
      return store.peek(LIMIT_RUNTIME, [stored.limit.accountId])[0] ?? null;
    }
    return stored.accountPath ? store.usageAtPath(LIMIT_RUNTIME, stored.accountPath) : null;
  } catch {
    return null;
  }
}

/** Whether an id names a registered (routable) account of the limited runtime. */
export function isRegisteredAccount(accountId: string): boolean {
  const store = getAccountUsageStore();
  if (!store) return false;
  return store.listAccounts(LIMIT_RUNTIME).some((a) => a.id === accountId && a.routable);
}

/** Called with a session's stored limit after every plan write. */
export type LimitPlanListener = (stored: StoredSessionLimit) => void;

const planListeners = new Set<LimitPlanListener>();

/**
 * Be told whenever a limited session's plan is written (a person's choice, the
 * advisor's, a timer's). The reset-and-resume service (`resume-service.ts`)
 * arms its timer for a `waiting` plan from here; a claimed row (`claimedBy`)
 * is flow's to resume.
 *
 * @param listener - Receives the stored limit as it now stands.
 * @returns A function that stops listening.
 */
export function onLimitPlanWritten(listener: LimitPlanListener): () => void {
  planListeners.add(listener);
  return () => {
    planListeners.delete(listener);
  };
}

/** Push a stored limit onto the session's live stream, when it has one. */
function publish(stored: StoredSessionLimit): void {
  const event: Omit<Extract<SessionEvent, { type: 'status_change' }>, 'seq'> = {
    type: 'status_change',
    status: { limit: stored.limit },
  };
  peekProjector(stored.sessionId)?.ingest(event);
}

/**
 * A plan write lost a race: the row still holds the same episode, but its plan
 * changed after the caller read it. The caller re-reads and decides again.
 */
export class PlanChangedError extends Error {
  /**
   * Build the error.
   *
   * @param sessionId - The session whose plan moved on.
   */
  constructor(readonly sessionId: string) {
    super(`The plan of session ${sessionId} changed while it was being decided.`);
    this.name = 'PlanChangedError';
  }
}

/** What {@link writePlan} changes besides the plan. */
interface PlanWriteExtras {
  /** The model offered in place of the one that ran out (planning only). */
  modelFallback?: string | undefined;
  /** The advisor that claimed the session (planning only). */
  claimedBy?: string | null;
  /**
   * Called after the state is derived and right before the write, with no
   * await in between: throwing refuses the write. For a decision that must not
   * land once something else started (a person's wait while a move runs).
   */
  beforeCommit?: () => void;
}

/**
 * Write a new plan over the plan the caller read (compare-and-set), recompute
 * the state from it, publish the result, and tell the plan listeners. Nothing
 * is written when the episode moved on (the session's next turn started, or a
 * newer limit).
 *
 * @param stored - The limit as the caller read it.
 * @param plan - The new plan.
 * @param extras - Planning-time fields.
 * @returns The limit as now stored, or `undefined` when the episode is gone.
 * @throws {PlanChangedError} When the plan changed after the caller read it.
 */
export async function writePlan(
  stored: StoredSessionLimit,
  plan: LimitPlan,
  extras: PlanWriteExtras = {}
): Promise<StoredSessionLimit | undefined> {
  const store = getSessionLimitStore();
  if (!store) return undefined;
  const modelFallback =
    'modelFallback' in extras ? extras.modelFallback : stored.limit.modelFallback;
  const next: StoredSessionLimit = {
    ...stored,
    limit: { ...stored.limit, plan },
    ...(extras.claimedBy !== undefined ? { claimedBy: extras.claimedBy } : {}),
  };
  const derived = await deriveFor(next, modelFallback);
  extras.beforeCommit?.();
  const written = commit(store, stored, next, derived, modelFallback, extras.claimedBy, true);
  if (written) return written;
  const now = store.get(stored.sessionId);
  if (now && now.limit.since === stored.limit.since) throw new PlanChangedError(stored.sessionId);
  return undefined;
}

/** The state of a stored limit, from the current ranking and usage. */
async function deriveFor(stored: StoredSessionLimit, modelFallback: string | undefined) {
  let candidates: { id: string; eligible: boolean; resetsAt: string | null }[] = [];
  // Another runtime's session is never ranked against Claude accounts.
  if (!(await isClaudeCodeLimit(stored))) {
    return deriveLimitState({ limit: stored.limit, modelFallback, accountUsage: null, candidates });
  }
  try {
    const ranking = await rankForLimit(stored);
    candidates = ranking.accounts.map((a) => ({
      id: a.id,
      eligible: a.eligible,
      resetsAt: a.usage.limit?.resetsAt ?? null,
    }));
  } catch (err) {
    logger.warn('[limit-plans] could not rank accounts for a limited session', {
      sessionId: stored.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return deriveLimitState({
    limit: stored.limit,
    modelFallback,
    accountUsage: limitedAccountUsage(stored),
    candidates,
  });
}

function commit(
  store: SessionLimitStore,
  read: StoredSessionLimit,
  next: StoredSessionLimit,
  derived: ReturnType<typeof deriveLimitState>,
  modelFallback: string | undefined,
  claimedBy: string | null | undefined,
  writesPlan: boolean
): StoredSessionLimit | undefined {
  // Always conditional on the plan the caller read: a plan write never lands
  // over a newer decision, and a state computed from a stale plan never lands
  // over the state its successor already derived.
  const written = store.update(
    read.sessionId,
    read.limit.since,
    {
      ...(writesPlan ? { plan: next.limit.plan } : {}),
      state: derived.state,
      modelFallback: modelFallback ?? null,
      allOut: derived.allOut ?? null,
      ...(claimedBy !== undefined ? { claimedBy } : {}),
    },
    { expectPlanJson: read.planJson }
  );
  if (!written) return undefined;
  const limit: SessionLimit = {
    ...next.limit,
    state: derived.state,
  };
  delete limit.modelFallback;
  delete limit.allOut;
  if (modelFallback) limit.modelFallback = modelFallback;
  if (derived.allOut) limit.allOut = derived.allOut;
  const stored: StoredSessionLimit = {
    ...next,
    limit,
    state: derived.state,
    planJson: writesPlan ? JSON.stringify(next.limit.plan) : read.planJson,
  };
  publish(stored);
  for (const listener of planListeners) {
    try {
      listener(stored);
    } catch (err) {
      logger.warn('[limit-plans] a plan listener failed', { err: String(err) });
    }
  }
  return stored;
}

/**
 * Recompute a limited session's state from what is true now (usage, ranking)
 * without changing its plan; writes and publishes only when it changed. It
 * never writes a plan, and its state lands only while the plan it derived
 * from is still the stored one (a plan write in between derived its own).
 *
 * @param sessionId - The session.
 */
export async function refreshLimitState(sessionId: string): Promise<void> {
  const store = getSessionLimitStore();
  const stored = readStoredLimit(sessionId);
  if (!store || !stored) return;
  const derived = await deriveFor(stored, stored.limit.modelFallback);
  const sameAllOut =
    JSON.stringify(derived.allOut ?? null) === JSON.stringify(stored.limit.allOut ?? null);
  if (derived.state === stored.state && sameAllOut) return;
  commit(store, stored, stored, derived, stored.limit.modelFallback, undefined, false);
}

// === Claimed handoffs: the 10-minute rule ===

const claimedHandoffTimers = new Map<string, NodeJS.Timeout>();

/**
 * Stop waiting for a claimed handoff to report back.
 *
 * @param sessionId - The session's row id.
 */
export function clearClaimedHandoff(sessionId: string): void {
  const timer = claimedHandoffTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  claimedHandoffTimers.delete(sessionId);
}

/**
 * Wait for flow to report a claimed `auto` plan's handoff: if no
 * `markContinued` has landed {@link CLAIMED_HANDOFF_SETTLE_MS} after `fireAt`,
 * the plan goes back to `ask` (logged). Any `auto` plan on a claimed row, from
 * a person's continue or from the advisor's `onLimited`.
 *
 * @param stored - The limit as stored with its claimed `auto` plan.
 */
export function armClaimedHandoff(stored: StoredSessionLimit): void {
  const plan = stored.limit.plan;
  if (plan.mode !== 'auto') return;
  clearClaimedHandoff(stored.sessionId);
  const due = Date.parse(plan.fireAt) + CLAIMED_HANDOFF_SETTLE_MS - now().getTime();
  const timer = setTimeout(
    () => {
      claimedHandoffTimers.delete(stored.sessionId);
      const current = readStoredLimit(stored.sessionId);
      const currentPlan = current?.limit.plan;
      if (
        !current ||
        current.limit.since !== stored.limit.since ||
        currentPlan?.mode !== 'auto' ||
        currentPlan.fireAt !== plan.fireAt
      ) {
        return;
      }
      logger.info('[limit-plans] a claimed handoff was never reported, so the session asks again', {
        sessionId: stored.sessionId,
        claimedBy: stored.claimedBy,
        target: plan.target,
      });
      void writePlan(current, { mode: 'ask' }).catch((err) => {
        // A newer decision (markContinued, a person's wait) landed first: it wins.
        if (!(err instanceof PlanChangedError)) throw err;
      });
    },
    Math.max(0, due)
  );
  timer.unref?.();
  claimedHandoffTimers.set(stored.sessionId, timer);
}

// === Planning a new limit ===

/** Episodes being planned right now, so a person's action waits for the plan first. */
const planning = new Map<string, Promise<void>>();

/**
 * Wait for any planning of this session's current limit to finish, so a
 * person's action never races the advisor's first answer.
 *
 * @param sessionId - The session's row id.
 */
export async function planningSettled(sessionId: string): Promise<void> {
  await planning.get(sessionId);
}

/** The advisor's model fallback, else the default one, for a model-scoped limit. */
async function modelFallbackFor(
  stored: StoredSessionLimit,
  info: LimitedSessionInfo
): Promise<string | undefined> {
  if (stored.scope !== 'model') return undefined;
  const answer = await callAdvisor('modelFallback', info);
  if (answer === undefined) return defaultModelFallback(stored.limit.window);
  if (answer === null) return undefined;
  const model = (answer as { model?: unknown }).model;
  return typeof model === 'string' && model.trim().length > 0
    ? model.trim()
    : defaultModelFallback(stored.limit.window);
}

/** Ask the advisor whether it claims the session; its owner id when it does. */
async function askClaim(stored: StoredSessionLimit): Promise<string | null> {
  if (!hasAccountAdvisor()) return null;
  const owner = accountAdvisorOwner();
  const answer = await callAdvisor('claims', await sessionInfoOf(stored));
  return answer === true && owner !== undefined && accountAdvisorOwner() === owner ? owner : null;
}

async function planEpisode(stored: StoredSessionLimit): Promise<void> {
  if (!(await isClaudeCodeLimit(stored))) {
    // Only a Claude Code session can continue elsewhere today: another
    // runtime's limit shows, and waits.
    await writePlan(stored, { mode: 'ask', carryOver: false }, { modelFallback: undefined });
    return;
  }
  const carryOver = mayCarryOver(stored);
  const info = await limitedInfoOf(stored);
  const modelFallback = await modelFallbackFor(stored, info);
  if (!carryOver) {
    // It did not start here: it can only wait, and the advisor is not asked.
    await writePlan(stored, { mode: 'ask', carryOver: false }, { modelFallback });
    return;
  }
  let plan: LimitPlan = { mode: 'ask' };
  let claimedBy: string | null = null;
  if (hasAccountAdvisor()) {
    claimedBy = await askClaim(stored);
    const answer = validateLimitedPlan(await callAdvisor('onLimited', info), {
      limitedAccountId: stored.limit.accountId,
      isRegistered: isRegisteredAccount,
    });
    if (answer?.mode === 'wait') {
      plan = {
        mode: 'waiting',
        resumeAt: answer.resumeAt ?? stored.limit.resetsAt,
        autoResume: claimedBy !== null || CORE_AUTO_RESUME_AVAILABLE,
      };
    } else if (answer?.mode === 'auto') {
      // A claimed session's automatic handoff is flow's to run: core shows the
      // countdown and settles it if flow never reports back. An unclaimed one
      // is core's: the continue service arms its timer when this plan is
      // written (`delaySeconds` is already clamped to 0..3600).
      plan = {
        mode: 'auto',
        target: answer.target,
        fireAt: new Date(now().getTime() + answer.delaySeconds * 1000).toISOString(),
      };
    }
  }
  const written = await writePlan(stored, plan, { modelFallback, claimedBy });
  if (written?.claimedBy && written.limit.plan.mode === 'auto') armClaimedHandoff(written);
}

/**
 * Work out the plan and state for a limit a session just started holding.
 * Never throws; a failure leaves the plan at `ask`.
 *
 * @param sessionId - The session's id.
 * @param since - The new episode (`limit.since`).
 */
export function planNewLimit(sessionId: string, since: string): Promise<void> {
  const rowId = limitRowId(sessionId);
  const stored = readStoredLimit(rowId);
  if (!stored || stored.limit.since !== since) return Promise.resolve();
  const run = planEpisode(stored)
    .catch((err) => {
      if (err instanceof PlanChangedError) {
        logger.info('[limit-plans] a newer decision landed while planning; it stands', {
          sessionId: rowId,
        });
        return;
      }
      logger.warn('[limit-plans] could not plan a limited session; it asks the person', {
        sessionId: rowId,
        err: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      if (planning.get(rowId) === run) planning.delete(rowId);
    });
  planning.set(rowId, run);
  return run;
}

/**
 * Ask a newly registered advisor to claim every row nobody claimed that still
 * waits on a person or a reset (a limit that landed while the Flow extension
 * was reloading). Each answer is stored.
 *
 * @param ownerId - The advisor's extension id.
 */
export async function reclaimForAdvisor(ownerId: string): Promise<void> {
  const store = getSessionLimitStore();
  if (!store) return;
  for (const stored of store.list()) {
    const mode = stored.limit.plan.mode;
    if (stored.claimedBy || (mode !== 'ask' && mode !== 'waiting')) continue;
    if (!mayCarryOver(stored) || !(await isClaudeCodeLimit(stored))) continue;
    if (accountAdvisorOwner() !== ownerId) return;
    const answer = await callAdvisor('claims', await sessionInfoOf(stored));
    if (answer !== true || accountAdvisorOwner() !== ownerId) continue;
    store.update(stored.sessionId, stored.limit.since, { claimedBy: ownerId });
  }
}

/**
 * At boot: timers did not survive the restart, so every `auto` plan reads
 * `ask` (spec D9, §X rule c). A later `markContinued` is still accepted.
 */
export function settleAutoPlansAtBoot(): void {
  const store = getSessionLimitStore();
  if (!store) return;
  for (const stored of store.list()) {
    if (stored.limit.plan.mode !== 'auto') continue;
    store.update(stored.sessionId, stored.limit.since, {
      plan: { mode: 'ask' },
      state: 'limited',
    });
    logger.info('[limit-plans] a handoff pending at shutdown now asks the person', {
      sessionId: stored.sessionId,
    });
    void refreshLimitState(stored.sessionId);
  }
}

/**
 * Start working out plans for limited sessions: plan each new limit, keep the
 * states current as account usage changes, and ask each new advisor for its
 * claims. Settles `auto` plans left from before a restart first.
 *
 * @param opts.now - The clock (tests).
 * @returns A function that stops it and clears every timer.
 */
export function startLimitPlanning(opts: { now?: () => Date } = {}): () => void {
  if (opts.now) now = opts.now;
  settleAutoPlansAtBoot();
  const stops: (() => void)[] = [];
  stops.push(
    onProjectorLimitSet(({ sessionId, limit }) => {
      void planNewLimit(sessionId, limit.since);
    })
  );
  stops.push(
    onAccountAdvisorRegistered((ownerId) => {
      void reclaimForAdvisor(ownerId).catch((err) =>
        logger.warn('[limit-plans] could not ask the new advisor for its claims', {
          err: String(err),
        })
      );
    })
  );
  const usageStore = getAccountUsageStore();
  if (usageStore) {
    stops.push(
      usageStore.onChange(() => {
        const store = getSessionLimitStore();
        if (!store) return;
        for (const stored of store.list()) {
          if (stored.limit.plan.mode === 'ask') void refreshLimitState(stored.sessionId);
        }
      })
    );
  }
  return () => {
    for (const stop of stops) stop();
    for (const id of [...claimedHandoffTimers.keys()]) clearClaimedHandoff(id);
    planning.clear();
    now = () => new Date();
  };
}

/**
 * The current time as the planner sees it (the clock tests pin).
 *
 * @internal
 */
export function limitClock(): Date {
  return now();
}
