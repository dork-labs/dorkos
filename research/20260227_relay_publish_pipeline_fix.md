# Relay Publish Pipeline Fix: Message Bus Patterns and Adapter Delivery Research

## Research Summary

The DorkOS Relay message bus has a publish pipeline bug where an early return at step 5 (no matching Maildir endpoints) skips adapter delivery at step 7. This research examines how production message buses (NATS, RabbitMQ, Kafka, Azure Service Bus) handle multiple delivery targets, dead-lettering, and adapter/plugin delivery. The findings provide concrete patterns and recommendations for fixing the pipeline and improving the adapter system.

## Key Findings

### 1. The Pipeline Bug Is a Classic "Short-Circuit Before Fan-Out Completion" Anti-Pattern

The current code at `packages/relay/src/relay-core.ts` lines 308-315:

```typescript
if (matchingEndpoints.length === 0) {
  // No matching endpoints -- send to DLQ for the sender's information
  const { hashSubject } = await import('./endpoint-registry.js');
  const subjectHash = hashSubject(subject);
  await this.maildirStore.ensureMaildir(subjectHash);
  await this.deadLetterQueue.reject(subjectHash, envelope, 'no matching endpoints');
  return { messageId, deliveredTo: 0 };
}
```

This early return was written before adapters existed. Adapter delivery (step 7, lines 337-348) handles subjects that do NOT have Maildir endpoints (e.g., `relay.agent.*` subjects handled by `ClaudeCodeAdapter`). The early return means adapter delivery is never reached for these subjects.

**Every production message bus avoids this pattern.** RabbitMQ's Alternate Exchange, NATS's interest-based retention, and Kafka's consumer group model all treat "no traditional queue/consumer" as distinct from "no delivery mechanism at all."

### 2. RabbitMQ's Alternate Exchange Is the Closest Analog to This Fix

RabbitMQ has a first-class concept called [Alternate Exchanges](https://www.rabbitmq.com/docs/ae) that directly addresses this exact scenario:

- When a message published to an exchange **cannot be routed to any queue**, the channel re-publishes the message to the specified alternate exchange
- The alternate exchange acts as a "fallback" or "catch-all" for messages that would otherwise be discarded
- This prevents message loss by ensuring unroutable messages reach a designated alternate path
- "If a message is routed via an alternate exchange it still counts as routed for the purpose of the 'mandatory' flag"

**Key insight**: RabbitMQ does NOT dead-letter when there are no queue bindings -- it tries the alternate exchange first. Dead-lettering happens only when ALL delivery paths (including the alternate exchange) fail.

### 3. NATS Uses Interest-Based Retention to Track All Consumer Types

NATS JetStream distinguishes between "no interest" and "no active subscribers":

- [Interest-based retention](https://docs.nats.io/nats-concepts/jetstream) means messages are retained as long as ANY consumer (virtual or physical) has expressed interest
- "It is not required to be actively consuming messages to show interest, but it is the presence of a consumer which the stream cares about"
- Core NATS returns a ["no responders" status](https://docs.nats.io/reference/reference-protocols/nats-protocol) (503) when publishing to a subject with zero subscribers -- but this checks ALL subscriber types, not just one type

**Key insight**: NATS treats virtual consumers (push, pull, queue groups) and core subscribers uniformly. The system checks ALL delivery mechanisms before declaring "no interest."

### 4. Dead-Lettering Should Be the Last Resort After ALL Delivery Mechanisms Fail

Production message buses consistently follow this principle:

- **Azure Service Bus**: "The purpose of the dead-letter queue is to hold messages that can't be delivered to any receiver" -- [Microsoft Docs](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues). The key word is "any."
- **Enterprise Integration Patterns**: The [Dead Letter Channel](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html) pattern states: "When a messaging system determines that it cannot or should not deliver a message, it may elect to move the message to a Dead Letter Channel." The determination must consider all delivery paths.
- **Kafka**: Dead Letter Queues are implemented at the consumer level, after all consumer groups have had a chance to process. Messages are only dead-lettered after retry exhaustion at the individual consumer level, not at the topic level. -- [Confluent Guide](https://www.confluent.io/learn/kafka-dead-letter-queue/)

**Best practice from [OneUptime DLQ Patterns](https://oneuptime.com/blog/post/2026-02-09-dead-letter-queue-patterns/view)**: Dead-lettering should occur only after:
1. All delivery mechanisms have been attempted
2. Retry limits have been exhausted
3. The message is definitively undeliverable

### 5. Adapter Delivery Should Be Independent and Parallel to Primary Delivery

[MassTransit's publish pipeline](https://masstransit.io/documentation/configuration/middleware) treats different consumer types uniformly through its filter middleware architecture:

- Publish observers monitor all outbound messages regardless of transport
- Different transports (in-memory, RabbitMQ, Azure SB) are treated as independent delivery targets
- A message is considered "published" when it reaches ALL registered transports

**Key insight from [Honeycomb's distributed tracing through message buses](https://www.honeycomb.io/blog/understanding-distributed-tracing-message-bus)**: Fan-out to multiple delivery targets should use span links (not parent-child) for tracing, because each delivery path is independent. High fan-out scenarios benefit from this separation.

## Detailed Analysis

### The Fix: Restructured Publish Pipeline

The publish pipeline should be restructured from its current 7-step linear flow to a proper fan-out model:

#### Current (Broken) Pipeline

```
1. Validate subject
2. Access control
3. Rate limit
4. Build envelope
5. Find Maildir endpoints -> if none, DLQ + EARLY RETURN  <-- BUG
6. Deliver to Maildir endpoints
7. Deliver to adapters  <-- NEVER REACHED for adapter-only subjects
```

#### Proposed Pipeline (Three Solutions)

**Solution A: Move Adapter Delivery Before the Early Return (Minimal Fix)**

```
1. Validate subject
2. Access control
3. Rate limit
4. Build envelope
5. Find Maildir endpoints
6. Deliver to Maildir endpoints (if any)
7. Deliver to adapters (always)
8. If neither delivered -> DLQ
```

Pros:
- Smallest code change (move adapter block before the early return check)
- Adapter delivery stays non-fatal (try/catch preserved)
- Easy to review and test

Cons:
- Dead-letter logic becomes slightly more complex (must check both Maildir and adapter delivery)
- Pipeline still feels sequential -- adapter delivery is an afterthought

**Solution B: Unified Fan-Out Model (Recommended)**

```
1. Validate subject
2. Access control
3. Rate limit
4. Build envelope
5. Collect ALL delivery targets:
   a. Maildir endpoints matching subject
   b. Adapter matching subject prefix
6. If no targets at all -> DLQ
7. Fan-out deliver to all targets (Maildir + adapter, potentially parallel)
8. Aggregate results
```

Pros:
- Treats adapters and Maildir endpoints uniformly as "delivery targets"
- Dead-lettering only happens when NO target exists (correct semantics)
- Natural extension point for future delivery mechanisms
- Adapter delivery counts toward `deliveredTo` consistently
- Closer to how NATS and RabbitMQ model their delivery

Cons:
- Larger refactor than Solution A
- Need to define a common delivery target interface
- Adapter failures should still be non-fatal, which needs careful handling in the fan-out

**Solution C: Two-Phase Delivery (RabbitMQ-Inspired Alternate Exchange)**

```
1. Validate subject
2. Access control
3. Rate limit
4. Build envelope
5. Phase 1: Try Maildir endpoints
6. Phase 2: Try adapters (always, regardless of Phase 1 results)
7. If Phase 1 AND Phase 2 both delivered 0 -> DLQ
```

Pros:
- Clear two-phase model, easy to reason about
- Adapter is explicitly the "alternate delivery path" (like RabbitMQ AE)
- Dead-letter only when both phases fail

Cons:
- Still feels like adapters are "secondary" -- slightly misleading for subjects where adapters are the primary target

#### Recommendation: Solution B (Unified Fan-Out)

Solution B is the cleanest long-term approach. Here is a concrete implementation sketch:

```typescript
// In publish():

// 5. Collect all delivery targets
const maildirTargets = this.findMatchingEndpoints(subject);
const adapterTarget = this.adapterRegistry
  ? this.adapterRegistry.getBySubject(subject)
  : undefined;

const hasTargets = maildirTargets.length > 0 || adapterTarget !== undefined;

// 6. No targets at all -> DLQ
if (!hasTargets) {
  const { hashSubject } = await import('./endpoint-registry.js');
  const subjectHash = hashSubject(subject);
  await this.maildirStore.ensureMaildir(subjectHash);
  await this.deadLetterQueue.reject(subjectHash, envelope, 'no matching endpoints');
  return { messageId, deliveredTo: 0 };
}

// 7. Fan-out to all targets
let deliveredTo = 0;
const rejected: PublishResult['rejected'] = [];
const mailboxPressure: Record<string, number> = {};

// 7a. Maildir endpoints
for (const endpoint of maildirTargets) {
  const result = await this.deliverToEndpoint(endpoint, envelope);
  if (result.delivered) deliveredTo++;
  if (result.rejected) rejected.push(result.rejected);
  if (result.pressure !== undefined) mailboxPressure[endpoint.hash] = result.pressure;
}

// 7b. Adapter delivery
if (adapterTarget) {
  try {
    const context = this.adapterContextBuilder?.(subject);
    const adapterDelivered = await this.adapterRegistry!.deliver(subject, envelope, context);
    if (adapterDelivered) deliveredTo++;
  } catch (err) {
    console.warn('RelayCore: adapter delivery failed:', err instanceof Error ? err.message : err);
  }
}

return {
  messageId,
  deliveredTo,
  ...(rejected.length > 0 && { rejected }),
  ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
};
```

**Important**: The `AdapterRegistryLike` interface currently lacks a `getBySubject()` method. It only has `deliver()`, which internally calls `getBySubject()`. To check for adapter presence without triggering delivery, either:
1. Add a `hasMatch(subject: string): boolean` method to `AdapterRegistryLike`
2. Use the adapter registry's `deliver()` return value (returns `false` if no adapter matched) and simply always call it

Option 2 is simpler and maintains the existing interface:

```typescript
// Simplified: always attempt adapter delivery, check both results
const maildirTargets = this.findMatchingEndpoints(subject);

let deliveredTo = 0;
const rejected: PublishResult['rejected'] = [];
const mailboxPressure: Record<string, number> = {};

// Maildir delivery
for (const endpoint of maildirTargets) {
  const result = await this.deliverToEndpoint(endpoint, envelope);
  if (result.delivered) deliveredTo++;
  if (result.rejected) rejected.push(result.rejected);
  if (result.pressure !== undefined) mailboxPressure[endpoint.hash] = result.pressure;
}

// Adapter delivery (always attempted, even if Maildir delivered)
let adapterDelivered = false;
if (this.adapterRegistry) {
  try {
    const context = this.adapterContextBuilder?.(subject);
    adapterDelivered = await this.adapterRegistry.deliver(subject, envelope, context);
    if (adapterDelivered) deliveredTo++;
  } catch (err) {
    console.warn('RelayCore: adapter delivery failed:', err instanceof Error ? err.message : err);
  }
}

// DLQ only when NOTHING delivered
if (deliveredTo === 0 && !adapterDelivered) {
  const { hashSubject } = await import('./endpoint-registry.js');
  const subjectHash = hashSubject(subject);
  await this.maildirStore.ensureMaildir(subjectHash);
  await this.deadLetterQueue.reject(subjectHash, envelope, 'no matching endpoints');
}

return {
  messageId,
  deliveredTo,
  ...(rejected.length > 0 && { rejected }),
  ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
};
```

### Dead Letter Queue Semantics

Based on research across Azure Service Bus, RabbitMQ, Kafka, and the EIP Dead Letter Channel pattern, here are the corrected DLQ semantics:

| Scenario | Current Behavior | Correct Behavior |
|---|---|---|
| No Maildir, no adapter | DLQ + return | DLQ (correct) |
| No Maildir, adapter matches | DLQ + return (SKIPS adapter) | Adapter delivery only, no DLQ |
| Maildir matches, no adapter | Maildir delivery | Maildir delivery (correct) |
| Maildir + adapter both match | Maildir + adapter delivery | Both deliver (correct, but currently unreachable if Maildir finds 0) |
| Maildir matches, adapter fails | Maildir delivery (adapter error swallowed) | Maildir delivery, log adapter error (correct) |
| No Maildir, adapter fails | DLQ (wrong path) | DLQ with reason "adapter delivery failed" |

### Adapter System Improvements

#### 1. Health Checking and Status Reporting

The adapter system already has `getStatus()` returning `AdapterStatus` with states (`connected`, `disconnected`, `error`, `starting`, `stopping`). Improvements:

- **Periodic health probes**: Add a `healthCheck()` method to `RelayAdapter` that performs a lightweight connectivity check. The `AdapterManager` can call this on a configurable interval (e.g., every 30 seconds) and update status.
- **Health-aware delivery**: Skip delivery to adapters in `error` or `disconnected` state, avoiding unnecessary timeouts. Based on the [circuit breaker pattern](https://microservices.io/patterns/reliability/circuit-breaker.html), this is similar to a "half-open" check.

```typescript
// Proposed addition to RelayAdapter interface
interface RelayAdapter {
  // ... existing methods ...

  /** Lightweight connectivity check. Default: returns true if state is 'connected'. */
  healthCheck?(): Promise<boolean>;
}
```

#### 2. Circuit Breaker for Adapter Delivery

The relay already has a `CircuitBreakerManager` for Maildir endpoints. Apply the same pattern to adapters:

- Track consecutive adapter delivery failures per adapter ID
- Trip the breaker after N failures (configurable, default 5)
- Enter cooldown period where adapter delivery is skipped
- Allow probe deliveries in half-open state

This prevents adapter failures from causing cascading latency in the publish pipeline, following the [circuit breaker pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html).

#### 3. Timeout Handling for Adapter Delivery

The current adapter delivery has no timeout in the publish pipeline. The `testConnection` method uses `CONNECTION_TEST_TIMEOUT_MS = 15_000`, but actual delivery in `relay-core.ts` has no timeout wrapper:

```typescript
// Current: no timeout protection
const adapterDelivered = await this.adapterRegistry.deliver(subject, envelope, context);
```

Recommendation: Wrap adapter delivery with a timeout (use the `DeliveryResult.durationMs` field for observability):

```typescript
const ADAPTER_DELIVERY_TIMEOUT_MS = 30_000;

const adapterDelivered = await Promise.race([
  this.adapterRegistry.deliver(subject, envelope, context),
  new Promise<boolean>((_, reject) =>
    setTimeout(() => reject(new Error('Adapter delivery timeout')), ADAPTER_DELIVERY_TIMEOUT_MS)
  ),
]);
```

#### 4. Adapter Priority and Ordering

The current `AdapterRegistry.getBySubject()` returns the first matching adapter. For subjects that could match multiple adapters, consider:

- **Priority field**: Add a `priority` number to `RelayAdapter` (higher = checked first)
- **Multi-adapter delivery**: Change `deliver()` to fan out to ALL matching adapters, not just the first
- **Fallback chain**: If the primary adapter fails, try the next matching adapter

This is inspired by [event bus priority ordering patterns](https://dzone.com/articles/design-patterns-event-bus) where subscribers can specify priority.

#### 5. Observability and Tracing Through Adapter Delivery

The `AdapterContext` already has a `trace` field. Improvements based on [Honeycomb's distributed tracing through message bus](https://www.honeycomb.io/blog/understanding-distributed-tracing-message-bus):

- **Span links over parent-child**: For fan-out delivery, create separate trace spans for Maildir and adapter delivery, linked to the publish span rather than nested as children
- **Correlation ID propagation**: Ensure the envelope `id` (ULID) is propagated through adapter delivery as a correlation ID
- **Adapter delivery duration**: Track and report `DeliveryResult.durationMs` in metrics

#### 6. Rate Limiting Per Adapter

The relay has per-sender rate limiting, but no per-adapter rate limiting. An overloaded adapter (e.g., a webhook endpoint with rate limits) should have its own throttling:

```typescript
interface RelayAdapter {
  // ... existing ...

  /** Optional rate limit for this adapter (messages per second). */
  readonly rateLimit?: number;
}
```

#### 7. Hot-Reload Improvements

The `AdapterManager` already supports hot-reload via chokidar. Improvements:

- **Graceful drain**: When hot-reloading, the `AdapterRegistry.register()` already starts new before stopping old. Add a configurable drain timeout.
- **Config validation**: Validate new config against the adapter's manifest `configFields` before attempting reload
- **Rollback on failure**: If the new adapter fails to start during hot-reload, keep the old adapter and emit a signal

### Partial Delivery Handling

Based on research into [ActiveMQ](https://activemq.apache.org/components/classic/documentation/message-redelivery-and-dlq-handling) and [Google Cloud Pub/Sub](https://cloud.google.com/pubsub/docs/handling-failures):

When some delivery targets succeed and others fail:
1. Do NOT dead-letter the message (it was partially delivered)
2. Record the partial delivery in the index (e.g., `status: 'partial'`)
3. Log the failure with the specific target that failed
4. Consider retry for the failed target only

The current relay code handles this correctly for Maildir endpoints (individual failures don't affect other endpoints), and adapter failures are already non-fatal (try/catch). The fix should maintain this behavior.

### Security Considerations

1. **Adapter isolation**: Adapter delivery failures should never expose internal state. The current try/catch in the publish pipeline is correct but should avoid logging the full error to prevent information leakage.
2. **Access control for adapters**: The access control check (step 2) applies to the sender, not the adapter. Consider whether adapters should have their own access control rules (e.g., which subjects an adapter is allowed to handle).
3. **Budget enforcement for adapter delivery**: Currently, budget enforcement only applies to Maildir delivery. Adapters bypass budget checks. Consider whether adapter delivery should decrement the call budget.

### Performance Considerations

1. **Adapter delivery latency**: The ClaudeCodeAdapter triggers an AgentManager session, which can take seconds to minutes. This should not block the publish pipeline return. Consider making adapter delivery fire-and-forget with a trace ID for tracking.
2. **Dynamic import in DLQ path**: The `await import('./endpoint-registry.js')` in the DLQ path is a dynamic import that could be hoisted to a static import for better performance.
3. **Parallel delivery**: Maildir endpoint delivery is sequential (for loop). For fan-out to multiple endpoints, consider `Promise.allSettled()` for parallel delivery.

## Sources & Evidence

### Message Bus Architecture
- [NATS Subject-Based Messaging](https://docs.nats.io/nats-concepts/subjects) - Subject matching with wildcards, fan-out delivery
- [NATS JetStream Consumers](https://docs.nats.io/nats-concepts/jetstream/consumers) - Push vs pull consumers, interest-based retention
- [NATS JetStream Model Deep Dive](https://docs.nats.io/using-nats/developer/develop_jetstream/model_deep_dive) - Interest policy retention behavior
- [RabbitMQ Alternate Exchanges](https://www.rabbitmq.com/docs/ae) - Unroutable message fallback mechanism
- [RabbitMQ Dead Letter Exchanges](https://www.rabbitmq.com/docs/dlx) - Dead letter routing and configuration
- [Collecting Unroutable Messages in RabbitMQ Alternate Exchange](https://www.cloudamqp.com/blog/collecting-unroutable-messages-in-a-rabbitmq-alternate-exchange.html) - Practical alternate exchange patterns
- [Apache Kafka Dead Letter Queue Guide](https://www.confluent.io/learn/kafka-dead-letter-queue/) - Kafka DLQ patterns and implementation

### Dead Letter Queue Patterns
- [Azure Service Bus Dead-Letter Queues](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues) - "Hold messages that can't be delivered to any receiver"
- [Dead Letter Channel - Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html) - Canonical DLQ pattern definition
- [Dead Letter Queue Patterns - OneUptime](https://oneuptime.com/blog/post/2026-02-09-dead-letter-queue-patterns/view) - DLQ implementation across Kafka, RabbitMQ, NATS
- [Dead Letter Queue - Wikipedia](https://en.wikipedia.org/wiki/Dead_letter_queue) - General DLQ concepts

### Adapter and Plugin Patterns
- [Channel Adapter - Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/ChannelAdapter.html) - Connecting applications to messaging systems via adapters
- [Message Endpoint - Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessageEndpoint.html) - Application-to-messaging endpoint interface
- [Message Broker - Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessageBroker.html) - Central routing and delivery patterns

### Resilience Patterns
- [Circuit Breaker Pattern - AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html) - Three-state circuit breaker (closed/open/half-open)
- [Circuit Breaker Pattern - Microservices.io](https://microservices.io/patterns/reliability/circuit-breaker.html) - Pattern definition with adapter context
- [MassTransit Middleware](https://masstransit.io/documentation/configuration/middleware) - Publish pipeline middleware and filter patterns
- [MassTransit Observability](https://masstransit.io/documentation/configuration/observability) - Message observer patterns for monitoring

### Observability
- [Understanding Distributed Tracing with a Message Bus - Honeycomb](https://www.honeycomb.io/blog/understanding-distributed-tracing-message-bus) - Trace context propagation, span links vs parent-child for fan-out
- [Design Patterns: Event Bus](https://dzone.com/articles/design-patterns-event-bus) - Event bus priority ordering and subscriber management

### Graceful Shutdown
- [Health Checks and Graceful Shutdown - Express.js](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html) - Node.js shutdown patterns
- [Graceful Shutdown Handler in Node.js - OneUptime](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view) - SIGTERM handling and connection draining

## Research Gaps & Limitations

- **No direct research found on TypeScript-specific adapter registry patterns** with hot-reload: Most literature covers Java (Spring, MassTransit) or Go patterns. The DorkOS implementation is already more sophisticated than most open-source TypeScript message bus implementations.
- **Limited data on Maildir + adapter hybrid delivery**: The Maildir-based storage model is unusual for a message bus. Most systems use either pure in-memory delivery or database-backed queues. The hybrid approach is unique to DorkOS Relay.
- **Adapter priority/ordering**: No strong consensus in the literature on whether adapters should have explicit priority. Most systems use "all matching subscribers receive" (fan-out) rather than priority-based routing.

## Contradictions & Disputes

- **DLQ before vs after adapter delivery**: Some sources (Azure Service Bus) suggest DLQ should be the absolute last resort, while others (Kafka Connect) dead-letter at the individual consumer level. For DorkOS, the "last resort" approach is more appropriate since adapters are a primary delivery mechanism, not a retry path.
- **Adapter delivery as fire-and-forget vs synchronous**: The ClaudeCodeAdapter's `deliver()` method triggers a potentially long-running agent session. Making this synchronous in the publish pipeline could cause timeouts. However, making it fire-and-forget means `deliveredTo` might report inaccurately. The current code's approach (await delivery but catch errors) is a reasonable middle ground.
- **Should adapter delivery count toward `deliveredTo`?**: The current code increments `deliveredTo` when adapter delivery succeeds. This is consistent with NATS and RabbitMQ behavior where all subscriber types count equally. However, some argue that "delivered to adapter" is not the same as "delivered to final destination" -- the adapter might still fail to reach the external service. The current approach is acceptable with good observability.

## Search Methodology

- Number of searches performed: 12
- Number of pages fetched for deep reading: 5
- Most productive search terms: "RabbitMQ alternate exchange unroutable", "NATS JetStream interest policy", "dead letter queue patterns", "circuit breaker pattern message delivery"
- Primary information sources: Official NATS docs (docs.nats.io), RabbitMQ docs (rabbitmq.com/docs), Enterprise Integration Patterns (enterpriseintegrationpatterns.com), Azure Service Bus docs (learn.microsoft.com), Confluent (confluent.io), Honeycomb (honeycomb.io)
- Codebase analysis: `packages/relay/src/relay-core.ts`, `packages/relay/src/adapter-registry.ts`, `packages/relay/src/types.ts`, `apps/server/src/services/relay/adapter-manager.ts`
