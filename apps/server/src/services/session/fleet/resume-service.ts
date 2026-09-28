/**
 * Wait for an account's reset, confirm it with a reading, and resume the
 * session by itself (spec `claude-account-fleet` D9 "Wait, then resume by
 * itself").
 *
 * For every UNCLAIMED session whose plan is `waiting` with a known `resumeAt`:
 *
 * - **One timer per session**, at `resumeAt` clamped to at least the limit's
 *   `resetsAt` and to now + 60 s (an advisor's past time never fires at once).
 *   Armed from the plan listener, cleared by any plan that replaces the wait
 *   (a continue, a cancel), by the session's next turn, and at shutdown.
 * - **Confirmation, never the clock.** At that moment the newest store reading
 *   of the limit's window must prove the window MOVED ON
 *   ({@link confirmsReset}). An account that can be probed is probed when the
 *   store cannot confirm it, and re-checked every 10 minutes, at most 6 times.
 *   One that cannot be probed is confirmed only from store readings, which the
 *   store's change feed delivers as they arrive. Either one still unconfirmed
 *   at the end becomes `reset-ready` with `plan.unconfirmed: true`, and is
 *   never resumed automatically.
 * - **On confirmation** the plan records `resetConfirmedAt` (state
 *   `reset-ready`), the person is told once per account and reset
 *   (`account.reset`), and, when `autoResume` is on and the session may
 *   continue (its launch origin), ONE continue turn goes to the same session,
 *   unattended, under the `account-resume` origin. At most one automatic
 *   resume per session per window reset (`session_metadata.last_auto_resume_for`,
 *   which outlives the `session_limits` row). Automatic resumes count against
 *   `AGENT_LAUNCH_MAX_LIVE`; one that finds the cap full is retried a minute
 *   later, so a reset that frees many sessions staggers them.
 * - **At boot** every stored `waiting` row is armed again, and a time already
 *   past is checked at once.
 *
 * A CLAIMED session (a flow run) gets no timer and no resume here, whether or
 * not its advisor is registered: flow resumes it (spec §X "One writer"). A
 * session bound to another runtime than Claude Code is never confirmed from
 * the store, probed or resumed today: its wait only reaches the unconfirmed
 * `reset-ready` fallback, 15 minutes after its time.
 *
 * @module services/session/fleet/resume-service
 */
import type { LimitPlan } from '@dorkos/shared/schemas';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { notifyAccountReset } from '../../notifications/emitters/session-lifecycle.js';
import {
  dispatchSessionMessage,
  isAgentLaunchCapFull,
  isSessionLaunchRefusal,
} from '../launch/launch-session.js';
import { onProjectorStatusChange } from '../session-state-projector.js';
import type { CarryOverLaunchDeps } from './continue-service.js';
import {
  PlanChangedError,
  cwdOf,
  isClaudeCodeLimitNow,
  isRegisteredAccount,
  limitClock,
  limitedAccountUsage,
  mayCarryOver,
  onLimitPlanWritten,
  readStoredLimit,
  writePlan,
} from './limit-plans.js';
import { getSessionLimitStore, type StoredSessionLimit } from './session-limit-store.js';

/** The message core sends when it resumes a session by itself (spec D9, quoted). */
export const ACCOUNT_RESUME_PROMPT = "Your account's usage has reset. Continue where you left off.";

/** The soonest a newly written wait may fire, so an advisor's past time never fires at once. */
export const RESUME_MIN_DELAY_MS = 60_000;

/** How long to wait before checking an unconfirmed account that can be probed again. */
export const RESET_RECHECK_MS = 10 * 60_000;

/** How many times an unconfirmed account that can be probed is checked again. */
export const RESET_MAX_RECHECKS = 6;

/** How long past its time an account that cannot be probed waits for a store reading. */
export const UNPROBED_RESET_GRACE_MS = 15 * 60_000;

/** How long an automatic resume that found the launch cap full waits to try again. */
export const RESUME_CAP_RETRY_MS = 60_000;

/** A reading at or above this share of the window does not confirm a reset. */
const CONFIRM_BELOW_PCT = 90;

/** The client an automatic resume is sent as; it keys the session's write lock. */
const RESUME_CLIENT_ID = 'account-resume';

/** One window reading, as the confirmation rule reads it. */
export type ResetReading = Pick<
  AccountUsage['windows'][number],
  'resetsAt' | 'usedPct' | 'status' | 'observedAt' | 'expired'
>;

/**
 * Whether a reading proves the limit's window MOVED ON, rather than that the
 * clock passed the reset: its `resetsAt` is later than the episode's, or (a
 * source that gives no reset time) it was observed after the episode's reset
 * (its `since` when that is unknown). Either way it must show room: not
 * rejected and under 90%. A reading the store only inferred to have expired
 * (`expired`, the clock's guess) never confirms.
 *
 * @param reading - The newest reading of the limit's window.
 * @param episode - The limit: its `resetsAt` and `since`.
 */
export function confirmsReset(
  reading: ResetReading,
  episode: { resetsAt: string | null; since: string }
): boolean {
  if (reading.expired || reading.status === 'rejected') return false;
  if (reading.usedPct !== null && reading.usedPct >= CONFIRM_BELOW_PCT) return false;
  if (reading.resetsAt !== null && episode.resetsAt !== null) {
    return Date.parse(reading.resetsAt) > Date.parse(episode.resetsAt);
  }
  return Date.parse(reading.observedAt) > Date.parse(episode.resetsAt ?? episode.since);
}

/**
 * Ask the runtime for a fresh reading of one account, recorded into the usage
 * store (task 2.2's probe). Resolves when the probe is done, whatever it
 * found; the service reads the store afterwards.
 *
 * @param accountId - A registry id, or `default`.
 * @param opts.resumeAt - When the wait was due: a probe throttle whose last
 *   attempt was before it should let this one through.
 */
export type ResetProbe = (accountId: string, opts: { resumeAt: string }) => Promise<void>;

/** What the resume service needs from the app. */
export interface ResumeServiceDeps {
  /** Mesh and the room port, read when a resume is sent. */
  launchDeps: () => CarryOverLaunchDeps;
  /**
   * The probe, when the runtime offers one. Without it every account is
   * confirmed from store readings alone (the 15-minute fallback).
   */
  probe?: ResetProbe;
}

/** One session's wait, from its timer to its resume. */
interface Watch {
  /** The episode it was armed for. */
  since: string;
  /** The plan's `resumeAt` it was armed for. */
  resumeAt: string;
  /** When it was due, in ms: the clamped `resumeAt`. */
  dueAt: number;
  /** The one pending timer: the check, a re-check, or a resume retry. */
  timer?: NodeJS.Timeout;
  /** Past its due time and still unconfirmed: a store reading may confirm it. */
  confirming: boolean;
  /** Confirmed or given up on: nothing confirms it again. */
  settled: boolean;
  /** Re-checks spent (an account that can be probed). */
  rechecks: number;
}

let deps: ResumeServiceDeps | undefined;
const watches = new Map<string, Watch>();

function clearWatch(sessionId: string): void {
  const watch = watches.get(sessionId);
  if (watch?.timer) clearTimeout(watch.timer);
  watches.delete(sessionId);
}

function schedule(sessionId: string, watch: Watch, delayMs: number, run: () => void): void {
  if (watch.timer) clearTimeout(watch.timer);
  const timer = setTimeout(
    () => {
      watch.timer = undefined;
      if (watches.get(sessionId) === watch) run();
    },
    Math.max(0, delayMs)
  );
  timer.unref?.();
  watch.timer = timer;
}

/** The stored limit while it is still the wait this watch was armed for. */
function currentWait(sessionId: string, watch: Watch): StoredSessionLimit | undefined {
  if (watches.get(sessionId) !== watch) return undefined;
  const stored = readStoredLimit(sessionId);
  const plan = stored?.limit.plan;
  if (
    !stored ||
    stored.limit.since !== watch.since ||
    plan?.mode !== 'waiting' ||
    plan.resumeAt !== watch.resumeAt ||
    stored.claimedBy
  ) {
    clearWatch(sessionId);
    return undefined;
  }
  return stored;
}

/** When a wait is due: its `resumeAt`, never before the reset nor before `floorMs`. */
function dueAtOf(stored: StoredSessionLimit, resumeAt: string, floorMs: number): number {
  const reset = stored.limit.resetsAt ? Date.parse(stored.limit.resetsAt) : Number.NaN;
  return Math.max(Date.parse(resumeAt), Number.isNaN(reset) ? -Infinity : reset, floorMs);
}

/**
 * Arm a session's wait. `floorMs` is the soonest it may fire: now + 60 s for
 * a plan just written, now at boot (a time already past checks at once).
 */
function arm(stored: StoredSessionLimit, resumeAt: string, floorMs: number): void {
  const watch: Watch = {
    since: stored.limit.since,
    resumeAt,
    dueAt: dueAtOf(stored, resumeAt, floorMs),
    confirming: false,
    settled: false,
    rechecks: 0,
  };
  watches.set(stored.sessionId, watch);
  schedule(stored.sessionId, watch, watch.dueAt - limitClock().getTime(), () => {
    void check(stored.sessionId, watch).catch((err) => logCheckFailure(stored.sessionId, err));
  });
}

function logCheckFailure(sessionId: string, err: unknown): void {
  logger.warn('[resume] could not check a waiting session’s reset', {
    sessionId,
    err: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Keep a session's watch in step with a plan just written: armed for an
 * unclaimed, unsettled `waiting` plan with a `resumeAt`, cleared for anything
 * else. Re-writing the same wait (confirming it, a state refresh) keeps it.
 */
function syncWatch(stored: StoredSessionLimit): void {
  const plan = stored.limit.plan;
  // `claimedBy` here is a backup: the fire-time recheck (`currentWait`) also refuses a claimed row.
  // Another runtime's wait is armed too, but only for the unconfirmed fallback.
  if (plan.mode !== 'waiting' || stored.claimedBy || plan.resumeAt === null) {
    clearWatch(stored.sessionId);
    return;
  }
  const watch = watches.get(stored.sessionId);
  if (watch && watch.since === stored.limit.since && watch.resumeAt === plan.resumeAt) return;
  clearWatch(stored.sessionId);
  if (plan.resetConfirmedAt !== undefined || plan.unconfirmed) return;
  arm(stored, plan.resumeAt, limitClock().getTime() + RESUME_MIN_DELAY_MS);
}

/** The newest store reading of the window that stopped the session. */
function readingOf(stored: StoredSessionLimit): ResetReading | undefined {
  try {
    return limitedAccountUsage(stored)?.windows.find((w) => w.key === stored.limit.window);
  } catch {
    return undefined;
  }
}

/**
 * Whether a store reading confirms the reset. Only a Claude Code limit's: the
 * store is read by this account id among Claude Code accounts, so another
 * runtime's limit (a Codex `default`) would be confirmed by the wrong account.
 */
function storeConfirms(stored: StoredSessionLimit): boolean {
  if (!isClaudeCodeLimitNow(stored)) return false;
  const reading = readingOf(stored);
  return reading !== undefined && confirmsReset(reading, stored.limit);
}

/**
 * Whether the account can be probed: a probe is wired, it has a ledger id, and
 * the limit is Claude Code's (the probe asks a Claude Code account).
 */
function canProbe(stored: StoredSessionLimit): boolean {
  const accountId = stored.limit.accountId;
  return (
    deps?.probe !== undefined &&
    accountId !== null &&
    isClaudeCodeLimitNow(stored) &&
    isRegisteredAccount(accountId)
  );
}

/**
 * The check at the due time and at each re-check: the store first, then a
 * probe when the account can be probed; unconfirmed, it re-checks or gives up.
 */
async function check(sessionId: string, watch: Watch): Promise<void> {
  let stored = currentWait(sessionId, watch);
  if (!stored || watch.settled) return;
  watch.confirming = true;
  if (storeConfirms(stored)) return confirm(stored, watch);
  const probe = deps?.probe;
  const accountId = stored.limit.accountId;
  if (probe && accountId !== null && canProbe(stored)) {
    try {
      await probe(accountId, { resumeAt: watch.resumeAt });
    } catch (err) {
      logger.warn('[resume] could not probe the account for its reset', {
        sessionId,
        accountId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    stored = currentWait(sessionId, watch);
    if (!stored || watch.settled) return;
    if (storeConfirms(stored)) return confirm(stored, watch);
    if (watch.rechecks >= RESET_MAX_RECHECKS) return giveUp(stored, watch);
    watch.rechecks += 1;
    schedule(sessionId, watch, RESET_RECHECK_MS, () => {
      void check(sessionId, watch).catch((err) => logCheckFailure(sessionId, err));
    });
    return;
  }
  // Only a store reading can confirm it; the change feed delivers one as it
  // arrives. Past the grace period, it stops waiting for one.
  const deadline = watch.dueAt + UNPROBED_RESET_GRACE_MS;
  const now = limitClock().getTime();
  if (now >= deadline) return giveUp(stored, watch);
  schedule(sessionId, watch, deadline - now, () => {
    void check(sessionId, watch).catch((err) => logCheckFailure(sessionId, err));
  });
}

/**
 * Change a waiting plan (confirm it, or mark it unconfirmed) over whatever the
 * latest read of the same wait says, re-reading after a compare-and-set miss.
 * Nothing is written once the wait is gone (a continue, a new turn, a claim).
 */
async function patchWait(
  sessionId: string,
  watch: Watch,
  patch: Partial<Extract<LimitPlan, { mode: 'waiting' }>>
): Promise<StoredSessionLimit | undefined> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const stored = currentWait(sessionId, watch);
    if (!stored || stored.limit.plan.mode !== 'waiting') return undefined;
    try {
      return await writePlan(stored, { ...stored.limit.plan, ...patch });
    } catch (err) {
      if (!(err instanceof PlanChangedError)) throw err;
    }
  }
  return undefined;
}

/** No reading confirmed it in time: `reset-ready`, unconfirmed, never resumed automatically. */
async function giveUp(stored: StoredSessionLimit, watch: Watch): Promise<void> {
  watch.settled = true;
  logger.info('[resume] no reading confirmed the reset; the session is ready, unconfirmed', {
    sessionId: stored.sessionId,
    accountId: stored.limit.accountId,
    rechecks: watch.rechecks,
  });
  await patchWait(stored.sessionId, watch, { unconfirmed: true });
  clearWatch(stored.sessionId);
}

function sameAccount(a: StoredSessionLimit, b: StoredSessionLimit): boolean {
  if (a.limit.accountId !== null || b.limit.accountId !== null) {
    return a.limit.accountId === b.limit.accountId;
  }
  return a.accountPath !== null && a.accountPath === b.accountPath;
}

/** How many of the account's sessions are waiting right now. */
function pausedOn(stored: StoredSessionLimit): number {
  return (getSessionLimitStore()?.list() ?? []).filter(
    (other) => other.limit.plan.mode === 'waiting' && sameAccount(other, stored)
  ).length;
}

/** A reading confirmed the reset: record it, tell the person, and resume when asked to. */
async function confirm(stored: StoredSessionLimit, watch: Watch): Promise<void> {
  watch.settled = true;
  if (watch.timer) clearTimeout(watch.timer);
  const resetConfirmedAt = limitClock().toISOString();
  // Counted before the write, while every session on the account still waits.
  const pausedCount = pausedOn(stored);
  const confirmed = await patchWait(stored.sessionId, watch, { resetConfirmedAt });
  if (!confirmed) return;
  logger.info('[resume] a reading confirmed the account’s reset', {
    sessionId: stored.sessionId,
    accountId: stored.limit.accountId,
  });
  // Once per account and reset, however many sessions were waiting on it:
  // the kind's dedupe key, checked against the notifications table, keeps it
  // to one across sessions and restarts.
  notifyAccountReset(stored.sessionId, cwdOf(stored), {
    accountId: stored.limit.accountId,
    accountPath: stored.accountPath,
    resetsAt: stored.limit.resetsAt,
    resetConfirmedAt,
    pausedCount: Math.max(pausedCount, 1),
  });
  await resume(confirmed, watch);
}

/** The episode an automatic resume is recorded against: its reset, else its start. */
function resumeKeyOf(stored: StoredSessionLimit): string {
  return stored.limit.resetsAt ?? stored.limit.since;
}

function lastAutoResumeFor(sessionId: string): string | null | undefined {
  try {
    return runtimeRegistry.getLastAutoResumeFor(sessionId);
  } catch (err) {
    logger.warn('[resume] could not read when the session was last resumed automatically', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Send the one automatic continue turn, when the plan asks for it and the
 * session may have it; otherwise the session stays `reset-ready`.
 */
async function resume(stored: StoredSessionLimit, watch: Watch): Promise<void> {
  const plan = stored.limit.plan;
  const sessionId = stored.sessionId;
  if (
    plan.mode !== 'waiting' ||
    !plan.autoResume ||
    stored.claimedBy ||
    !mayCarryOver(stored) ||
    !isClaudeCodeLimitNow(stored)
  ) {
    clearWatch(sessionId);
    return;
  }
  const key = resumeKeyOf(stored);
  const last = lastAutoResumeFor(sessionId);
  // Unreadable counts as "already": a second automatic turn is the worse mistake.
  if (last === undefined || last === key) {
    logger.info('[resume] already resumed once for this reset; the session is ready', {
      sessionId,
    });
    clearWatch(sessionId);
    return;
  }
  if (isAgentLaunchCapFull()) {
    retryResume(sessionId, watch);
    return;
  }
  const launch = deps?.launchDeps() ?? { meshCore: undefined, roomSessionPlace: undefined };
  const cwd = cwdOf(stored);
  // Recorded before the send, in the same synchronous step as the cap check
  // inside the dispatch, so the resumed turn's own limit reads it.
  runtimeRegistry.markAutoResumed(sessionId, key);
  let sent = false;
  try {
    const result = await dispatchSessionMessage({
      // The session is already bound: its own row is its power.
      origin: { kind: 'account-resume' },
      sessionId,
      request: { content: ACCOUNT_RESUME_PROMPT, ...(cwd ? { cwd } : {}) },
      clientId: RESUME_CLIENT_ID,
      meshCore: launch.meshCore,
      roomSessionPlace: launch.roomSessionPlace,
      // Nobody typed it: it counts against the cap on such sessions, and runs
      // like a timer-fired schedule, so an approval card never waits on nobody.
      countsTowardLaunchCap: true,
      unattended: true,
    });
    if (isSessionLaunchRefusal(result)) {
      if (result.refused === 'LAUNCH_CAP_FULL') {
        runtimeRegistry.markAutoResumed(sessionId, last);
        retryResume(sessionId, watch);
        return;
      }
      logger.warn('[resume] the automatic resume was refused; the session is ready', {
        sessionId,
        refused: result.refused,
      });
    } else {
      sent = result.accepted;
    }
  } catch (err) {
    logger.warn('[resume] could not send the automatic resume; the session is ready', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  if (!sent) runtimeRegistry.markAutoResumed(sessionId, last);
  else logger.info('[resume] resumed the session after its account’s reset', { sessionId });
  clearWatch(sessionId);
}

/** The cap is full: try again in a minute, while the session still waits, confirmed. */
function retryResume(sessionId: string, watch: Watch): void {
  schedule(sessionId, watch, RESUME_CAP_RETRY_MS, () => {
    const stored = currentWait(sessionId, watch);
    if (!stored) return;
    void resume(stored, watch).catch((err) => logCheckFailure(sessionId, err));
  });
}

/** A new store reading: every wait past its time may be confirmed by it. */
function onUsageChanged(): void {
  for (const [sessionId, watch] of [...watches]) {
    if (!watch.confirming || watch.settled) continue;
    const stored = currentWait(sessionId, watch);
    if (stored && storeConfirms(stored)) {
      void confirm(stored, watch).catch((err) => logCheckFailure(sessionId, err));
    }
  }
}

/**
 * At boot: timers did not survive the restart, but the plans did. Every
 * unclaimed `waiting` row is armed again (a time already past checks at
 * once), and one confirmed before the restart whose resume never went out is
 * resumed now.
 */
function rearmAtBoot(): void {
  const store = getSessionLimitStore();
  if (!store) return;
  const now = limitClock().getTime();
  for (const stored of store.listWaiting()) {
    const plan = stored.limit.plan;
    if (plan.mode !== 'waiting' || stored.claimedBy || plan.resumeAt === null) continue;
    if (plan.unconfirmed) continue;
    if (plan.resetConfirmedAt === undefined) {
      arm(stored, plan.resumeAt, now);
      continue;
    }
    void resumeConfirmedWait(stored.sessionId).catch((err) =>
      logCheckFailure(stored.sessionId, err)
    );
  }
}

/**
 * Send the automatic resume for a wait already confirmed, as the boot re-arm
 * does, with every gate of the normal path.
 *
 * @param sessionId - The waiting session.
 * @internal Exported for tests.
 */
export async function resumeConfirmedWait(sessionId: string): Promise<void> {
  const stored = readStoredLimit(sessionId);
  const plan = stored?.limit.plan;
  if (!stored || plan?.mode !== 'waiting' || plan.resumeAt === null) return;
  const watch: Watch = {
    since: stored.limit.since,
    resumeAt: plan.resumeAt,
    dueAt: limitClock().getTime(),
    confirming: false,
    settled: true,
    rechecks: 0,
  };
  watches.set(stored.sessionId, watch);
  await resume(stored, watch);
}

/**
 * Start the reset-and-resume service: arm every stored wait, and every wait
 * written from now on. Install after `startLimitPlanning`, which settles the
 * `auto` plans left from before a restart.
 *
 * @param opts - What a resume needs from the app.
 * @returns A function that stops it and clears every timer.
 */
export function installResumeService(opts: ResumeServiceDeps): () => void {
  deps = opts;
  const stops: (() => void)[] = [];
  stops.push(onLimitPlanWritten(syncWatch));
  // The session's next turn deletes its row: nothing is left to resume. A
  // backup for that turn_start delete, which the fire-time recheck already sees.
  stops.push(
    onProjectorStatusChange(({ sessionId, status }) => {
      if (status.lifecycle === 'streaming') clearWatch(sessionId);
    })
  );
  const usageStore = getAccountUsageStore();
  if (usageStore) stops.push(usageStore.onChange(onUsageChanged));
  rearmAtBoot();
  return () => {
    for (const stop of stops) stop();
    for (const id of [...watches.keys()]) clearWatch(id);
    deps = undefined;
  };
}
