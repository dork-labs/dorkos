/** Claude-specific live authority readers, keeping recovery out of generic runtime contracts. */
import { resolve } from 'node:path';
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { RequiredLaunchOwner } from '../../messaging/launch/required-launch.js';
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
