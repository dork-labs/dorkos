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
 * ## Only identified invocations are recorded
 *
 * The observer is wired to fire only when a request resolved an agent identity.
 * An unattributed call — the human operator in the cockpit, an external MCP
 * client with no token — writes nothing, so the absent-token path stays exactly
 * as it was before identity existed (spec §3.1). Attribution is the feature;
 * logging anonymous invocations would be a different, noisier one.
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
    if (!identity) return;

    // The agent's directory name is the legible handle; the full path is the
    // stable id, and the feed links on ids, not labels.
    const label = identity.displayName || path.basename(identity.agentPath);

    void activityService.emit({
      actorType: 'agent',
      actorId: identity.agentPath,
      actorLabel: label,
      category: 'agent',
      eventType: ok ? 'capability.invoked' : 'capability.failed',
      resourceType: 'capability',
      resourceId: capability.id,
      resourceLabel: capability.title,
      summary: ok
        ? `${label} ran ${capability.title}`
        : `${label} tried to run ${capability.title} and it failed`,
      metadata: { capabilityId: capability.id, tier: capability.tier },
    });
  };
}
