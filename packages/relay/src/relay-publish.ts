/**
 * Publish logic for the Relay message bus.
 *
 * Handles message publishing including subject validation, access control,
 * budget enforcement, rate limiting, circuit breaker integration, adapter
 * delivery, subscription dispatch, dead-lettering, and trace recording.
 *
 * @module relay/relay-publish
 */
import { monotonicFactory } from 'ulidx';
import { validateSubject, matchesPattern } from './subject-matcher.js';
import { requiresInitiateConsent, BRIDGE_PRINCIPAL_PREFIX } from './lib/consent-scope.js';
import { createDefaultBudget, enforceBudget } from './budget-enforcer.js';
import { checkRateLimit } from './rate-limiter.js';
import { RelayTurnCeiling, type TurnCeilingScope } from './turn-ceiling.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { EndpointRegistry } from './endpoint-registry.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { AccessControl } from './access-control.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { AdapterDelivery, ReplyFailureNotifier } from './adapter-delivery.js';
import type { DeliveryPipeline } from './delivery-pipeline.js';
import type {
  RateLimitConfig,
  PublishOptions,
  EndpointInfo,
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
  TraceStoreLike,
  RelayLogger,
  InitiateConsentGate,
  InitiateConsentDecision,
  PublishResult,
} from './types.js';
import type { BudgetRejectionCode } from '@dorkos/shared/relay-schemas';

// === Types ===

// `PublishResult` is defined in types.ts (so adapter interfaces can reference
// it without a circular import through relay-core.ts) and re-exported here for
// callers that import it from the pipeline module.
export type { PublishResult } from './types.js';

/** Resolved options needed by the publish pipeline. */
export interface PublishResolvedOptions {
  maxHops: number;
  defaultTtlMs: number;
  defaultCallBudget: number;
}

/** Dependencies injected into the RelayPublishPipeline. */
export interface PublishDeps {
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
function ceilingRefusalReason(scope: TurnCeilingScope, subject: string): string {
  return scope === 'global'
    ? 'agent messaging has run its hourly limit of turns for this whole DorkOS, so this ' +
        "message did not start one. It is still in the agent's inbox. Raise " +
        '"relay.maxAgentTurnsTotalPerHour" in your DorkOS config, or wait for the hour to roll.'
    : `${subject} has run its hourly limit of turns, so this message did not start one. ` +
        'It is still in the agent\'s inbox. Raise "relay.maxAgentTurnsPerAgentPerHour" ' +
        'in your DorkOS config, or wait for the hour to roll.';
}

// === Private Helpers ===

const generateUlid = monotonicFactory();

/**
 * Find all registered endpoints whose subject matches the given target.
 *
 * @param endpointRegistry - The endpoint registry to search
 * @param subject - The target subject to match against
 */
function findMatchingEndpoints(
  endpointRegistry: EndpointRegistry,
  subject: string
): EndpointInfo[] {
  return endpointRegistry.listEndpoints().filter((ep) => matchesPattern(ep.subject, subject));
}

// === RelayPublishPipeline ===

/**
 * Encapsulates the publish pipeline for the Relay message bus.
 *
 * Validates subjects, checks access control, enforces rate limits,
 * builds envelopes with budgets, delivers to Maildir endpoints and
 * adapters, dispatches to subscribers, dead-letters undeliverable
 * messages, and records trace spans.
 */
export class RelayPublishPipeline {
  private readonly deps: PublishDeps;
  private readonly opts: PublishResolvedOptions;
  /**
   * The hourly ceiling on agent turns, enforced at the adapter dispatch.
   *
   * Never undefined. A pipeline handed no ceiling builds one with the shipped
   * defaults rather than running uncapped, for the same reason the consent gate
   * denies while unwired: a bound you can lose by forgetting to pass it is not a
   * bound.
   */
  private readonly turnCeiling: RelayTurnCeiling;
  private rateLimitConfig: RateLimitConfig;
  private adapterContextBuilder?: (subject: string) => AdapterContext | undefined;

  /** Optional callback to settle a waiting reply-inbox caller when the budget gate rejects. */
  private replyFailureNotifier?: ReplyFailureNotifier;

  /**
   * The agent→human initiate-consent gate (DOR-277).
   *
   * Optional in the type, never optional in effect: while it is unset, every
   * publish to a bound human channel is denied. See
   * {@link evaluateInitiateConsent}.
   */
  private initiateConsentGate?: InitiateConsentGate;

  constructor(
    deps: PublishDeps,
    opts: PublishResolvedOptions,
    rateLimitConfig: RateLimitConfig,
    adapterContextBuilder?: (subject: string) => AdapterContext | undefined
  ) {
    this.deps = deps;
    this.opts = opts;
    this.rateLimitConfig = rateLimitConfig;
    this.adapterContextBuilder = adapterContextBuilder;
    this.turnCeiling = deps.turnCeiling ?? new RelayTurnCeiling();
  }

  /**
   * Whether delivering this subject would start a real, paid turn.
   *
   * **Asks the adapter, not the subject.** The subject-prefix version of this
   * question shipped wrong: it matched `relay.agent.*` only, while the Claude
   * Code adapter also answers for `relay.system.tasks.*` and routes THAT to a
   * handler which calls `ensureSession` + `sendMessage`. Those are paid turns,
   * they were never counted, and `relay_send` reaches that subject — so the
   * ceiling was bypassable by the party it bounds. Asking the dispatch keeps the
   * two facts in one place, so an adapter that grows another turn-running prefix
   * cannot reopen the door by staying quiet.
   *
   * A dispatch that will not happen is never charged: an adapter-less subject
   * dispatches nothing, and reserving for it would bill the install for turns it
   * never ran — the exact shape of bug that makes people switch ceilings off.
   * An adapter that runs no turns at all (Telegram, Slack, a webhook) implements
   * nothing and falls through to {@link TURN_SUBJECT_PREFIXES}, which its
   * subjects do not match, so it is free — as it should be.
   *
   * **Whatever this answers is carried to the refund**, rather than asked again
   * where the refund happens: the two ends must agree, or an uncounted failure
   * gives back a charge somebody else made.
   *
   * @param subject - The target subject.
   */
  private willDispatchAgentTurn(subject: string): boolean {
    const registry = this.deps.adapterRegistry;
    if (!registry) return false;
    if (registry.getBySubject) {
      const adapter = registry.getBySubject(subject);
      if (!adapter) return false;
      if (adapter.startsAgentTurns) return adapter.startsAgentTurns(subject);
    }
    return TURN_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix));
  }

  /**
   * Make a ceiling refusal visible, on every surface relay already refuses on.
   *
   * Deliberately reuses {@link rejectAtGate}'s three channels rather than
   * inventing a fourth: the warning log, a dead letter under the target subject
   * (which is what fires the host's `onDeadLetter` — the cockpit's Pulse badge
   * and the dead-letters inbox), and the reply-failure notifier that settles a
   * caller blocked in `relay_send_and_wait` or the A2A executor instead of
   * leaving it to time out saying "timed out" when the truth was a ceiling.
   *
   * It does NOT delete the Maildir copies already delivered above. The turn is
   * what was refused, not the message.
   *
   * @param envelope - The envelope whose turn was refused.
   * @param subject - The agent subject.
   * @param reason - The person-facing reason, naming the ceiling that refused.
   */
  private async refuseAgentTurn(
    envelope: RelayEnvelope,
    subject: string,
    reason: string
  ): Promise<void> {
    this.deps.logger?.warn?.(
      `publish refused at turn ceiling: subject=${subject}, from=${envelope.from}, reason=${reason}`
    );

    try {
      await this.deps.maildirStore.ensureMaildir(subject);
      await this.deps.deadLetterQueue.reject(subject, envelope, reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn?.(`failed to dead-letter a ceiling refusal: ${message}`);
    }

    if (envelope.replyTo && this.replyFailureNotifier) {
      try {
        await this.replyFailureNotifier(envelope.replyTo, reason, envelope);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger?.warn?.(`failed to notify reply inbox of a ceiling refusal: ${message}`);
      }
    }
  }

  /** Update the rate limit config (called on hot-reload). */
  setRateLimitConfig(config: RateLimitConfig): void {
    this.rateLimitConfig = config;
  }

  /** Update the adapter context builder (called after construction). */
  setAdapterContextBuilder(builder: (subject: string) => AdapterContext | undefined): void {
    this.adapterContextBuilder = builder;
  }

  /**
   * Register the callback used to notify a reply inbox when the authoritative
   * budget gate rejects a message. Wired by RelayCore with the same notifier
   * instance that {@link AdapterDelivery} uses, so a budget rejection settles a
   * waiting caller (`relay_send_and_wait`, the A2A executor) exactly like a
   * failed detached delivery does.
   *
   * @param notifier - The reply-failure notifier.
   */
  setReplyFailureNotifier(notifier: ReplyFailureNotifier): void {
    this.replyFailureNotifier = notifier;
  }

  /**
   * Register the authoritative agent→human initiate-consent gate (DOR-277).
   *
   * Wired by the host after construction (the binding store the gate reads is
   * not available at RelayCore construction time). Once set, every publish
   * whose `from` is an agent-initiated principal targeting a bound human
   * channel is denied unless the resolved binding is enabled and its
   * `canInitiate` consent is on — closing the side door where `relay_send` to a
   * raw `relay.human.*` subject bypassed the two proactive-notify tool handlers.
   *
   * Until this is called, sends to bound human channels are denied rather than
   * waved through ({@link evaluateInitiateConsent}), so forgetting to wire it —
   * or failing to reach the wiring — cannot open the channel.
   *
   * @param gate - The consent gate predicate.
   */
  setInitiateConsentGate(gate: InitiateConsentGate): void {
    this.initiateConsentGate = gate;
  }

  /**
   * Execute the publish pipeline for a message.
   *
   * Pipeline:
   * 1. Validate subject
   * 2. Check access control (from -> subject)
   * 3. Rate limit check (per-sender sliding window, before fan-out)
   * 4. Build envelope with ULID ID, budget, and payload
   * 4a. Server-only bridge-principal guard — a `relay.bridge.*` `from` without
   *    the `serverBridgePrincipal` trust marker is dead-lettered and NO
   *    delivery path runs (DOR-889)
   * 4b. Authoritative initiate-consent gate — an agent-initiated send to a
   *    bound human channel without `canInitiate` consent is dead-lettered and
   *    NO delivery path runs (DOR-277)
   * 5. Authoritative budget gate (hops, cycle, TTL, call budget) — a rejected
   *    message is dead-lettered and NO delivery path runs (DOR-260)
   * 6. For each matching endpoint: per-copy budget update, deliver via
   *    Maildir, index in SQLite
   * 7. Deliver to matching adapter with the gate-decremented budget
   * 8. Dead-letter when no delivery targets matched
   *
   * @param subject - The target subject for the message
   * @param payload - The message payload (any JSON-serializable value)
   * @param options - Publish options including sender, replyTo, and budget overrides
   * @returns A PublishResult with the message ID and delivery count
   * @throws If the subject is invalid or access is denied
   */
  async publish(
    subject: string,
    payload: unknown,
    options: PublishOptions
  ): Promise<PublishResult> {
    // 1. Validate subject
    const validation = validateSubject(subject);
    if (!validation.valid) {
      throw new Error(`Invalid subject: ${validation.reason.message}`);
    }

    // 2. Access control check
    const accessResult = this.deps.accessControl.checkAccess(options.from, subject);
    if (!accessResult.allowed) {
      throw new Error(
        `Access denied: ${options.from} -> ${subject}` +
          (accessResult.matchedRule
            ? ` (rule: ${accessResult.matchedRule.from} -> ${accessResult.matchedRule.to})`
            : accessResult.reason
              ? ` — ${accessResult.reason}`
              : '')
      );
    }

    // The id is minted before the rate-limit check so a rate-limited publish
    // can be traced like every other non-delivery. It used to return an empty
    // messageId and record nothing at all, which is how a whole class of
    // refusal stayed invisible to every surface that reads traces.
    const messageId = generateUlid();
    const createdAt = new Date().toISOString();

    // 3. Rate limit check (per-sender, before fan-out)
    if (this.rateLimitConfig.enabled) {
      const windowStartIso = new Date(
        Date.now() - this.rateLimitConfig.windowSecs * 1000
      ).toISOString();
      const countInWindow = this.deps.sqliteIndex.countSenderInWindow(options.from, windowStartIso);
      const rateLimitResult = checkRateLimit(options.from, countInWindow, this.rateLimitConfig);
      if (!rateLimitResult.allowed) {
        const reason =
          `rate limit: ${rateLimitResult.currentCount}/${rateLimitResult.limit} ` +
          `messages from ${options.from} in ${this.rateLimitConfig.windowSecs}s`;
        this.deps.logger?.warn?.(`publish rate-limited: ${reason}, subject=${subject}`);
        const rejected: PublishResult['rejected'] = [{ endpointHash: '*', reason: 'rate_limited' }];
        this.recordTrace({
          messageId,
          subject,
          deliveredTo: 0,
          rejected,
          adapterResult: null,
          createdAt,
          error: reason,
          rejectionCode: 'rate_limited',
          ...(options.dispatchId !== undefined ? { dispatchId: options.dispatchId } : {}),
        });
        return { messageId, deliveredTo: 0, rejected };
      }
    }

    // 4. Build envelope
    const budget = createDefaultBudget({
      maxHops: this.opts.maxHops,
      ttl: Date.now() + this.opts.defaultTtlMs,
      callBudgetRemaining: this.opts.defaultCallBudget,
      ...options.budget,
    });
    const envelope: RelayEnvelope = {
      id: messageId,
      subject,
      from: options.from,
      replyTo: options.replyTo,
      budget,
      createdAt,
      payload,
      // Stamped only when the caller supplied one — an unset field keeps the
      // envelope byte-identical to what every pre-existing producer writes.
      ...(options.dispatchId !== undefined ? { dispatchId: options.dispatchId } : {}),
    };

    // Index for rate-limit counting (before fan-out so every published
    // message is tracked regardless of delivery path)
    this.deps.sqliteIndex.insertMessage({
      id: messageId,
      subject,
      endpointHash: '*', // placeholder — not a Maildir endpoint
      status: 'delivered',
      createdAt: envelope.createdAt,
      expiresAt: envelope.budget.ttl ? new Date(envelope.budget.ttl).toISOString() : null,
      sender: options.from,
    });

    // 5-11. Budget gate, deliver, dead-letter, and trace
    return this.deliverAndFinalize(envelope, subject, options, messageId);
  }

  /**
   * Deliver the envelope to all targets and finalize the publish result.
   *
   * Separated from the main publish() to keep individual method complexity
   * manageable while maintaining the complete pipeline logic.
   */
  private async deliverAndFinalize(
    envelope: RelayEnvelope,
    subject: string,
    options: PublishOptions,
    messageId: string
  ): Promise<PublishResult> {
    // 4a. Server-only bridge-principal guard (DOR-889). A `relay.bridge.*`
    //     `from` is emitted only by trusted server code, which asserts that
    //     provenance by setting `serverBridgePrincipal`. Any bridge principal
    //     reaching the pipeline WITHOUT that marker is a caller-supplied `from`
    //     — one that slipped past, or around, the HTTP route guard
    //     (`isServerOnlyPrincipal`, `routes/relay.ts`). A future ingress that
    //     forwards an untrusted `from` without re-implementing that route guard
    //     lands here. Rejecting it at the pipeline — ahead of the consent gate
    //     and every delivery path — makes "a `relay.bridge.*` principal is only
    //     publishable by trusted server code" hold for every ingress by
    //     construction, the second, structural line of defense the per-route
    //     guard alone could not provide. This runs before the consent gate on
    //     purpose: an unmarked bridge `from` is illegitimate regardless of
    //     whether a binding would consent, so it is never handed to the gate to
    //     be classified as a reply or an initiate.
    if (envelope.from.startsWith(BRIDGE_PRINCIPAL_PREFIX) && !options.serverBridgePrincipal) {
      return this.rejectAtGate(
        envelope,
        subject,
        messageId,
        'untrusted_bridge_principal',
        `untrusted bridge principal: "${envelope.from}" was published without the ` +
          `server trust marker, so it is treated as a caller-supplied principal and rejected`
      );
    }

    // 4b. Authoritative agent→human initiate-consent gate (DOR-277). Runs
    //     BEFORE the budget gate and any delivery path, as a sibling
    //     authoritative check: an agent-initiated send to a bound human channel
    //     whose `canInitiate` consent is off (or that has no enabled binding) is
    //     denied here, no matter which publish path it took (relay_send*, A2A,
    //     etc.). Reply-forwarding and system principals are not agent-initiated
    //     and the gate returns allowed for them (see the host-side gate).
    const consent = this.evaluateInitiateConsent(envelope.from, subject);
    if (!consent.allowed) {
      return this.rejectAtGate(
        envelope,
        subject,
        messageId,
        'initiate_denied',
        consent.reason ?? consent.code ?? 'agent is not allowed to start conversations here'
      );
    }

    // 5. Authoritative budget gate — ONE check, against the target subject,
    //    BEFORE any delivery path runs. The per-endpoint Maildir check alone
    //    was insufficient: the adapter fan-out dispatches the real (paid)
    //    agent turn and previously ran unconditionally, so a budget-exhausted
    //    message was dead-lettered on the mailbox side while the live turn
    //    still executed (DOR-260). A rejection here guarantees nothing
    //    downstream runs — no Maildir copy, no adapter dispatch, no
    //    subscriber fan-out.
    const gate = enforceBudget(envelope, subject);
    if (!gate.allowed) {
      return this.rejectAtGate(
        envelope,
        subject,
        messageId,
        'budget_exceeded',
        gate.reason ?? 'budget enforcement failed',
        gate.code
      );
    }

    const matchingEndpoints = findMatchingEndpoints(this.deps.endpointRegistry, subject);

    // 6. Deliver to Maildir endpoints (per-copy budget update inside)
    let deliveredTo = 0;
    const rejected: PublishResult['rejected'] = [];
    const mailboxPressure: Record<string, number> = {};

    for (const endpoint of matchingEndpoints) {
      const result = await this.deps.deliveryPipeline.deliverToEndpoint(endpoint, envelope);
      if (result.delivered) {
        deliveredTo++;
        // A delivery counts as activity — an inbox still receiving replies must
        // not be reaped by the inactivity-based TTL sweeper (M3).
        this.deps.endpointRegistry.touch(endpoint.subject);
      }
      if (result.rejected) rejected.push(result.rejected);
      if (result.pressure !== undefined) mailboxPressure[endpoint.hash] = result.pressure;
    }

    // 7. Deliver to the matching adapter with the gate-decremented budget:
    //    the adapter copy is what triggers the real (paid) agent turn, so it
    //    must consume one call-budget unit, count one hop, and extend the
    //    ancestor chain exactly like a Maildir copy does. Each delivered copy
    //    is decremented exactly once — the Maildir path decrements its own
    //    copies from the original envelope above.
    //
    // 7a. THE TURN CEILING. This dispatch is the one choke point every surface
    //     that can make an agent answer crosses — the rooms tool, `relay_send`,
    //     an A2A peer, a webhook posting back — so it is where the hourly
    //     ceiling is counted, and it is counted WITHOUT asking who is calling
    //     (see `turn-ceiling.ts`). A refusal stops the paid turn and nothing
    //     else: Maildir copies delivered above stand, so the message is still in
    //     the agent's inbox to be read later. It is dead-lettered, traced, logged
    //     and pushed to a waiting caller, because a ceiling nobody can see is
    //     indistinguishable from an agent that ignored you.
    let adapterResult: DeliveryResult | null = null;
    let ceilingRefusal: string | undefined;
    if (this.deps.adapterRegistry) {
      const ceiling = this.willDispatchAgentTurn(subject)
        ? this.turnCeiling.tryReserve(subject)
        : undefined;
      if (ceiling && !ceiling.allowed) {
        ceilingRefusal = ceilingRefusalReason(ceiling.scope!, subject);
        rejected.push({ endpointHash: subject, reason: 'turn_ceiling' });
        await this.refuseAgentTurn(envelope, subject, ceilingRefusal);
      } else {
        const adapterEnvelope: RelayEnvelope = { ...envelope, budget: gate.updatedBudget! };
        adapterResult = await this.deps.adapterDelivery.deliver(
          subject,
          adapterEnvelope,
          this.adapterContextBuilder,
          // Carried, not re-derived. A detached delivery settles long after this
          // returns, and its refund must give back exactly what was charged: an
          // adapter that answers `startsAgentTurns: false` on an agent-shaped
          // subject is uncounted here, and a refund that assumed otherwise would
          // pop somebody else's live reservation.
          { counted: ceiling?.counted === true }
        );
        // The reservation is given back when the dispatch it paid for did not
        // happen: no adapter matched after all, the adapter refused, or it
        // deliberately sent nothing. This is the AWAITED half — a detached
        // `relay.agent.*` delivery reports success immediately and settles later,
        // so its refund is `AdapterDelivery`'s (`refundTurn`). Guarded on
        // `counted`, because a reservation the ceilings never charged has
        // nothing to give back.
        if (
          ceiling?.counted &&
          (!adapterResult || adapterResult.skipped || !adapterResult.success)
        ) {
          this.turnCeiling.release(subject);
        }
      }
      // An adapter that deliberately sent nothing did not deliver anything.
      // The Telegram/Slack echo guard returns success for a message the adapter
      // recognises as its own, which counted as a delivery — so an inbound chat
      // message with no binding behind it still reported `deliveredTo: 1` and
      // traced as `delivered`.
      if (adapterResult?.success && !adapterResult.skipped) deliveredTo++;
    }

    // 8. Dispatch to subscription handlers when no Maildir endpoints exist.
    //    `matched` is how many handlers were invoked; `handled` is how many
    //    took the message. Only the second is a delivery — but the first is
    //    what decides buffering and dead-lettering, so a refused message is
    //    not re-delivered to a late subscriber and does not manufacture a dead
    //    letter for every message in an unbound chat.
    let matchedSubscribers = 0;
    let refusal: string | undefined;
    if (matchingEndpoints.length === 0) {
      const dispatch = await this.dispatchToSubscribers(envelope, subject);
      matchedSubscribers = dispatch.matched;
      refusal = dispatch.refusal;
      deliveredTo += dispatch.handled;
    }

    // 9. Buffer for late subscribers when no handlers matched.
    //    NOT when the ceiling refused: the buffer exists so a subscriber that
    //    arrives a moment late still sees the message, and replaying a turn the
    //    ceiling just declined to run would hand back exactly what it refused.
    if (matchedSubscribers === 0 && matchingEndpoints.length === 0 && !ceilingRefusal) {
      this.deps.subscriptionRegistry.bufferForPendingSubscriber(subject, envelope);
    }

    // 10. Dead-letter only when NO delivery targets matched at all — and never
    //     a second time for a ceiling refusal, which dead-lettered itself with
    //     the reason that actually explains it.
    if (
      deliveredTo === 0 &&
      matchingEndpoints.length === 0 &&
      matchedSubscribers === 0 &&
      !adapterResult?.skipped &&
      !ceilingRefusal
    ) {
      await this.deadLetter(subject, envelope, adapterResult);
    }

    // 11. Record trace span
    this.recordTrace({
      messageId,
      subject,
      deliveredTo,
      rejected,
      adapterResult,
      createdAt: envelope.createdAt,
      // The ceiling's reason wins over a subscriber refusal: it is the one that
      // explains why no turn ran, and it is true even when a Maildir copy landed.
      ...(ceilingRefusal
        ? { error: ceilingRefusal, rejectionCode: 'turn_ceiling' }
        : deliveredTo === 0 && refusal
          ? { error: refusal }
          : {}),
      ...(envelope.dispatchId !== undefined ? { dispatchId: envelope.dispatchId } : {}),
    });

    return {
      messageId,
      deliveredTo,
      ...(rejected.length > 0 && { rejected }),
      ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
      ...(adapterResult && { adapterResult }),
    };
  }

  /**
   * Resolve the initiate-consent decision for one publish.
   *
   * Three outcomes, and the third is the one this method exists for:
   *
   * - **A gate is installed** — it decides. A gate that throws denies (a policy
   *   that cannot answer must not be read as a yes).
   * - **No gate, and the subject needs none** — allowed. Agent-to-agent
   *   traffic, system subjects and the operator's own console never depended on
   *   binding consent.
   * - **No gate, and the subject is a bound human channel** — DENIED. The gate
   *   is installed by the host only once the binding store it reads exists, and
   *   the binding subsystem can fail to come up (a chokidar `EMFILE` on a busy
   *   machine is a documented way for that to happen here). Treating "nobody
   *   installed a gate" as "everybody consents" meant a broken boot turned every
   *   private consent switch off — the machine sent messages to a person's
   *   Telegram or Slack precisely when it had lost the record of whether it was
   *   allowed to. Not knowing is a denial.
   *
   * @param from - The publish principal.
   * @param subject - The target subject.
   */
  private evaluateInitiateConsent(from: string, subject: string): InitiateConsentDecision {
    if (!this.initiateConsentGate) {
      if (!requiresInitiateConsent(subject)) return { allowed: true };
      return {
        allowed: false,
        code: 'NO_BINDING',
        reason:
          'initiate denied: no consent gate is installed, so this relay cannot tell ' +
          'whether you allowed an agent to message this channel. Chat integrations ' +
          'stay silent until the binding subsystem starts.',
      };
    }

    try {
      return this.initiateConsentGate(from, subject);
    } catch (err) {
      // Fail closed: a throwing consent policy denies rather than letting the
      // message slip through undecided. Dead-letter under the target subject.
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn?.(`initiate-consent gate threw; denying: ${message}`);
      return { allowed: false, reason: `consent gate error: ${message}` };
    }
  }

  /**
   * Dispatch to matching subscription handlers (direct fast-path).
   *
   * Only fires when there are NO matching Maildir endpoints, enabling
   * BindingRouter and other subscribers to intercept messages published
   * to subjects with no registered endpoint.
   */
  private async dispatchToSubscribers(
    envelope: RelayEnvelope,
    subject: string
  ): Promise<{ matched: number; handled: number; refusal?: string }> {
    let handled = 0;
    let refusal: string | undefined;
    const subscribers = this.deps.subscriptionRegistry.getSubscribers(subject);
    for (const handler of subscribers) {
      try {
        const verdict = await handler(envelope);
        // A handler that says it did nothing is not a delivery. The first
        // reason given is kept for the trace — it is what a person would be
        // shown if they asked why nothing happened.
        if (verdict && verdict.handled === false) {
          refusal ??= verdict.reason;
          continue;
        }
        handled++;
      } catch {
        // Subscription handler errors are non-fatal for publish()
      }
    }
    return { matched: subscribers.length, handled, ...(refusal ? { refusal } : {}) };
  }

  /**
   * Reject a message at an authoritative pre-delivery gate (budget or consent).
   *
   * Dead-letters the envelope under the target subject (the same convention
   * detached adapter failures use), settles any caller waiting on a reply
   * inbox, and records a failed trace span. Nothing is delivered: no Maildir
   * copy, no adapter dispatch (i.e. no live agent turn), no subscriber
   * fan-out.
   *
   * @param envelope - The envelope being rejected.
   * @param subject - The target subject.
   * @param messageId - The envelope's message id.
   * @param rejectionCode - Machine reason surfaced in the {@link PublishResult}.
   * @param reason - Human-readable reason recorded on the dead letter.
   */
  private async rejectAtGate(
    envelope: RelayEnvelope,
    subject: string,
    messageId: string,
    rejectionCode: NonNullable<PublishResult['rejected']>[number]['reason'],
    reason: string,
    budgetCode?: BudgetRejectionCode
  ): Promise<PublishResult> {
    this.deps.logger?.warn?.(
      `publish rejected at ${rejectionCode} gate: subject=${subject}, ` +
        `from=${envelope.from}, reason=${reason}`
    );

    await this.deps.maildirStore.ensureMaildir(subject);
    await this.deps.deadLetterQueue.reject(subject, envelope, reason);

    // Settle a waiting caller (relay_send_and_wait, the A2A executor) now
    // instead of leaving it to block until its own timeout.
    if (envelope.replyTo && this.replyFailureNotifier) {
      try {
        await this.replyFailureNotifier(envelope.replyTo, reason, envelope);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger?.warn?.(`failed to notify reply inbox of gate rejection: ${message}`);
      }
    }

    const rejected: PublishResult['rejected'] = [{ endpointHash: subject, reason: rejectionCode }];
    this.recordTrace({
      messageId,
      subject,
      deliveredTo: 0,
      rejected,
      adapterResult: null,
      createdAt: envelope.createdAt,
      error: reason,
      rejectionCode,
      ...(budgetCode ? { budgetCode } : {}),
      ...(envelope.dispatchId !== undefined ? { dispatchId: envelope.dispatchId } : {}),
    });
    return { messageId, deliveredTo: 0, rejected };
  }

  /** Dead-letter a message that had no delivery targets. */
  private async deadLetter(
    subject: string,
    envelope: RelayEnvelope,
    adapterResult: DeliveryResult | null
  ): Promise<void> {
    await this.deps.maildirStore.ensureMaildir(subject);

    const reason = adapterResult?.error
      ? `adapter delivery failed: ${adapterResult.error}`
      : 'no matching endpoints or adapters';
    await this.deps.deadLetterQueue.reject(subject, envelope, reason);
  }

  /**
   * Record a trace span for delivery tracking (best-effort).
   *
   * ## Zero deliveries is two different stories
   *
   * This used to write `failed` for every `deliveredTo === 0`, with no error
   * message, which is how 1,653 rows came to claim failure while naming no
   * cause and one whole day read as a 100% failure rate — its traffic was
   * publishes to a subject nothing subscribed to. A message nobody was
   * listening for is `no_subscriber`: nothing went wrong and nothing needs
   * fixing. A message that hit a gate, a rejecting endpoint, or an adapter
   * error is `failed`, and now carries the reason that made it one.
   *
   * @param span - What happened to one published message.
   */
  private recordTrace(span: {
    messageId: string;
    subject: string;
    deliveredTo: number;
    rejected: PublishResult['rejected'];
    adapterResult: DeliveryResult | null;
    /** When the publish started, for the span's duration. */
    createdAt: string;
    /** Human-readable cause, when this publish was stopped at a gate. */
    error?: string;
    /** Machine rejection code, when one applies (gate or budget). */
    rejectionCode?: string;
    /** The budget check that rejected it, for the budget-rejection counters. */
    budgetCode?: BudgetRejectionCode;
    /**
     * The dispatch this publish belongs to, when the caller knows it.
     *
     * This is what turns the `relayTraces` table into the thing it was built
     * for. `traceId` was set to `messageId` on every row, so every trace had
     * exactly one span and `getTrace(traceId)` could only return the row you
     * already had. Sharing the dispatch id across hops makes it a real trace.
     */
    dispatchId?: string;
  }): void {
    if (!this.deps.traceStore) return;
    const { messageId, subject, deliveredTo, rejected, adapterResult, createdAt } = span;
    const failureReason = span.error ?? adapterResult?.error ?? undefined;
    const status =
      deliveredTo > 0
        ? 'delivered'
        : failureReason || (rejected?.length ?? 0) > 0
          ? 'failed'
          : 'no_subscriber';
    try {
      this.deps.traceStore.insertSpan({
        messageId,
        traceId: span.dispatchId ?? messageId,
        subject,
        status,
        // A delivery that happened has a time it happened at. Leaving this null
        // on the delivered path is what left the latency percentiles computing
        // over an empty column while the panel presented them as measurements.
        ...(status === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}),
        ...(failureReason ? { error: failureReason } : {}),
        metadata: {
          deliveredTo,
          rejectedCount: rejected?.length ?? 0,
          hasAdapterResult: !!adapterResult,
          durationMs: Date.now() - new Date(createdAt).getTime(),
          ...(span.rejectionCode ? { rejectionCode: span.rejectionCode } : {}),
          ...(span.budgetCode ? { budgetCode: span.budgetCode } : {}),
        },
      });
    } catch {
      // Trace insertion is best-effort — never fail a publish for tracing
    }
  }
}
