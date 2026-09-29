/**
 * What a person can do about a session whose account ran out (spec
 * `claude-account-fleet` D9 "Endpoints", §X "One writer for a flow run"):
 * see the accounts it could continue on, continue it on one of them (or on
 * another model of the same account), wait for the reset, or cancel a pending
 * handoff. The routes in `routes/session-continue.ts` are thin over these.
 *
 * Every action reads the session's `session_limits` row, so it works the same
 * for a session with no live stream in this process, and answers 409 when the
 * session has no limit. A session the account advisor CLAIMED (a flow run) is
 * moved and held only by the advisor: continue, wait and cancel are handed to
 * it, and refused (503) when it cannot be reached rather than risk two writers.
 *
 * An UNCLAIMED session whose advisor planned `auto` is moved by core itself
 * (`auto-handoff.ts`, installed with this service); a person's continue and
 * that handoff share one in-flight marker per episode, so they start one
 * session between them.
 *
 * Also the recorder behind an extension's `accounts.markContinued`.
 *
 * @module services/session/fleet/continue-service
 */
import type { MeshCore } from '@dorkos/mesh';
import type {
  ContinueOptionsResponse,
  ContinueSessionRequest,
  ContinueSessionResponse,
  LimitPlan,
} from '@dorkos/shared/schemas';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { LEDGER_RUNTIMES, type LedgerRuntime } from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { accountAdvisorOwner, invokeAdvisor } from '../../core/usage/account-advisor.js';
import {
  setContinuationRecorder,
  type ContinuationTarget,
} from '../../core/usage/session-continuation.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { dispatchSessionMessage, isSessionLaunchRefusal } from '../launch/launch-session.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { configManager } from '../../core/config-manager.js';
import { assertAccountEligible, projectOfFolder } from '../../core/usage/account-eligibility.js';
import { notAllowedAccounts } from '../../core/usage/account-ranking.js';
import { peekProjector } from '../session-state-projector.js';
import {
  carryOverSession,
  clearUnpointedCarryOvers,
  recordCarryOverActivity,
  unpointedCarryOver,
} from './carry-over.js';
import {
  armClaimedHandoff,
  clearClaimedHandoff,
  isRegisteredAccount,
  limitClock,
  mayCarryOver,
  planningSettled,
  rankForLimit,
  limitRankingContext,
  cwdOf,
  readStoredLimit,
  sessionInfoOf,
  writePlan,
  isClaudeCodeLimit,
  CORE_AUTO_RESUME_AVAILABLE,
  LIMIT_RUNTIME,
  PlanChangedError,
} from './limit-plans.js';
import type { StoredSessionLimit } from './session-limit-store.js';
import {
  ContinueError,
  clearContinuesInFlight,
  continueInFlight,
  episodeKey,
  trackContinue,
} from './continue-in-flight.js';
import { installAutoHandoff } from './auto-handoff.js';

export { ContinueError } from './continue-in-flight.js';

/** The sentence for a session that can only wait for its reset (spec D9, quoted). */
export const WAIT_ONLY_MESSAGE =
  'This conversation did not start here, so it can only wait for the reset.';

/** The sentence when the Flow extension holds the session and cannot be reached (spec §X, quoted). */
export const FLOW_UNREACHABLE_MESSAGE = 'Flow could not be reached, so this was not changed.';

/** The first message a model switch sends to the same session. */
export const MODEL_CONTINUE_PROMPT = 'Continue where you left off.';

/** What starting a session needs from the app, for a person's continue or the timer's. */
export interface CarryOverLaunchDeps {
  /** Mesh, when running, so the source's agent path can be carried over. */
  meshCore: MeshCore | undefined;
  /** The room binding port the launch service asks. */
  roomSessionPlace: RoomSessionPlacePort | undefined;
}

/** What a continue needs from the app to start a session. */
export interface ContinueLaunchDeps extends CarryOverLaunchDeps {
  /** The client id a model switch's message is sent as. */
  clientId: string;
  /**
   * Whether the session's runtime offers the model: `null` when it does, else
   * the sentence to refuse with. The model picker's own gate.
   */
  checkModel: (runtime: AgentRuntime, model: string) => Promise<string | null>;
}

let activity: ActivityService | undefined;

/** A session with no limit: nothing to continue, wait for or cancel. */
function noLimit(): ContinueError {
  return new ContinueError(
    409,
    'NO_LIMIT',
    'This session has not run out of usage, so there is nothing to continue.'
  );
}

/** Read a session's limit after any planning in flight, or refuse with 409. */
async function requireLimit(sessionId: string): Promise<StoredSessionLimit> {
  const first = readStoredLimit(sessionId);
  if (!first) throw noLimit();
  await planningSettled(first.sessionId);
  const stored = readStoredLimit(first.sessionId);
  if (!stored) throw noLimit();
  return stored;
}

/** Refuse a claimed session's action when its advisor is not the one registered. */
function requireClaimOwner(stored: StoredSessionLimit): void {
  if (stored.claimedBy && accountAdvisorOwner() !== stored.claimedBy) {
    throw new ContinueError(503, 'FLOW_UNREACHABLE', FLOW_UNREACHABLE_MESSAGE);
  }
}

/** Refuse while the session is running a turn. */
function requireNotStreaming(sessionId: string): void {
  if (peekProjector(sessionId)?.getStatus().lifecycle === 'streaming') {
    throw new ContinueError(409, 'SESSION_BUSY', 'This session is working right now.');
  }
}

/** The `carryOver: false` the plan must keep, when it has one. */
function keptCarryOver(plan: LimitPlan): { carryOver?: false } {
  return (plan.mode === 'ask' || plan.mode === 'waiting') && plan.carryOver === false
    ? { carryOver: false }
    : {};
}

/**
 * The accounts a limited session could continue on, and its current plan.
 *
 * @param sessionId - The session.
 */
export async function continueOptions(sessionId: string): Promise<ContinueOptionsResponse> {
  const stored = await requireLimit(sessionId);
  if (!(await isClaudeCodeLimit(stored))) {
    return {
      plan: stored.limit.plan,
      ranking: { accounts: [], recommendedId: null },
      advised: false,
    };
  }
  const ranking = await rankForLimit(stored);
  // Accounts that may not work in this project are shown too, disabled, with
  // the reason ("Only for client-app"), so a person sees why one is missing
  // from the choices instead of wondering (spec `flow-multiproject` §8.4).
  const notAllowed = await notAllowedAccounts(limitRankingContext(stored));
  return {
    plan: stored.limit.plan,
    ranking: {
      accounts: [...ranking.accounts, ...notAllowed].map((a) => ({
        runtime: a.runtime,
        id: a.id,
        label: a.label,
        color: a.color,
        usage: a.usage,
        eligible: a.eligible,
        reason: a.reason,
        ...(a.badge ? { badge: a.badge } : {}),
        ...(a.notAllowed ? { notAllowed: true as const } : {}),
      })),
      recommendedId: ranking.recommendedId,
    },
    advised: ranking.advised,
  };
}

/** Whether no binding write ever named the session's runtime. */
async function isUnbound(stored: StoredSessionLimit): Promise<boolean> {
  try {
    return !(await runtimeRegistry.resolveSessionRuntime(stored.sessionId)).bound;
  } catch {
    return true;
  }
}

/**
 * Run an action that decides from the stored plan, and decide again when its
 * write lost a race with a newer decision (a compare-and-set miss).
 */
async function decidingAgainOnChange<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (err) {
      if (!(err instanceof PlanChangedError) || attempt >= 3) throw err;
    }
  }
}

/**
 * Switch the same session to another model and send it the continue turn, as
 * the person's own message (allowed whatever started the session).
 */
async function continueOnModel(
  stored: StoredSessionLimit,
  model: string,
  deps: ContinueLaunchDeps
): Promise<ContinueSessionResponse> {
  const runtime = await runtimeRegistry.resolveForSession(stored.sessionId);
  const refusal = await deps.checkModel(runtime, model);
  if (refusal) throw new ContinueError(400, 'UNSUPPORTED_MODEL', refusal);
  const internalId = runtime.getInternalSessionId(stored.sessionId) ?? stored.sessionId;
  await runtime.updateSession(internalId, { model });
  const projector = peekProjector(stored.sessionId);
  const cwd = stored.cwd ?? projector?.cwd;
  const result = await dispatchSessionMessage({
    // A person pressed "continue on <model>" in their own session: this is
    // their message, sent where they are watching.
    origin: { kind: 'interactive' },
    sessionId: stored.sessionId,
    request: { content: MODEL_CONTINUE_PROMPT, ...(cwd ? { cwd } : {}) },
    clientId: deps.clientId,
    meshCore: deps.meshCore,
    roomSessionPlace: deps.roomSessionPlace,
  });
  if (isSessionLaunchRefusal(result)) {
    throw new ContinueError(409, result.refused, result.message);
  }
  return { sessionId: result.canonicalId ?? stored.sessionId };
}

/**
 * Hand a claimed session's move to the advisor. Resolving in time means it
 * ACCEPTED the move: the plan shows the handoff until it reports the new
 * session with `markContinued`, or the 10-minute rule sends it back to `ask`.
 */
async function moveClaimed(
  stored: StoredSessionLimit,
  accountId: string,
  runtime: string
): Promise<ContinueSessionResponse> {
  requireClaimOwner(stored);
  const accepted = await invokeAdvisor('move', await sessionInfoOf(stored), {
    runtime,
    accountId,
  });
  if (!accepted) throw new ContinueError(503, 'FLOW_UNREACHABLE', FLOW_UNREACHABLE_MESSAGE);
  try {
    const written = await writePlan(stored, {
      mode: 'auto',
      target: accountId,
      fireAt: limitClock().toISOString(),
    });
    if (written) armClaimedHandoff(written);
  } catch (err) {
    // The advisor already reported the move (or a person decided) in the
    // meantime: that newer plan stands, and the move was still accepted.
    if (!(err instanceof PlanChangedError)) throw err;
  }
  return {};
}

/**
 * Continue a limited session: on another account (a new session carrying the
 * work over, or the advisor's move for a claimed session), or on another model
 * of the same account (the same session).
 *
 * @param sessionId - The session.
 * @param body - The account and/or model chosen.
 * @param deps - What starting a session needs from the app.
 * @throws {ContinueError} With the status the route answers.
 */
export async function continueSession(
  sessionId: string,
  body: ContinueSessionRequest,
  deps: ContinueLaunchDeps
): Promise<ContinueSessionResponse> {
  if (!body.account && !body.model) {
    throw new ContinueError(
      400,
      'VALIDATION_ERROR',
      'Choose an account or a model to continue on.'
    );
  }
  const first = await requireLimit(sessionId);
  // A session bound to another runtime cannot continue here yet (400). One
  // bound to nothing may still ask for an account, and gets the wait-only
  // refusal below, like every session that did not start here. (`runtime` in
  // the body names where the work goes, never where it comes from.)
  if (!(await isClaudeCodeLimit(first)) && (body.model || !(await isUnbound(first)))) {
    throw new ContinueError(
      400,
      'RUNTIME_NOT_OFFERED',
      'Only a Claude Code session can continue on another account or model for now. This one can wait for the reset.'
    );
  }
  // The folder's project, resolved before the re-read below so nothing after
  // it awaits (the account rule is judged against it further down).
  const project = await projectOfFolder(cwdOf(first));
  // Read again after those awaits: the automatic handoff (or another click)
  // may have moved the work meanwhile, and everything below, up to marking
  // this continue in flight, decides from this read without awaiting.
  const stored = readStoredLimit(first.sessionId);
  if (!stored || stored.limit.since !== first.limit.since) throw noLimit();
  const plan = stored.limit.plan;
  // Idempotent per episode: a moved session answers with where it went.
  if (body.account && plan.mode === 'continued') return { sessionId: plan.sessionId };
  // Moved, though the plan does not say so yet (its pointer is being retried).
  const started = unpointedCarryOver(stored);
  if (body.account && started) return { sessionId: started };
  const targetRuntime = body.runtime ?? LIMIT_RUNTIME;
  const crossRuntime = body.account !== undefined && targetRuntime !== LIMIT_RUNTIME;
  if (crossRuntime && !runtimeRegistry.has(targetRuntime)) {
    throw new ContinueError(
      400,
      'UNKNOWN_RUNTIME',
      `There is no runtime named "${targetRuntime}".`
    );
  }
  const key = episodeKey(stored);
  const pending = continueInFlight(key);
  if (body.account && pending) return pending;
  requireNotStreaming(stored.sessionId);

  if (!body.account) return continueOnModel(stored, body.model as string, deps);

  const accountId = body.account;
  // Another runtime's account is checked against the advisor's offer, below.
  if (!crossRuntime && !isRegisteredAccount(accountId)) {
    throw new ContinueError(400, 'UNKNOWN_ACCOUNT', `There is no account named "${accountId}".`);
  }
  if (!crossRuntime && accountId === stored.limit.accountId) {
    throw new ContinueError(
      400,
      'SAME_ACCOUNT',
      'This is the account that ran out. Choose another one.'
    );
  }
  if (!mayCarryOver(stored)) throw new ContinueError(409, 'WAIT_ONLY', WAIT_ONLY_MESSAGE);
  // A person's own pick is held to the account rules too (spec
  // `flow-multiproject` D7): an account that may not work in this folder's
  // project is refused with the plain sentence, whoever picks it.
  assertAccountEligible(configManager, targetRuntime, accountId, project);
  if (stored.claimedBy) {
    if (body.model) {
      throw new ContinueError(
        400,
        'MODEL_NOT_YOURS_TO_SET',
        'Flow moves this session, so it chooses the new session’s model. Choose only the account.'
      );
    }
    // A second click after the advisor accepted: already handing off there.
    if (!crossRuntime && plan.mode === 'auto' && plan.target === accountId) return {};
  }

  // Set before any await, so a second caller (a person's second click, or the
  // automatic handoff) joins this continue rather than starting another.
  return trackContinue(
    key,
    (async (): Promise<ContinueSessionResponse> => {
      if (crossRuntime) await requireOfferedElsewhere(stored, targetRuntime, accountId);
      if (stored.claimedBy) return moveClaimed(stored, accountId, targetRuntime);
      if (body.model) {
        const runtime = crossRuntime
          ? runtimeRegistry.get(targetRuntime)
          : await runtimeRegistry.resolveForSession(stored.sessionId);
        const refusal = await deps.checkModel(runtime, body.model);
        if (refusal) throw new ContinueError(400, 'UNSUPPORTED_MODEL', refusal);
      }
      const sessionId = await carryOverSession({
        source: stored,
        targetAccountId: accountId,
        by: 'person',
        ...(body.model ? { model: body.model } : {}),
        ...(crossRuntime ? { targetRuntime } : {}),
        launch: { meshCore: deps.meshCore, roomSessionPlace: deps.roomSessionPlace },
        activity,
      });
      return { sessionId };
    })()
  );
}

/**
 * Refuse another runtime's account unless the advisor's ranking offered that
 * very account of that runtime (spec D9 "Endpoints", S5 N3): a cross-runtime
 * move is the advisor's suggestion, never a free pick. A runtime without
 * accounts runs on this computer's own sign-in, so only its default account
 * can be continued on.
 */
async function requireOfferedElsewhere(
  stored: StoredSessionLimit,
  runtime: string,
  accountId: string
): Promise<void> {
  const ranking = await rankForLimit(stored);
  const offered =
    ranking.advised && ranking.accounts.some((a) => a.runtime === runtime && a.id === accountId);
  if (!offered) {
    throw new ContinueError(
      400,
      'RUNTIME_NOT_OFFERED',
      `Continuing on ${runtime} is not offered for this session.`
    );
  }
  if (runtimeRegistry.getAllCapabilities()[runtime]?.supportsAccounts) return;
  const ledger = (LEDGER_RUNTIMES as readonly string[]).includes(runtime)
    ? (runtime as LedgerRuntime)
    : null;
  const account = ledger
    ? getAccountUsageStore()
        ?.listAccounts(ledger)
        .find((a) => a.id === accountId)
    : undefined;
  if (!account?.isDefault) {
    throw new ContinueError(
      400,
      'ACCOUNT_NOT_ROUTABLE',
      `${runtime} runs on this computer's own sign-in, so it can only continue on that account.`
    );
  }
}

/**
 * Wait for the reset: the plan becomes `waiting` until the account's window
 * resets (`resume-service.ts` confirms the reset with a reading and resumes
 * the session when `autoResume` is on). For a claimed session, the advisor is
 * told and holds it.
 *
 * @param sessionId - The session.
 * @param opts.autoResume - Continue by itself once the reset is confirmed.
 *   Defaults to the advisor's own preference (on when it chose to wait), else off.
 * @throws {ContinueError} With the status the route answers.
 */
export async function waitForReset(
  sessionId: string,
  opts: { autoResume?: boolean }
): Promise<LimitPlan> {
  // Decide once and tell the advisor once; only the local write is retried.
  const stored = await requireLimit(sessionId);
  const current = stored.limit.plan;
  if (current.mode === 'continued' || unpointedCarryOver(stored)) throw alreadyMoved();
  if (continueInFlight(episodeKey(stored))) throw moving();
  const allowed = mayCarryOver(stored);
  if (opts.autoResume === true && !allowed) {
    throw new ContinueError(400, 'WAIT_ONLY', WAIT_ONLY_MESSAGE);
  }
  const asked = opts.autoResume ?? (current.mode === 'waiting' ? current.autoResume : false);
  // An unclaimed session's automatic resume is core's resume engine's to run,
  // behind its switch; a claimed one's is the advisor's.
  // Core resumes only a Claude Code limit, so no other runtime's wait promises it.
  const autoResume = stored.claimedBy
    ? asked
    : asked && CORE_AUTO_RESUME_AVAILABLE && (await isClaudeCodeLimit(stored));
  const resumeAt = stored.limit.resetsAt;
  if (stored.claimedBy) {
    requireClaimOwner(stored);
    const held = await invokeAdvisor('wait', await sessionInfoOf(stored), resumeAt, autoResume);
    if (!held) throw new ContinueError(503, 'FLOW_UNREACHABLE', FLOW_UNREACHABLE_MESSAGE);
  }
  clearClaimedHandoff(stored.sessionId);
  return writeAfterDeciding(stored, (latest) => {
    // Anything but a move still yields to the person's wait.
    if (latest.limit.plan.mode === 'continued') throw alreadyMoved();
    return { mode: 'waiting', resumeAt, autoResume, ...keptCarryOver(latest.limit.plan) };
  });
}

/**
 * Cancel a pending handoff: an `auto` plan goes back to `ask`. For a claimed
 * session, the advisor cancels its own handoff first.
 *
 * @param sessionId - The session.
 * @throws {ContinueError} With the status the route answers.
 */
export async function cancelAutoContinue(sessionId: string): Promise<LimitPlan> {
  const stored = await requireLimit(sessionId);
  if (stored.limit.plan.mode !== 'auto') {
    throw new ContinueError(409, 'NOT_HANDING_OFF', 'There is no handoff to cancel.');
  }
  if (unpointedCarryOver(stored)) throw alreadyMoved();
  // Core's own handoff already started the new session: too late to cancel.
  if (continueInFlight(episodeKey(stored))) throw moving();
  if (stored.claimedBy) {
    requireClaimOwner(stored);
    const cancelled = await invokeAdvisor('cancelAuto', await sessionInfoOf(stored));
    if (!cancelled) throw new ContinueError(503, 'FLOW_UNREACHABLE', FLOW_UNREACHABLE_MESSAGE);
  }
  clearClaimedHandoff(stored.sessionId);
  // A plan that is no longer `auto` (the 10-minute fallback already asked
  // again, or the move was reported) means the cancel has nothing left to do:
  // it succeeded, and the current plan is the answer.
  return writeAfterDeciding(stored, (latest) =>
    latest.limit.plan.mode === 'auto' ? { mode: 'ask' } : null
  );
}

function moving(): ContinueError {
  return new ContinueError(409, 'MOVING', 'This work is already moving to another account.');
}

function alreadyMoved(): ContinueError {
  return new ContinueError(409, 'ALREADY_MOVED', 'This work already continued in another session.');
}

/**
 * Write the plan `next` decides from the latest read, re-reading after a
 * compare-and-set miss (up to 3 tries). Nothing outside this process is
 * called again. `next` answering `null` keeps the current plan. A move that
 * started while the state was being derived refuses the write (409 `MOVING`),
 * checked in the same synchronous step as the write, so a wait or cancel never
 * lands under a carry-over that then points the plan elsewhere.
 */
async function writeAfterDeciding(
  read: StoredSessionLimit,
  next: (latest: StoredSessionLimit) => LimitPlan | null
): Promise<LimitPlan> {
  let latest: StoredSessionLimit | undefined = read;
  for (let attempt = 1; ; attempt++) {
    if (!latest || latest.limit.since !== read.limit.since) throw noLimit();
    const plan = next(latest);
    if (plan === null) return latest.limit.plan;
    try {
      const written = await writePlan(latest, plan, {
        beforeCommit: () => {
          if (continueInFlight(episodeKey(read))) throw moving();
        },
      });
      return written?.limit.plan ?? plan;
    } catch (err) {
      if (!(err instanceof PlanChangedError) || attempt >= 3) throw err;
      latest = readStoredLimit(read.sessionId);
    }
  }
}

/**
 * Record that the extension `ownerId` moved a session it claimed (§X rule b):
 * accepted while the session still has a limit whose plan is not already
 * `continued` (over `ask`, `auto` or `waiting`); a logged no-op once the row is
 * gone (the session's next turn started).
 *
 * @param ownerId - The extension reporting the move.
 * @param sourceSessionId - The session whose work moved.
 * @param to - Where it went.
 * @throws {Error} When the plan is already `continued`, or the session is not
 *   one this extension claimed.
 */
export function recordMarkContinued(
  ownerId: string,
  sourceSessionId: string,
  to: ContinuationTarget
): Promise<void> {
  return decidingAgainOnChange(() => markContinuedOnce(ownerId, sourceSessionId, to));
}

async function markContinuedOnce(
  ownerId: string,
  sourceSessionId: string,
  to: ContinuationTarget
): Promise<void> {
  const stored = readStoredLimit(sourceSessionId);
  if (!stored) {
    logger.info('[continue] markContinued for a session with no limit; nothing to record', {
      ownerId,
      sourceSessionId,
    });
    return;
  }
  if (stored.limit.plan.mode === 'continued') {
    throw new Error(
      `Session ${sourceSessionId} already continued in session ${stored.limit.plan.sessionId}.`
    );
  }
  if (stored.claimedBy !== ownerId) {
    throw new Error(
      `Session ${sourceSessionId} was not claimed by "${ownerId}", so it cannot mark it as continued.`
    );
  }
  clearClaimedHandoff(stored.sessionId);
  const written = await writePlan(stored, {
    mode: 'continued',
    sessionId: to.sessionId,
    accountId: to.accountId,
  });
  if (!written) {
    logger.info('[continue] markContinued raced the session’s next turn; nothing to record', {
      ownerId,
      sourceSessionId,
    });
    return;
  }
  recordCarryOverActivity(activity, {
    by: 'advisor',
    advisorId: ownerId,
    sourceSessionId: stored.sessionId,
    fromAccountId: stored.limit.accountId,
    toAccountId: to.accountId,
    newSessionId: to.sessionId,
  });
}

/**
 * Install the continue service: the Activity writer it records moves with,
 * the recorder behind `accounts.markContinued`, and core's automatic handoff
 * for unclaimed `auto` plans.
 *
 * @param opts.activity - The Activity feed writer, when the server has one.
 * @param opts.launchDeps - The app's launch deps, read when a handoff fires.
 * @returns A function that uninstalls it and clears every timer.
 */
export function installContinueService(opts: {
  activity?: ActivityService;
  launchDeps?: () => CarryOverLaunchDeps;
}): () => void {
  activity = opts.activity;
  setContinuationRecorder(recordMarkContinued);
  const uninstallAuto = installAutoHandoff({
    activity: () => activity,
    launchDeps: opts.launchDeps ?? (() => ({ meshCore: undefined, roomSessionPlace: undefined })),
  });
  return () => {
    uninstallAuto();
    setContinuationRecorder(undefined);
    activity = undefined;
    clearContinuesInFlight();
    clearUnpointedCarryOvers();
  };
}
