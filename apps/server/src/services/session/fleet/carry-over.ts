/**
 * Carry a limited session's work over to a new session on another account
 * (spec `claude-account-fleet` D9, "Carry-over").
 *
 * The new session runs in the source session's folder (and for its agent), on
 * the chosen account, on Claude Code. Its settings row is written first with
 * the source's model, effort and permission mode, so it has no more power than
 * the session it continues; it starts under the `account-handoff` origin, which
 * seeds nothing of its own. Its first message carries a background seed: the
 * advisor's (`carryOver`), else the default summary, which no model writes.
 * The source's plan then points at the new session, and one Activity entry
 * records who moved it, from which account to which.
 *
 * @module services/session/fleet/carry-over
 */
import { randomUUID } from 'node:crypto';
import type { MeshCore } from '@dorkos/mesh';
import { sessionPath } from '@dorkos/shared/session-link';
import { logger } from '../../../lib/logger.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { callAdvisor, validateCarryOverSeed } from '../../core/usage/account-advisor.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import type { RoomSessionPlacePort } from '../../workspace/room-session-place.js';
import { dispatchSessionMessage, isSessionLaunchRefusal } from '../launch/launch-session.js';
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

/** The first message of a carried-over session when the advisor gives none (spec D9, quoted). */
export const CARRY_OVER_PROMPT =
  'Continue the work from the previous session. The background says where it stopped.';

/** The client id a carry-over's first message is sent as. */
const CARRY_OVER_CLIENT_ID = 'account-handoff';

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
  /** The new session's model, when chosen; else the source's. */
  model?: string;
  /** What starting a session needs from the app. */
  launch: { meshCore: MeshCore | undefined; roomSessionPlace: RoomSessionPlacePort | undefined };
  /** The Activity feed writer, when the server has one. */
  activity: ActivityService | undefined;
}

/** What an account is called, for the summary and the Activity entry. */
function accountLabelOf(accountId: string | null, accountPath: string | null): string {
  const store = getAccountUsageStore();
  try {
    const usage = accountId
      ? store?.peek('claude-code', [accountId])[0]
      : accountPath
        ? store?.usageAtPath('claude-code', accountPath)
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
    newSessionId: string;
  }
): void {
  if (!activity) return;
  const from = accountLabelOf(entry.fromAccountId, null);
  const to = accountLabelOf(entry.toAccountId, null);
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
      },
    })
    .catch(() => undefined);
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
  const settings = (await runtimeRegistry.getSessionSettings(source.sessionId)) ?? {};
  const newId = randomUUID();
  // Before the send: the copied row is the new session's power, and the
  // `account-handoff` origin claims it without adding the operator's stop.
  await runtimeRegistry.saveSessionSettings(newId, {
    ...(request.model ? { model: request.model } : settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
  });
  const { seedContext, prompt } = await seedFor(source, cwd, targetAccountId);
  const agentPath = await verifiedAgentPath(source.sessionId, launch.meshCore);
  const result = await dispatchSessionMessage({
    origin: { kind: 'account-handoff' },
    sessionId: newId,
    request: {
      content: prompt,
      cwd,
      runtime: 'claude-code',
      account: targetAccountId,
      seedContext,
      ...(agentPath ? { agentPath } : {}),
    },
    clientId: CARRY_OVER_CLIENT_ID,
    meshCore: launch.meshCore,
    roomSessionPlace: launch.roomSessionPlace,
  });
  if (isSessionLaunchRefusal(result)) {
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
  await pointAtNewSession(source, newSessionId, targetAccountId);
  recordCarryOverActivity(request.activity, {
    by,
    sourceSessionId: source.sessionId,
    fromAccountId: source.limit.accountId,
    toAccountId: targetAccountId,
    newSessionId,
  });
  logger.info('[carry-over] continued a limited session on another account', {
    sourceSessionId: source.sessionId,
    newSessionId,
    by,
    to: targetAccountId,
  });
  return newSessionId;
}
