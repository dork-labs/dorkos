/**
 * Carry a limited session's work over to a new session on another account
 * (spec `claude-account-fleet` D9, "Carry-over").
 *
 * The new session runs in the source session's folder (and for its agent), on
 * the chosen account, on the source's runtime. Its settings row is written
 * first with the source's model, effort and permission mode, so it has no more
 * power than the session it continues; it starts under the `account-handoff`
 * origin, which seeds nothing of its own. On ANOTHER runtime (an account the
 * advisor offered there), the target runtime picks its own model and effort,
 * and the mode is the source's trust stop capped at `act`
 * (`carry-over-power.ts`).
 *
 * An automatic carry-over (the advisor's `auto` plan, fired by core) has
 * nobody watching: it runs unattended and counts against the launch cap. Its first message carries a background seed: the
 * advisor's (`carryOver`), else the default summary, which no model writes.
 * The source's plan then points at the new session, and one Activity entry
 * records who moved it, from which account to which.
 *
 * @module services/session/fleet/carry-over
 */
import { randomUUID } from 'node:crypto';
import type { MeshCore } from '@dorkos/mesh';
import { sessionPath } from '@dorkos/shared/session-link';
import { LEDGER_RUNTIMES, type LedgerRuntime } from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { callAdvisor, validateCarryOverSeed } from '../../core/usage/account-advisor.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { configManager } from '../../core/config-manager.js';
import { assertAccountEligible, projectOfFolder } from '../../core/usage/account-eligibility.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { dispatchSessionMessage, isSessionLaunchRefusal } from '../launch/launch-session.js';
import { getStartWorkService, type StartReservation } from '../../extensions/start-work.js';
import {
  claudeTranscriptPath,
  gatherCarryOverSummary,
  runGitForSummary,
} from './carry-over-summary.js';
import {
  PlanChangedError,
  cwdOf,
  limitedInfoOf,
  readStoredLimit,
  writePlan,
} from './limit-plans.js';
import type { StoredSessionLimit } from './session-limit-store.js';
import { crossRuntimePermissionMode } from './carry-over-power.js';
import { episodeKey } from './continue-in-flight.js';

/** The first message of a carried-over session when the advisor gives none (spec D9, quoted). */
export const CARRY_OVER_PROMPT =
  'Continue the work from the previous session. The background says where it stopped.';

/** The client id a carry-over's first message is sent as. */
const CARRY_OVER_CLIENT_ID = 'account-handoff';

/** The runtime whose sessions carry usage limits, and so are carried over. */
const SOURCE_RUNTIME = 'claude-code';

/** Why a carry-over could not start, with the status a route answers. */
export class CarryOverError extends Error {
  /**
   * Build a refusal.
   *
   * @param status - The HTTP status a route answers.
   * @param code - A stable machine-readable code.
   * @param message - The sentence shown to a person.
   */
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CarryOverError';
  }
}

/** Who moved the work: a person, or the account advisor. */
export type CarryOverActor = 'person' | 'advisor';

/** What {@link carryOverSession} needs. */
export interface CarryOverRequest {
  /** The limited session's stored limit. */
  source: StoredSessionLimit;
  /** The account to continue on. */
  targetAccountId: string;
  /** Who asked. */
  by: CarryOverActor;
  /** The new session's model, when chosen; else the source's (same runtime) or the target's default. */
  model?: string;
  /**
   * The runtime the new session runs on; the source's own when absent. The
   * caller has already checked the advisor offered the account there.
   */
  targetRuntime?: string;
  /** What starting a session needs from the app. */
  launch: { meshCore: MeshCore | undefined; roomSessionPlace: RoomSessionPlacePort | undefined };
  /** The Activity feed writer, when the server has one. */
  activity: ActivityService | undefined;
}

/** What an account is called, for the summary and the Activity entry. */
function accountLabelOf(
  accountId: string | null,
  accountPath: string | null,
  runtime: string = SOURCE_RUNTIME
): string {
  const store = getAccountUsageStore();
  const ledger = (LEDGER_RUNTIMES as readonly string[]).includes(runtime)
    ? (runtime as LedgerRuntime)
    : null;
  try {
    const usage = !ledger
      ? undefined
      : accountId
        ? store?.peek(ledger, [accountId])[0]
        : accountPath
          ? store?.usageAtPath(ledger, accountPath)
          : undefined;
    if (usage?.label) return usage.label;
  } catch {
    // Fall through to the plain description.
  }
  return accountId ?? 'an account that is not registered';
}

/** The seed and first message: the advisor's when valid, else the default summary. */
async function seedFor(
  source: StoredSessionLimit,
  cwd: string,
  targetAccountId: string
): Promise<{ seedContext: string; prompt: string }> {
  const answer = await callAdvisor('carryOver', await limitedInfoOf(source), targetAccountId);
  if (answer !== undefined) {
    const seed = validateCarryOverSeed(answer);
    if (seed) return { seedContext: seed.seedContext, prompt: seed.prompt ?? CARRY_OVER_PROMPT };
    logger.warn('[carry-over] the advisor’s seed was refused; using the default summary', {
      sessionId: source.sessionId,
    });
  }
  const seedContext = await gatherCarryOverSummary(
    {
      sessionId: source.sessionId,
      accountLabel: accountLabelOf(source.limit.accountId, source.accountPath),
      window: source.limit.window,
      resetsAt: source.limit.resetsAt,
      cwd,
      transcriptPath: claudeTranscriptPath(source.accountPath, cwd, source.sessionId),
    },
    {
      runGit: runGitForSummary,
      readHistory: async () => {
        const runtime = await runtimeRegistry.resolveForSession(source.sessionId);
        const internalId = runtime.getInternalSessionId(source.sessionId) ?? source.sessionId;
        return runtime.getMessageHistory(cwd, internalId);
      },
    }
  );
  return { seedContext, prompt: CARRY_OVER_PROMPT };
}

/** The source's agent path, when Mesh still knows it as a registered agent. */
async function verifiedAgentPath(
  sessionId: string,
  meshCore: MeshCore | undefined
): Promise<string | undefined> {
  const agentPath = await runtimeRegistry.getSessionAgentPath(sessionId).catch(() => null);
  if (!agentPath || !meshCore) return undefined;
  return meshCore.listWithPaths().some((agent) => agent.projectPath === agentPath)
    ? agentPath
    : undefined;
}

/**
 * Record a carry-over in the Activity feed: who moved it, from which account
 * to which, and both session ids. Never throws.
 *
 * @param activity - The Activity feed writer, when the server has one.
 * @param entry - The move.
 */
export function recordCarryOverActivity(
  activity: ActivityService | undefined,
  entry: {
    by: CarryOverActor;
    /** The advisor's extension id, when the advisor moved it. */
    advisorId?: string;
    sourceSessionId: string;
    fromAccountId: string | null;
    toAccountId: string;
    /** The runtime the new session runs on, when not the source's. */
    toRuntime?: string;
    newSessionId: string;
  }
): void {
  if (!activity) return;
  const from = accountLabelOf(entry.fromAccountId, null);
  const to = accountLabelOf(entry.toAccountId, null, entry.toRuntime);
  void activity
    .emit({
      actorType: entry.by === 'person' ? 'user' : 'system',
      actorLabel: entry.by === 'person' ? 'You' : (entry.advisorId ?? 'Account advisor'),
      category: 'agent',
      eventType: 'session.continued',
      resourceType: 'session',
      resourceId: entry.newSessionId,
      summary: `Moved a session from ${from} to ${to} because ${from} ran out of usage`,
      linkPath: sessionPath({ session: entry.newSessionId }),
      metadata: {
        by: entry.by,
        advisorId: entry.advisorId ?? null,
        sourceSessionId: entry.sourceSessionId,
        newSessionId: entry.newSessionId,
        fromAccountId: entry.fromAccountId,
        toAccountId: entry.toAccountId,
        toRuntime: entry.toRuntime ?? SOURCE_RUNTIME,
      },
    })
    .catch(() => undefined);
}

/** How long to wait before each retry of a pointer write that failed. */
export const POINTER_RETRY_DELAYS_MS = [1_000, 5_000] as const;

/**
 * New sessions already started for a limit episode whose source plan does not
 * point at them yet (the pointer write failed), keyed by episode. In memory
 * only, like the timers: every continue for that episode answers with this
 * session instead of starting another. Dropped once the pointer lands.
 */
const unpointed = new Map<string, string>();

/**
 * The session a carry-over already started for this episode while its source
 * plan does not point at it yet, if any.
 *
 * @param stored - The source's stored limit.
 */
export function unpointedCarryOver(stored: StoredSessionLimit): string | undefined {
  return unpointed.get(episodeKey(stored));
}

/** Forget every unpointed carry-over (shutdown and tests). */
export function clearUnpointedCarryOvers(): void {
  unpointed.clear();
}

/**
 * Try the pointer again, 1 s and then 5 s later: it is idempotent through the
 * compare-and-set, and lands over whatever plan is there unless the episode is
 * gone or already continued.
 */
function retryPointer(
  source: StoredSessionLimit,
  newSessionId: string,
  accountId: string,
  attempt = 0
): void {
  const delay = POINTER_RETRY_DELAYS_MS[attempt];
  const key = episodeKey(source);
  if (delay === undefined) {
    logger.error('[carry-over] gave up pointing the old session at the new one', {
      sourceSessionId: source.sessionId,
      newSessionId,
    });
    return;
  }
  const timer = setTimeout(() => {
    if (unpointed.get(key) !== newSessionId) return;
    pointAtNewSession(source, newSessionId, accountId).then(
      () => {
        if (unpointed.get(key) === newSessionId) unpointed.delete(key);
      },
      () => retryPointer(source, newSessionId, accountId, attempt + 1)
    );
  }, delay);
  timer.unref?.();
}

/**
 * Point the source's plan at the new session. The session has started, so
 * the pointer must land: a compare-and-set miss re-reads and writes again over
 * whatever plan is there now, unless the episode is gone or already continued.
 */
async function pointAtNewSession(
  source: StoredSessionLimit,
  newSessionId: string,
  accountId: string
): Promise<void> {
  let current: StoredSessionLimit | undefined = source;
  for (let attempt = 1; current && attempt <= 3; attempt++) {
    if (current.limit.since !== source.limit.since || current.limit.plan.mode === 'continued') {
      return;
    }
    try {
      await writePlan(current, { mode: 'continued', sessionId: newSessionId, accountId });
      return;
    } catch (err) {
      if (!(err instanceof PlanChangedError)) throw err;
      current = readStoredLimit(source.sessionId);
    }
  }
  if (current) {
    logger.warn('[carry-over] could not point the old session at the new one after 3 tries', {
      sourceSessionId: source.sessionId,
      newSessionId,
    });
  }
}

/**
 * Start the new session and point the source's plan at it.
 *
 * @param request - The source, the target account, who asked, and the app's launch deps.
 * @returns The new session's canonical id.
 * @throws {CarryOverError} When the new session could not start.
 */
export async function carryOverSession(request: CarryOverRequest): Promise<string> {
  const { source, targetAccountId, by, launch } = request;
  const cwd = cwdOf(source);
  if (!cwd) {
    throw new CarryOverError(
      409,
      'CWD_UNKNOWN',
      'DorkOS does not know which folder this session worked in, so it cannot continue it elsewhere.'
    );
  }
  // Defence in depth (spec `flow-multiproject` §8.4): whoever chose the
  // target, a person, the advisor or the automatic handoff, it must be an
  // account that may work in this folder's project. Callers check first; this
  // is the last word before anything is written.
  const targetRuntimeName = request.targetRuntime ?? SOURCE_RUNTIME;
  assertAccountEligible(
    configManager,
    targetRuntimeName,
    targetAccountId,
    await projectOfFolder(cwd)
  );
  const settings = (await runtimeRegistry.getSessionSettings(source.sessionId)) ?? {};
  const sourceRuntime = await runtimeRegistry
    .getSessionRuntimeType(source.sessionId)
    .catch(() => SOURCE_RUNTIME);
  const targetRuntime = request.targetRuntime ?? sourceRuntime;
  const crossRuntime = targetRuntime !== sourceRuntime;
  const capabilities = runtimeRegistry.getAllCapabilities();
  const newId = randomUUID();
  // A chat an extension started (or one started from its chats) stays one
  // across the move (spec `flow-multiproject` §7.7): the new chat records the
  // limited one as its starter and keeps its reason and origin extension, so
  // it keeps its first line, its folded prompt and its chain. A move replaces
  // one chat with one and adds no work, so the extension's limits never refuse
  // it and the hour does not count it; the successor counts as running.
  const claimed = getStartWorkService()?.reserveFromChat({
    sessionId: newId,
    parentSessionId: source.sessionId,
    carry: true,
  });
  const reservation: StartReservation | null = claimed?.ok ? claimed.reservation : null;
  try {
    return await launchCarriedSession(request, {
      cwd,
      settings,
      sourceRuntime,
      targetRuntime,
      crossRuntime,
      capabilities,
      newId,
      reservation,
    });
  } catch (err) {
    reservation?.cancel();
    throw err;
  }
}

/** Everything {@link carryOverSession} resolved before the send. */
interface CarriedLaunch {
  cwd: string;
  settings: Awaited<ReturnType<typeof runtimeRegistry.getSessionSettings>> & object;
  sourceRuntime: string;
  targetRuntime: string;
  crossRuntime: boolean;
  capabilities: ReturnType<typeof runtimeRegistry.getAllCapabilities>;
  newId: string;
  reservation: StartReservation | null;
}

/** The send, and everything after it, for {@link carryOverSession}. */
async function launchCarriedSession(
  request: CarryOverRequest,
  launched: CarriedLaunch
): Promise<string> {
  const { source, targetAccountId, by, launch } = request;
  const {
    cwd,
    settings,
    sourceRuntime,
    targetRuntime,
    crossRuntime,
    capabilities,
    newId,
    reservation,
  } = launched;
  // Before the send: the row is the new session's power, and the
  // `account-handoff` origin claims it without adding the operator's stop.
  if (crossRuntime) {
    // The target runtime's own model and effort defaults (the bind seeds them);
    // the source's stop, capped at `act`, in the target's vocabulary.
    const permissionMode = crossRuntimePermissionMode(
      settings.permissionMode,
      capabilities[sourceRuntime]?.permissionModes,
      capabilities[targetRuntime]?.permissionModes
    );
    await runtimeRegistry.saveSessionSettings(newId, {
      ...(request.model ? { model: request.model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    });
  } else {
    await runtimeRegistry.saveSessionSettings(newId, {
      ...(request.model
        ? { model: request.model }
        : settings.model
          ? { model: settings.model }
          : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
    });
  }
  const { seedContext, prompt } = await seedFor(source, cwd, targetAccountId);
  const agentPath = await verifiedAgentPath(source.sessionId, launch.meshCore);
  // Nobody is watching a move the advisor's plan made: it runs like a timer-
  // fired schedule, and counts against the cap on sessions nobody typed into.
  const automatic = by === 'advisor';
  const result = await dispatchSessionMessage({
    origin: { kind: 'account-handoff' },
    sessionId: newId,
    request: {
      content: prompt,
      cwd,
      runtime: targetRuntime,
      // A runtime without accounts runs on this computer's own sign-in.
      ...(!crossRuntime || capabilities[targetRuntime]?.supportsAccounts
        ? { account: targetAccountId }
        : {}),
      seedContext,
      ...(agentPath ? { agentPath } : {}),
    },
    clientId: CARRY_OVER_CLIENT_ID,
    meshCore: launch.meshCore,
    roomSessionPlace: launch.roomSessionPlace,
    ...(automatic ? { countsTowardLaunchCap: true, unattended: true } : {}),
    ...(reservation ? { onSettled: () => reservation.settle() } : {}),
  });
  if (isSessionLaunchRefusal(result)) {
    if (result.accountError) throw result.accountError;
    throw new CarryOverError(409, result.refused, result.message);
  }
  if (!result.accepted || !result.canonicalId) {
    throw new CarryOverError(
      409,
      'NOT_STARTED',
      'The new session could not start, so the work did not move.'
    );
  }
  const newSessionId = result.canonicalId;
  if (newSessionId !== newId) reservation?.rekey(newSessionId);
  // The new session is running: from here on nothing may reject, or a caller
  // that retries (the automatic handoff's re-fire, a person's second click)
  // would start a second one. A failed pointer is logged; the session stands.
  // Until the pointer lands, the episode remembers the new session in memory,
  // so a second continue answers with it rather than starting another.
  try {
    await pointAtNewSession(source, newSessionId, targetAccountId);
  } catch (err) {
    logger.error('[carry-over] started the new session but could not point the old one at it', {
      sourceSessionId: source.sessionId,
      newSessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    unpointed.set(episodeKey(source), newSessionId);
    retryPointer(source, newSessionId, targetAccountId);
  }
  recordCarryOverActivity(request.activity, {
    by,
    sourceSessionId: source.sessionId,
    fromAccountId: source.limit.accountId,
    toAccountId: targetAccountId,
    ...(crossRuntime ? { toRuntime: targetRuntime } : {}),
    newSessionId,
  });
  logger.info('[carry-over] continued a limited session on another account', {
    sourceSessionId: source.sessionId,
    newSessionId,
    by,
    to: targetAccountId,
    runtime: targetRuntime,
  });
  return newSessionId;
}
