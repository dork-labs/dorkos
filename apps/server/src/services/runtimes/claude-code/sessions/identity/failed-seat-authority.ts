/** Claude-specific live authority readers, keeping recovery out of generic runtime contracts. */
import { resolve } from 'node:path';
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { RequiredLaunchOwner } from '../../messaging/launch/required-launch.js';
import type { FailedSeatRecord } from '../../../../rooms/reseat/failed-seat-ledger.js';
import type { AgentSession } from '../../agent-types.js';
import { accountIdForRoot } from '../../claude-config-dir.js';
import { isCreditsClaudeRoot } from '../../credits-root.js';
import {
  predictLaunchBillsPerToken,
  readPerTokenSignals,
} from '../../messaging/per-token-billing.js';

/** Existing usage-display prediction; never use it as failed-turn recovery authority. */
export function sessionBillingPrediction(session: AgentSession | undefined): boolean {
  if (session?.launchedPerToken !== undefined) return session.launchedPerToken;
  if (session?.lastSubscriptionUsage?.kind === 'subscription') return false;
  const root = session?.accountRoot;
  return predictLaunchBillsPerToken(
    readPerTokenSignals(root !== undefined && isCreditsClaudeRoot(root))
  );
}
/** Existing actual/settled root display semantics. */
export function observedSessionRoot(session: AgentSession | undefined): string | undefined {
  const root = session?.launchedAccountRoot ?? session?.accountRoot;
  return root === undefined ? undefined : resolve(root);
}
/** SDK-init facts only, for native settlement; no environment or preference prediction. */
export function observedSessionBilling(session: AgentSession | undefined) {
  const observed = session?.sdkReportedBilling;
  if (!observed || !session.sdkSessionId || session.launchedAccountRoot !== observed.root)
    return null;
  return {
    runtime: 'claude-code' as const,
    root: observed.root,
    sessionId: session.sdkSessionId,
    cwd: session.cwd,
    accountId: accountIdForRoot(observed.root) ?? null,
    inference: isCreditsClaudeRoot(observed.root) ? ('credits' as const) : ('own-account' as const),
    billing: observed.perToken ? ('per-token' as const) : ('subscription' as const),
  };
}
/** Strict previous terminal producer facts plus affirmative existing crash/current guards. */
export function failedSessionAuthority(session: AgentSession | undefined, blocked: boolean) {
  const failure = session?.priorServerFailure;
  if (!failure || !session.hasStarted || session.pendingInteractions.size > 0 || blocked)
    return null;
  return {
    ...failure,
    runtime: 'claude-code' as const,
    accountId: accountIdForRoot(failure.root) ?? null,
  };
}

/**
 * The same authority after a restart (DOR-4626), from the server's durable record, read only when
 * this process holds nothing for the session: no failure in memory, no process, nothing busy and
 * nothing waiting on a person. The record refuses itself when it is this process's own, claimed,
 * corrupt or too old; callers still match it against the latest durable turn.
 *
 * @param owner - The runtime's injected launch owner; absent or unavailable restores nothing.
 * @param sessionId - The failed chat.
 * @param session - This process's record of it, if any.
 * @param blocked - A live process, lock, background work or helper on the session.
 */
function restoredSessionAuthority(
  owner: RequiredLaunchOwner | undefined,
  sessionId: string,
  session: AgentSession | undefined,
  blocked: boolean
) {
  if (blocked || session?.priorServerFailure || (session?.pendingInteractions.size ?? 0) > 0)
    return null;
  let record: FailedSeatRecord | null;
  try {
    record = owner?.().failures?.restore(sessionId) ?? null;
  } catch {
    return null;
  }
  if (!record) return null;
  const { carry: _carry, ...failure } = record;
  return {
    ...failure,
    runtime: 'claude-code' as const,
    accountId: accountIdForRoot(failure.root) ?? null,
    restored: true as const,
  };
}

/** The runtime's own guards a recovery reads, so the facade stays one call. */
interface FailedSeatGuards {
  isLocked(sessionId: string): boolean;
  holdsBackgroundWork(sessionId: string): boolean;
  isHelperWorking(sessionId: string): boolean;
}

/**
 * A failed room chat's recovery authority: this process's live record while it holds one, else
 * the durable record an earlier process kept, only while no process runs for the session at all.
 *
 * @param guards - The runtime's lock, background-work and helper checks.
 * @param sessionId - The failed chat.
 * @param session - This process's record of it, if any.
 * @param owner - The runtime's injected launch owner.
 * @param crash - The live crash policy, or `'cold'` when no process is held for the session.
 */
export function failedSeatAuthorityOf(
  guards: FailedSeatGuards,
  sessionId: string,
  session: AgentSession | undefined,
  owner: RequiredLaunchOwner | undefined,
  crash: 'allows' | 'refuses' | 'cold'
) {
  const busy =
    guards.isLocked(sessionId) ||
    guards.holdsBackgroundWork(sessionId) ||
    guards.isHelperWorking(sessionId);
  return (
    failedSessionAuthority(session, busy || crash !== 'allows') ??
    restoredSessionAuthority(owner, sessionId, session, busy || crash !== 'cold')
  );
}

/** Bind the exact injected owner lazily; absence remains unknown, never a global fallback. */
export function requiredLaunchOwnerFromSettings(
  port: SessionSettingsPort
): RequiredLaunchOwner | undefined {
  // Structural by design: independently loaded module generations still share
  // the same concrete owner. Invoke its bound getter per dispatch so setDb()
  // replacements cannot leave a stale authority store behind.
  const owner = port as SessionSettingsPort & {
    requiredLaunches?: RequiredLaunchOwner;
  };
  return typeof owner.requiredLaunches === 'function'
    ? owner.requiredLaunches.bind(owner)
    : undefined;
}
