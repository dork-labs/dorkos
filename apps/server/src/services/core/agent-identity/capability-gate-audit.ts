/**
 * Turn refused and pending capability attempts into Activity events
 * (spec `agent-trust` §3.2).
 *
 * The attribution observer next door records what an agent DID
 * (`capability-attribution.ts`). This one records what an agent TRIED and was not
 * allowed to do, which is the more interesting half of an audit trail: an agent
 * repeatedly reaching for something destructive, or bumping into its own tier
 * ceiling, is exactly the pattern an operator wants to see in the feed.
 *
 * Allowed calls are deliberately NOT recorded here — the attribution observer
 * already covers them — so one invocation produces one Activity record, never two.
 *
 * @module services/core/agent-identity/capability-gate-audit
 */
import path from 'node:path';
import type { ActivityService } from '../../activity/activity-service.js';
import type { TierEnforcementAttempt } from '../capabilities/index.js';

/**
 * Build the audit hook `initCapabilityTierGate` calls for every attempt the tier
 * gate did not allow.
 *
 * `emit` is fire-and-forget and never throws, and the gate swallows anything this
 * hook throws anyway, so a broken feed can never turn into a broken gate.
 *
 * @param activityService - The Activity feed writer.
 * @returns The gate's `onAttempt` hook.
 */
export function createCapabilityGateAuditObserver(
  activityService: ActivityService
): (attempt: TierEnforcementAttempt) => void {
  return ({ capability, identity, decision }) => {
    const label = identity.displayName || path.basename(identity.agentPath);
    const pending = decision.outcome === 'approval_required' ? decision.payload : undefined;
    const waiting = pending !== undefined;

    void activityService.emit({
      actorType: 'agent',
      actorId: identity.agentPath,
      actorLabel: label,
      category: 'agent',
      eventType: waiting ? 'capability.approval_required' : 'capability.denied',
      resourceType: 'capability',
      resourceId: capability.id,
      resourceLabel: capability.title,
      summary: waiting
        ? `${label} needs approval to run ${capability.title}`
        : `${label} was not allowed to run ${capability.title}`,
      metadata: {
        capabilityId: capability.id,
        tier: capability.tier,
        tierCeiling: identity.tierCeiling,
        reason: decision.payload.reason,
        ...(pending ? { approvalId: pending.approvalId } : {}),
      },
    });
  };
}
