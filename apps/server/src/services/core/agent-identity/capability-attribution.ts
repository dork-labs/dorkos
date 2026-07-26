/**
 * Turn capability invocations by an identified agent into Activity events
 * (spec `agent-trust` §3.1).
 *
 * The Activity feed already models a non-human actor — `actorType: 'agent'`
 * with an `actorId` — but nothing populated it for the agent-operator surface,
 * so an agent driving DorkOS through `dorkos call` or the `/mcp` tools left no
 * trace of WHO acted. This observer closes that gap at the registry's single
 * invocation choke point, so every surface gains attribution at once.
 *
 * ## Identified invocations, plus every destructive one
 *
 * For `observe` and `act` capabilities the observer fires only when a request
 * resolved an agent identity. An unattributed call — the human operator in the
 * cockpit, an external MCP client with no token — writes nothing, so the
 * absent-token path stays exactly as it was before identity existed (spec §3.1).
 * Attribution is the feature; logging every anonymous read would be a different,
 * noisier one.
 *
 * A `destructive` invocation is always recorded, identified or not, under
 * `actorType: 'system'` when DorkOS does not know who asked. The tier gate does
 * not audit calls it ALLOWS (it defers to this observer), so an anonymous
 * destructive call used to leave a "waiting for approval" line and then nothing at
 * all about the irreversible thing that ran. An unidentified caller completing
 * something irreversible is the single most important line in this feed.
 *
 * @module services/core/agent-identity/capability-attribution
 */
import path from 'node:path';
import type { ActivityService } from '../../activity/activity-service.js';
import type { CapabilityInvocationObserver } from '../capabilities/index.js';

/**
 * Build the {@link CapabilityInvocationObserver} that records agent-attributed
 * capability invocations in the Activity feed.
 *
 * `emit` is fire-and-forget and never throws, so the returned observer is safe
 * to call on both the success and failure paths of an invocation.
 *
 * @param activityService - The Activity feed writer.
 * @returns An observer to hand to `composeRegistry`.
 */
export function createCapabilityAttributionObserver(
  activityService: ActivityService
): CapabilityInvocationObserver {
  return ({ capability, context, ok }) => {
    const identity = context.identity;
    // Anonymous reads and ordinary changes stay silent; an anonymous irreversible
    // action does not (see the module TSDoc).
    if (!identity && capability.tier !== 'destructive') return;

    // The agent's directory name is the legible handle; the full path is the
    // stable id, and the feed links on ids, not labels.
    const label = identity
      ? identity.displayName || path.basename(identity.agentPath)
      : 'Unidentified caller';

    void activityService.emit({
      // `system` rather than a nameless agent: the feed must not imply DorkOS
      // knows who acted when it does not.
      actorType: identity ? 'agent' : 'system',
      ...(identity ? { actorId: identity.agentPath } : {}),
      actorLabel: label,
      category: 'agent',
      eventType: ok ? 'capability.invoked' : 'capability.failed',
      resourceType: 'capability',
      resourceId: capability.id,
      resourceLabel: capability.title,
      summary: ok
        ? `${label} ran ${capability.title}`
        : `${label} tried to run ${capability.title} and it failed`,
      metadata: {
        capabilityId: capability.id,
        tier: capability.tier,
        ...(context.approval ? { approvalId: context.approval.approvalId } : {}),
      },
    });
  };
}
