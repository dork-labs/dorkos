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
 * ## A request is not a failure
 *
 * The request tool (`request_permission`, a capability that forwards an
 * approval) hands on the gate's refusal for the action it asked about: that is
 * how a card, or a request held back by its limits, reaches the agent. Neither
 * is a failure, so each is recorded as what happened: `capability.asked` when a
 * card went to a person, and `capability.request_refused` when DorkOS turned the
 * request down itself, naming why. Only a real error is `capability.failed`.
 *
 * @module services/core/agent-identity/capability-attribution
 */
import type { ActivityService } from '../../activity/activity-service.js';
import { activityActorForIdentity } from '../../activity/activity-actor.js';
import {
  CapabilityGateRefusal,
  type CapabilityDefinition,
  type CapabilityInvocationObserver,
} from '../capabilities/index.js';

/** Why DorkOS turned a request down itself, as the feed says it. */
const REQUEST_REFUSED_BECAUSE: Record<string, string> = {
  request_pending: 'it already has a request waiting in that area',
  recently_denied: 'the answer to the same request was no less than a day ago',
  request_limit: 'it has already asked five times this hour',
};

/** What an invocation came to, for the feed. */
interface AttributedOutcome {
  eventType: string;
  summary: string;
  metadata: Record<string, unknown>;
}

/**
 * Read a gate refusal the request tool passed on, or `undefined` for anything
 * else (see "A request is not a failure" in the module TSDoc).
 *
 * @param capability - The capability that threw.
 * @param error - What it threw.
 * @param label - Who asked, as the feed names them.
 */
function requestOutcome(
  capability: CapabilityDefinition,
  error: unknown,
  label: string
): AttributedOutcome | undefined {
  if (!capability.forwardsApproval || !(error instanceof CapabilityGateRefusal)) return undefined;
  const { decision } = error;
  const payload = decision.payload;
  const target = payload.capabilityTitle;
  const facts = { requestedCapabilityId: payload.capabilityId, reason: payload.reason };
  if (decision.outcome === 'approval_required') {
    return {
      eventType: 'capability.asked',
      summary: `${label} asked to be allowed to run ${target}`,
      metadata: { ...facts, approvalId: decision.payload.approvalId },
    };
  }
  const because = REQUEST_REFUSED_BECAUSE[payload.reason];
  return {
    eventType: 'capability.request_refused',
    summary: because
      ? `${label} asked to be allowed to run ${target}, and was not asked again because ${because}`
      : `${label} asked to be allowed to run ${target}, and DorkOS refused: ${payload.message}`,
    metadata: facts,
  };
}

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
  return ({ capability, context, ok, error }) => {
    const identity = context.identity;
    // Anonymous reads and ordinary changes stay silent; an anonymous irreversible
    // action does not (see the module TSDoc).
    if (!identity && capability.tier !== 'destructive') return;

    // One naming of an actor, shared with the gate audit and the extension write
    // routes: an agent by its name and path, and an unidentified caller as
    // `system` rather than a nameless agent, because the feed must not imply
    // DorkOS knows who acted when it does not.
    const actor = activityActorForIdentity(identity);
    const label = actor.actorLabel;
    const request = ok ? undefined : requestOutcome(capability, error, label);

    void activityService.emit({
      ...actor,
      category: 'agent',
      eventType: request?.eventType ?? (ok ? 'capability.invoked' : 'capability.failed'),
      resourceType: 'capability',
      resourceId: capability.id,
      resourceLabel: capability.title,
      summary:
        request?.summary ??
        (ok
          ? `${label} ran ${capability.title}`
          : `${label} tried to run ${capability.title} and it failed`),
      metadata: {
        capabilityId: capability.id,
        tier: capability.tier,
        ...request?.metadata,
        // Which of the two proofs of consent allowed the call, never just "there
        // was one". A person deciding this exact action and a setting they made
        // earlier are different facts, and a feed that flattened them could not
        // answer the question an Always allow creates: what ran while nobody was
        // being asked.
        ...(context.approval?.via === 'approval'
          ? { approvalId: context.approval.approvalId }
          : {}),
        // The second proof: the action's permission is set to Allowed, so it ran
        // without a card. The source names the layer a person set it at (spec
        // `agent-permissions` D6).
        ...(context.approval?.via === 'permission'
          ? { permissionSource: context.approval.source }
          : {}),
      },
    });
  };
}
