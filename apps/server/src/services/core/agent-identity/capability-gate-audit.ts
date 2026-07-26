/**
 * Turn refused and pending capability attempts into Activity events
 * (spec `agent-trust` §3.2).
 *
 * The attribution observer next door records what an agent DID
 * (`capability-attribution.ts`). This one records what a caller TRIED and was not
 * allowed to do, which is the more interesting half of an audit trail: an agent
 * repeatedly reaching for something destructive, or bumping into its own tier
 * ceiling, is exactly the pattern an operator wants to see in the feed.
 *
 * Anonymous attempts are recorded too, under `actorType: 'system'` rather than as
 * a nameless agent. An unidentified caller reaching for something irreversible is
 * the single most interesting line this observer can write, and the tier gate does
 * not let identity presence decide whether to gate — so it must not decide whether
 * to audit either.
 *
 * Allowed calls are deliberately NOT recorded here, so one invocation produces one
 * Activity record and never two. For a REGISTRY capability the attribution
 * observer next door writes that record.
 *
 * For a hand-registered MCP tool (DOR-468) nobody does, and that is a real gap
 * rather than a symmetry: the attribution observer is wired into
 * `composeDorkOsCapabilityRegistry`, so it only fires inside `registry.invoke`,
 * which those 47 tools never reach. An approved `tasks_delete` therefore produces
 * an `approval_required` line here, a durable approval record when the person
 * grants it, and then no line saying it ran. Closing that needs an attribution
 * observer on the hand-registered path (`services/core/mcp-tool-gate.ts`).
 *
 * Because the gate covers those tools, `resourceId` here can be a bare tool name
 * like `tasks_delete` as well as a `domain.verb` capability id. `resourceType`
 * stays `capability` for both: the feed is answering "what did something try to
 * do", and the query API has no `resourceType` filter at all, so splitting the two
 * would buy nothing while scattering one operator question across two buckets that
 * cannot be unioned.
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
  return ({ action, identity, decision }) => {
    const label = identity
      ? identity.displayName || path.basename(identity.agentPath)
      : 'Unidentified caller';
    const pending = decision.outcome === 'approval_required' ? decision.payload : undefined;
    const waiting = pending !== undefined;

    void activityService.emit({
      // An anonymous attempt is recorded as `system`, not as a nameless agent:
      // the feed must not imply DorkOS knows who asked when it does not.
      actorType: identity ? 'agent' : 'system',
      ...(identity ? { actorId: identity.agentPath } : {}),
      actorLabel: label,
      category: 'agent',
      eventType: waiting ? 'capability.approval_required' : 'capability.denied',
      resourceType: 'capability',
      resourceId: action.id,
      resourceLabel: action.title,
      summary: waiting
        ? `${label} needs approval to run ${action.title}`
        : `${label} was not allowed to run ${action.title}`,
      metadata: {
        capabilityId: action.id,
        tier: action.tier,
        ...(identity ? { tierCeiling: identity.tierCeiling } : {}),
        reason: decision.payload.reason,
        ...(pending ? { approvalId: pending.approvalId } : {}),
      },
    });
  };
}
