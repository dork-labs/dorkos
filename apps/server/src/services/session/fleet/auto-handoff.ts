/**
 * Core's automatic handoff (spec `claude-account-fleet` D9 "Automatic
 * handoff"): when the account advisor answers a limit with `auto` for a
 * session it did NOT claim, core moves the work itself.
 *
 * - **One timer per session**, armed whenever an unclaimed `auto` plan is
 *   written and cleared by any plan that replaces it (a wait, a cancel, a
 *   person's continue). The session's next turn deletes its row, so a timer
 *   that fires after it finds nothing to do. Timers do not survive a restart:
 *   at boot a stored `auto` plan reads `ask`.
 * - **At `fireAt`** core re-ranks as the advisor (`caller: 'advisor'`); if the
 *   target is still eligible and the launch cap (`AGENT_LAUNCH_MAX_LIVE`) has
 *   room, it carries the work over, unattended. Otherwise the plan drops to
 *   `ask` and `account.limited` is raised again, saying it could not move it
 *   automatically.
 * - **At most one automatic carry-over per limit episode**, and it shares the
 *   episode's in-flight marker with a person's continue, so a person's click
 *   racing the timer starts one session.
 *
 * A CLAIMED session's `auto` plan is flow's to run; core only settles it
 * (`armClaimedHandoff` in `limit-plans.ts`).
 *
 * @module services/session/fleet/auto-handoff
 */
import type { ContinueSessionResponse } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { rankAccounts } from '../../core/usage/account-ranking.js';
import { notifyAutoMoveFailed } from '../../notifications/emitters/session-lifecycle.js';
import type { MeshCore } from '@dorkos/mesh';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { isAgentLaunchCapFull } from '../launch/launch-session.js';
import { carryOverSession, unpointedCarryOver } from './carry-over.js';
import {
  ContinueError,
  continueInFlight,
  episodeKey,
  trackContinue,
} from './continue-in-flight.js';
import {
  LIMIT_RUNTIME,
  PlanChangedError,
  cwdOf,
  isClaudeCodeLimitNow,
  limitClock,
  mayCarryOver,
  onLimitPlanWritten,
  readStoredLimit,
  writePlan,
} from './limit-plans.js';
import type { StoredSessionLimit } from './session-limit-store.js';

/** What the handoff needs from the app, read at the moment it fires. */
export interface AutoHandoffDeps {
  /** The Activity feed writer, when the server has one. */
  activity: () => ActivityService | undefined;
  /** Mesh and the room port, for the launch. */
  launchDeps: () => {
    meshCore: MeshCore | undefined;
    roomSessionPlace: RoomSessionPlacePort | undefined;
  };
}

let deps: AutoHandoffDeps | undefined;

/** One timer per session row, with the plan it was armed for. */
const autoTimers = new Map<string, { timer: NodeJS.Timeout; since: string; fireAt: string }>();

function clearAutoTimer(sessionId: string): void {
  const armed = autoTimers.get(sessionId);
  if (armed) clearTimeout(armed.timer);
  autoTimers.delete(sessionId);
}

/**
 * Keep the session's timer in step with a plan just written: armed for an
 * unclaimed `auto` plan, cleared for anything else. Re-writing the same plan
 * (a state refresh) keeps the timer it has.
 */
function syncAutoTimer(stored: StoredSessionLimit): void {
  const plan = stored.limit.plan;
  // Only a Claude Code session carries over today: another runtime's limit
  // never gets a timer, whatever its plan says.
  if (plan.mode !== 'auto' || stored.claimedBy || !isClaudeCodeLimitNow(stored)) {
    clearAutoTimer(stored.sessionId);
    return;
  }
  const armed = autoTimers.get(stored.sessionId);
  if (armed && armed.since === stored.limit.since && armed.fireAt === plan.fireAt) return;
  clearAutoTimer(stored.sessionId);
  const delay = Math.max(0, Date.parse(plan.fireAt) - limitClock().getTime());
  const since = stored.limit.since;
  const timer = setTimeout(() => {
    autoTimers.delete(stored.sessionId);
    // A failure is already logged, told and written as `ask`.
    void fireAutoHandoff(stored.sessionId, since, plan.fireAt).catch(() => undefined);
  }, delay);
  timer.unref?.();
  autoTimers.set(stored.sessionId, { timer, since, fireAt: plan.fireAt });
}

/**
 * Could not move it: the plan goes back to `ask` (only while it is still the
 * `auto` plan that fired), and the person is told again.
 */
async function autoHandoffFailed(fired: StoredSessionLimit, reason: string): Promise<never> {
  const fireAt = fired.limit.plan.mode === 'auto' ? fired.limit.plan.fireAt : undefined;
  let asked: StoredSessionLimit | undefined;
  let latest = readStoredLimit(fired.sessionId);
  for (let attempt = 1; latest && attempt <= 3; attempt++) {
    const plan = latest.limit.plan;
    if (
      latest.limit.since !== fired.limit.since ||
      plan.mode !== 'auto' ||
      plan.fireAt !== fireAt
    ) {
      break;
    }
    try {
      asked = await writePlan(latest, { mode: 'ask' });
      break;
    } catch (err) {
      if (!(err instanceof PlanChangedError)) throw err;
      latest = readStoredLimit(fired.sessionId);
    }
  }
  logger.info('[auto-handoff] could not move the session automatically; it asks the person', {
    sessionId: fired.sessionId,
    reason,
  });
  if (asked) notifyAutoMoveFailed(asked.sessionId, cwdOf(asked), asked.limit);
  throw new ContinueError(
    409,
    'AUTO_MOVE_FAILED',
    'The automatic move could not start. Choose an account to continue on.'
  );
}

/** Whether the advisor, asked again now, still offers `target` as eligible. */
async function targetStillEligible(stored: StoredSessionLimit, target: string): Promise<boolean> {
  try {
    const ranking = await rankAccounts({
      purpose: 'continue',
      caller: 'advisor',
      cwd: cwdOf(stored) ?? '',
      runtime: LIMIT_RUNTIME,
      sessionId: stored.sessionId,
      ...(stored.limit.accountId ? { excludeAccountId: stored.limit.accountId } : {}),
    });
    return ranking.accounts.some(
      (a) => a.runtime === LIMIT_RUNTIME && a.id === target && a.eligible
    );
  } catch (err) {
    logger.warn('[auto-handoff] could not rank accounts for an automatic move', {
      sessionId: stored.sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Fire an unclaimed session's `auto` plan: re-rank (as the advisor), and carry
 * the work over unattended when the target is still eligible and the launch cap
 * has room; otherwise drop to `ask` and tell the person again.
 *
 * @param sessionId - The session's row id.
 * @param since - The episode the timer was armed for.
 * @param fireAt - The plan's `fireAt` the timer was armed for.
 * @returns The new session, `undefined` when there was nothing to fire.
 * @throws {ContinueError} `AUTO_MOVE_FAILED` when it could not move it.
 * @internal Exported for tests; the timer calls it.
 */
export function fireAutoHandoff(
  sessionId: string,
  since: string,
  fireAt: string
): Promise<ContinueSessionResponse | undefined> {
  const stored = readStoredLimit(sessionId);
  const plan = stored?.limit.plan;
  if (
    !deps ||
    !stored ||
    stored.limit.since !== since ||
    plan?.mode !== 'auto' ||
    plan.fireAt !== fireAt ||
    stored.claimedBy ||
    !isClaudeCodeLimitNow(stored) ||
    // Already moved; only the pointer is still being retried.
    unpointedCarryOver(stored)
  ) {
    return Promise.resolve(undefined);
  }
  // At most one automatic carry-over per episode: it fires only while the plan
  // is still this very `auto` (same episode, same `fireAt`), and every way a
  // fire ends rewrites that plan (`continued`, or `ask`).
  const key = episodeKey(stored);
  // A person's continue is already moving it: that one wins. If it fails, the
  // plan is still this `auto` with its time past, so fire then (re-checked).
  const pending = continueInFlight(key);
  if (pending) {
    return pending.then(
      () => undefined,
      () => fireAutoHandoff(sessionId, since, fireAt)
    );
  }
  const { activity, launchDeps } = deps;
  const target = plan.target;
  // Marked in flight in this same synchronous step, like a person's continue.
  return trackContinue(
    key,
    (async (): Promise<ContinueSessionResponse> => {
      if (!mayCarryOver(stored)) return autoHandoffFailed(stored, 'launch origin');
      if (isAgentLaunchCapFull()) return autoHandoffFailed(stored, 'launch cap full');
      if (!(await targetStillEligible(stored, target))) {
        return autoHandoffFailed(stored, 'target no longer eligible');
      }
      try {
        const newSessionId = await carryOverSession({
          source: stored,
          targetAccountId: target,
          by: 'advisor',
          launch: launchDeps(),
          activity: activity(),
        });
        return { sessionId: newSessionId };
      } catch (err) {
        return autoHandoffFailed(stored, err instanceof Error ? err.message : String(err));
      }
    })()
  );
}

/**
 * Start core's automatic handoff: arm a timer for every unclaimed `auto` plan
 * written from now on.
 *
 * @param opts - What a handoff needs from the app, read when it fires.
 * @returns A function that stops it and clears every timer.
 */
export function installAutoHandoff(opts: AutoHandoffDeps): () => void {
  deps = opts;
  const stopListening = onLimitPlanWritten(syncAutoTimer);
  return () => {
    stopListening();
    for (const id of [...autoTimers.keys()]) clearAutoTimer(id);
    deps = undefined;
  };
}
