/** Producer-owned publication/retirement, independent of its stream consumer. */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '../agent-types.js';
import type { RevokeConnectorTurnReason } from '../../../core/connections-lease/index.js';
import type { SessionBundle } from '../sessions/dispatch/state.js';
import type { PumpLaunchPlan } from '../sessions/pump-launch.js';
import type { LaunchFingerprint } from '../sessions/launch-fingerprint.js';
import type { PumpState } from '../sessions/session-pump-contract.js';

/** Publish only settings whose mode agrees with this actual running process. */
export function publishPumpToolTurn(
  session: AgentSession,
  live: Query | undefined,
  fingerprint: LaunchFingerprint | undefined,
  plan: PumpLaunchPlan | undefined
): ((reason?: RevokeConnectorTurnReason) => void) | undefined {
  const settings = plan?.toolTurnSettings;
  if (live && settings && fingerprint?.live.permissionMode === settings.sdkPermissionMode) {
    return plan?.toolTurnOwner?.prepareToolTurn(session, live, settings);
  }
  return undefined;
}

/** Arm/disarm the in-flight query and retire at the actual producer boundary. */
export function observePumpToolTurnState(
  session: AgentSession,
  bundle: SessionBundle,
  change: { from: PumpState; to: PumpState }
): void {
  if (change.to === 'running') {
    session.activeQuery = bundle.live;
    bundle.retireToolTurn = publishPumpToolTurn(
      session,
      bundle.live,
      bundle.fingerprint,
      bundle.plan
    );
    return;
  }
  if (change.from === 'running') {
    const retire = bundle.retireToolTurn;
    bundle.retireToolTurn = undefined;
    retire?.(change.to === 'crashed' ? 'runtime_failed' : 'turn_terminal');
  }
  // Preserve post-stream controls and the existing idle interrupt fence.
  if (session.activeQuery !== undefined && session.activeQuery === bundle.live) {
    session.lastQuery = session.activeQuery;
    session.activeQuery = undefined;
  }
}
