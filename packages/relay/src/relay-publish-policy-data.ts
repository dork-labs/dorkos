/** Readonly publishing policy DATA and public dependency types; no envelope delivery/issuer. */
import { matchesPattern } from './subject-matcher.js';
import { requiresInitiateConsent } from './lib/consent-scope.js';
import type { DeliveryReceiptStore } from './delivery-receipt-store.js';
import type { EndpointRegistry } from './endpoint-registry.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { AccessControl } from './access-control.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { AdapterDelivery } from './adapter-delivery.js';
import type { DeliveryPipeline } from './delivery-pipeline.js';
import type { RelayTurnCeiling, TurnCeilingScope } from './turn-ceiling.js';
import type {
  AdapterRegistryLike,
  TraceStoreLike,
  RelayLogger,
  EndpointInfo,
  InitiateConsentGate,
  InitiateConsentDecision,
} from './types.js';

/** Resolved options needed by the publish pipeline. */
export interface PublishResolvedOptions {
  maxHops: number;
  defaultTtlMs: number;
  defaultCallBudget: number;
}

/** Dependencies injected into the RelayPublishPipeline. */
export interface PublishDeps {
  receiptStore?: DeliveryReceiptStore;
  endpointRegistry: EndpointRegistry;
  subscriptionRegistry: SubscriptionRegistry;
  maildirStore: MaildirStore;
  sqliteIndex: SqliteIndex;
  accessControl: AccessControl;
  deadLetterQueue: DeadLetterQueue;
  deliveryPipeline: DeliveryPipeline;
  adapterDelivery: AdapterDelivery;
  adapterRegistry?: AdapterRegistryLike;
  traceStore?: TraceStoreLike;
  logger?: RelayLogger;
  /**
   * The install-wide ceiling on agent turns started over the bus.
   *
   * Optional in the type and never optional in effect: RelayCore always
   * constructs one (with the shipped defaults when a host wires no limits), so
   * a pipeline built without it is a test double, not a production path.
   */
  turnCeiling?: RelayTurnCeiling;
}

/**
 * Subject prefixes whose adapter dispatch starts a real, paid turn.
 *
 * The FALLBACK, and it covers two cases rather than one: a registry shim that
 * cannot resolve an adapter at all (no `getBySubject`), AND a resolved adapter
 * that stays silent about {@link RelayAdapter.startsAgentTurns}. The
 * authoritative answer is the adapter's own, because the adapter is what knows
 * which of its prefixes end in `sendMessage`.
 *
 * **So this list is a net under today's prefixes, not a substitute for the
 * method.** A silent adapter answering for one of these two is counted; a silent
 * adapter answering for a prefix nobody has invented yet is NOT, and its turns
 * are free. That is the reason a turn-running adapter must implement the method
 * rather than lean on this.
 *
 * Both entries are here because both were reachable and only one was counted:
 * `relay.system.tasks.*` runs a scheduled turn through the SAME dispatch, and
 * `relay_send` will publish to it (`isReservedSubject` guards registration, not
 * publishing), so the ceiling was bypassable by exactly the party it bounds.
 */
const TURN_SUBJECT_PREFIXES = ['relay.agent.', 'relay.system.tasks.'] as const;

/**
 * The line a person is shown when a ceiling refused a turn.
 *
 * Names the ceiling that refused, because the two send someone to different
 * settings, and says what to do rather than what broke.
 *
 * @param scope - Which ceiling refused.
 * @param subject - The agent subject the turn was for.
 */
export function ceilingRefusalReason(scope: TurnCeilingScope, subject: string): string {
  return scope === 'global'
    ? 'agent messaging has run its hourly limit of turns for this whole DorkOS, so this ' +
        "message did not start one. It is still in the agent's inbox. Raise " +
        '"relay.maxAgentTurnsTotalPerHour" in your DorkOS config, or wait for the hour to roll.'
    : `${subject} has run its hourly limit of turns, so this message did not start one. ` +
        'It is still in the agent\'s inbox. Raise "relay.maxAgentTurnsPerAgentPerHour" ' +
        'in your DorkOS config, or wait for the hour to roll.';
}

// === Private Helpers ===

/**
 * Find all registered endpoints whose subject matches the given target.
 *
 * @param endpointRegistry - The endpoint registry to search
 * @param subject - The target subject to match against
 */
export function findMatchingEndpoints(
  endpointRegistry: EndpointRegistry,
  subject: string
): EndpointInfo[] {
  return endpointRegistry.listEndpoints().filter((ep) => matchesPattern(ep.subject, subject));
}

/**
 * Determine whether the resolved adapter starts an agent turn, using known prefixes when it is silent.
 *
 * @param registry - Adapter registry used to resolve the target subject
 * @param subject - Target subject whose dispatch is being classified
 */
export function willDispatchAgentTurn(
  registry: AdapterRegistryLike | undefined,
  subject: string
): boolean {
  if (!registry) return false;
  if (registry.getBySubject) {
    const adapter = registry.getBySubject(subject);
    if (!adapter) return false;
    if (adapter.startsAgentTurns) return adapter.startsAgentTurns(subject);
  }
  return TURN_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix));
}

/**
 * Evaluate the installed initiate-consent gate and deny when required policy is absent or throws.
 *
 * @param gate - Host-installed consent decision callback
 * @param logger - Optional logger for a thrown consent decision
 * @param from - Publishing principal passed to the consent gate
 * @param subject - Target subject passed to the consent gate
 */
export function evaluateInitiateConsent(
  gate: InitiateConsentGate | undefined,
  logger: RelayLogger | undefined,
  from: string,
  subject: string
): InitiateConsentDecision {
  if (!gate) {
    if (!requiresInitiateConsent(subject)) return { allowed: true };
    return {
      allowed: false,
      code: 'NO_BINDING',
      reason:
        'initiate denied: no consent gate is installed, so this relay cannot tell ' +
        'whether you allowed an agent to message this channel. Chat connections ' +
        'stay silent until the binding subsystem starts.',
    };
  }

  try {
    return gate(from, subject);
  } catch (err) {
    // Fail closed: a throwing consent policy denies rather than letting the
    // message slip through undecided. Dead-letter under the target subject.
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`initiate-consent gate threw; denying: ${message}`);
    return { allowed: false, reason: `consent gate error: ${message}` };
  }
}
