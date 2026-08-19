/**
 * Internal type definitions for the @dorkos/relay package.
 *
 * All types used across relay modules are defined here to avoid
 * circular imports and provide a single source of truth.
 *
 * Config types (RateLimitConfig, CircuitBreakerConfig, BackpressureConfig,
 * ReliabilityConfig, TelegramAdapterConfig, WebhookAdapterConfig, AdapterConfig,
 * AdapterStatus) are imported from @dorkos/shared/relay-schemas and re-exported
 * to avoid drift.
 *
 * @module relay/types
 */
import type {
  RelayEnvelope,
  RelayBudget,
  Signal,
  RelayAccessRule,
  RateLimitConfig,
  CircuitBreakerConfig,
  BackpressureConfig,
  ReliabilityConfig,
  TelegramAdapterConfig,
  WebhookAdapterConfig,
  SlackAdapterConfig,
  AdapterConfig,
  AdapterStatus as SharedAdapterStatus,
  BudgetRejectionCode,
} from '@dorkos/shared/relay-schemas';
import type { DeadLetterNotice } from './dead-letter-queue.js';

// --- Re-exported config types — @dorkos/shared is the single source of truth ---

/** Configuration for per-sender sliding window rate limiting. */
export type { RateLimitConfig };

/** Configuration for the per-endpoint circuit breaker. */
export type { CircuitBreakerConfig };

/** Configuration for reactive backpressure load-shedding. */
export type { BackpressureConfig };

/**
 * Composite reliability configuration for the relay pipeline.
 *
 * All three subsystems (rate limiting, circuit breakers, backpressure) are
 * independently configurable. Omitting a subsystem keeps its built-in defaults.
 */
export type { ReliabilityConfig };

/** Configuration for the Telegram Bot API adapter. */
export type { TelegramAdapterConfig };

/** Configuration for the generic webhook adapter. */
export type { WebhookAdapterConfig };

/** Configuration for the Slack adapter. */
export type { SlackAdapterConfig };

/** Persisted configuration for a single adapter instance. */
export type { AdapterConfig };

// --- Core handler and utility types ---

/**
 * What a subscriber may say about a message it was handed.
 *
 * Returning nothing means "I took it" — the overwhelmingly common case, and
 * what every handler written before this said. A handler that looked at the
 * message and did nothing with it should say so instead, because the publish
 * pipeline counts handlers as deliveries: a `BindingRouter` that dropped a
 * chat message for want of a binding still counted as one delivery, and the
 * trace said `delivered` for a turn that never ran.
 */
export interface SubscriberVerdict {
  /** False when this handler deliberately did nothing with the message. */
  handled: false;
  /** Why, in words a person could be shown. */
  reason: string;
}

export type MessageHandler = (
  envelope: RelayEnvelope
) => void | SubscriberVerdict | Promise<void | SubscriberVerdict>;
export type SignalHandler = (subject: string, signal: Signal) => void;
export type Unsubscribe = () => void;

export interface EndpointInfo {
  subject: string;
  /** @deprecated Equals `subject`. Kept for API compatibility — will be renamed to `id` in a future release. */
  hash: string;
  maildirPath: string;
  registeredAt: string;
  /**
   * Relay subject of the principal that registered this endpoint, when the
   * registering caller supplied one.
   *
   * Absent for endpoints the server registers on its own behalf (the system
   * console, Mesh-managed agent endpoints, endpoints created from the cockpit's
   * HTTP route). An absent owner means **nobody** owns the endpoint, never
   * "everybody": callers that gate access on ownership must deny on `undefined`
   * rather than fall through to allow.
   */
  owner?: string;
}

export interface SubscriptionInfo {
  id: string;
  pattern: string;
  createdAt: string;
}

export interface BudgetResult {
  allowed: boolean;
  reason?: string;
  /**
   * Machine code for a rejection, recorded on the trace span so the budget
   * rejection counters are computed from real rows. Absent when allowed.
   */
  code?: BudgetRejectionCode;
  updatedBudget?: RelayBudget;
}

export interface AccessResult {
  allowed: boolean;
  matchedRule?: RelayAccessRule;
  /**
   * Why access was denied, when no rule is responsible for it — today only the
   * unreadable-rules quarantine (see {@link AccessControl}). Surfaced verbatim
   * in the publish error so an operator is told what to repair instead of being
   * told a rule they cannot find denied them.
   */
  reason?: string;
}

/**
 * Decision returned by an {@link InitiateConsentGate}.
 *
 * `allowed:false` carries a machine `code` (surfaced to the caller as the
 * publish rejection reason) and a human `reason` for the dead-letter record.
 */
export interface InitiateConsentDecision {
  allowed: boolean;
  /**
   * Stable code for the denial (used as the publish rejection reason).
   *
   * `MALFORMED_BRIDGE_PRINCIPAL` is distinct from `INITIATE_NOT_ALLOWED` on
   * purpose (DOR-871): it means the `relay.bridge.*` principal itself could
   * not be parsed — an unrecognized or missing classification segment — which
   * is a different failure from a resolved binding refusing consent. A caller
   * building user-facing copy from this code (e.g. the chat-bridge
   * `bridge_blocked` notice) must not describe a parse failure as "this
   * chat's consent settings say no."
   */
  code?: 'INITIATE_NOT_ALLOWED' | 'NO_BINDING' | 'MALFORMED_BRIDGE_PRINCIPAL';
  /** Human-readable reason recorded on the dead letter. */
  reason?: string;
}

/**
 * Authoritative agent→human initiate-consent gate (DOR-277).
 *
 * Injected into the publish pipeline by the host (the relay package itself is
 * binding-unaware). Evaluated on every publish, so the per-binding "agent may
 * start conversations" consent (DOR-239) is enforced at the delivery layer,
 * covering all publish paths — `relay_send*`, A2A, binding-router re-dispatch,
 * and the HTTP publish route — rather than only the two proactive-notify tool
 * handlers. Returns `allowed:true` for paths that are not an agent-initiated
 * send to a human channel (replies, system principals, inbound adapter echoes).
 *
 * The gate keys on `from`, so its guarantee is only as strong as the host's
 * control over that principal. The host is responsible for injecting `from` on
 * trusted surfaces and rejecting client-asserted exempt principals on any
 * surface that accepts a caller-supplied `from` (see the host's consent module).
 *
 * @param from - The publish `from` principal.
 * @param subject - The target subject.
 */
export type InitiateConsentGate = (from: string, subject: string) => InitiateConsentDecision;

export interface DeadLetter {
  envelope: RelayEnvelope;
  reason: string;
  failedAt: string;
  endpointHash: string;
}

export interface RelayMetrics {
  totalMessages: number;
  byStatus: Record<string, number>;
  bySubject: Array<{ subject: string; count: number }>;
}

// --- Rate Limiting ---

/** Result of a per-sender rate limit check. */
export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  /** Current message count in the window (for diagnostics). */
  currentCount?: number;
  /** The configured limit that was checked against. */
  limit?: number;
}

// --- Circuit Breaker ---

/** The three possible states of a per-endpoint circuit breaker. */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** In-memory state for a single endpoint's circuit breaker. */
export interface CircuitBreakerState {
  state: CircuitState;
  /** Number of consecutive delivery failures in the current state. */
  consecutiveFailures: number;
  /** Timestamp (ms) when OPEN state was entered. Null when CLOSED. */
  openedAt: number | null;
  /** Consecutive successful probes in HALF_OPEN state. */
  halfOpenSuccesses: number;
}

/** Result of a per-endpoint circuit breaker check. */
export interface CircuitBreakerResult {
  allowed: boolean;
  reason?: string;
  /** The current circuit state at the time of the check. */
  state: CircuitState;
}

// --- Backpressure ---

/** Result of an endpoint backpressure check. */
export interface BackpressureResult {
  allowed: boolean;
  reason?: string;
  /** Current mailbox depth (messages with status='new'). */
  currentSize: number;
  /** Pressure ratio 0.0–1.0 (currentSize / maxMailboxSize). */
  pressure: number;
}

export interface RelayOptions {
  dataDir?: string;
  /** Drizzle database instance. When provided, SqliteIndex uses this instead of creating its own. */
  db?: import('@dorkos/db').Db;
  maxHops?: number;
  defaultTtlMs?: number;
  defaultCallBudget?: number;
  /** Optional reliability configuration. Omit to use built-in defaults for all subsystems. */
  reliability?: ReliabilityConfig;
  /**
   * Optional trace store for recording delivery spans in the publish pipeline.
   * When provided, each publish() records a span with delivery status and metadata.
   */
  traceStore?: TraceStoreLike;
  /**
   * Optional adapter registry for external channel adapters.
   * Typed as unknown to avoid circular dependency; cast to AdapterRegistry at call sites.
   */
  adapterRegistry?: AdapterRegistryLike;
  /**
   * Optional callback to build AdapterContext before adapter delivery.
   * Called with the subject; returns enriched context (e.g., Mesh agent info) or undefined.
   */
  adapterContextBuilder?: (subject: string) => AdapterContext | undefined;
  /**
   * Optional logger for the relay subsystem.
   * When provided, the publish pipeline logs rate-limit rejections and other diagnostics.
   */
  logger?: RelayLogger;
  /**
   * TTL for dispatch inboxes in milliseconds.
   * Dispatch inboxes older than this are swept automatically.
   * Default: 30 * 60 * 1000 (30 minutes)
   */
  dispatchInboxTtlMs?: number;
  /**
   * Interval between TTL sweep runs in milliseconds.
   * Default: 5 * 60 * 1000 (5 minutes)
   */
  ttlSweepIntervalMs?: number;
  /**
   * Interval between storage GC sweeps in milliseconds (expiry, dead-letter
   * retention, crash recovery, orphan reaping).
   * Default: 5 * 60 * 1000 (5 minutes)
   */
  gcIntervalMs?: number;
  /**
   * Retention window for dead letters in milliseconds. Dead letters older than
   * this are purged by the GC sweep.
   * Default: 24 * 60 * 60 * 1000 (24 hours)
   */
  deadLetterRetentionMs?: number;
  /**
   * Minimum age (ms) before a mailbox directory with no registered endpoint is
   * reaped. Acts as a safety margin against deleting a directory an in-flight
   * registration just created. Durable `relay.inbox.*` persistent inboxes are
   * never reaped regardless of this window.
   * Default: 24 * 60 * 60 * 1000 (24 hours)
   */
  orphanMaildirRetentionMs?: number;
  /**
   * Time since CLAIM (ms) after which a message in `cur/` is treated as
   * crash-stranded and re-driven to `new/` for redelivery. Measured from the
   * `cur/` file's ctime (stamped by the claim rename), never the envelope's
   * `createdAt`. Must stay well above the longest plausible handler duration —
   * re-driving an actively-processing message double-delivers it.
   * Default: 30 * 60 * 1000 (30 minutes)
   */
  inFlightRecoveryMs?: number;
  /**
   * How long unread mail in a durable `relay.inbox.*` inbox is kept, measured
   * from when it was written and INDEPENDENT of the message's own delivery
   * budget. When it is finally reached, the message is dead-lettered rather
   * than deleted, so it stays readable.
   * Default: 7 * 24 * 60 * 60 * 1000 (7 days)
   */
  undeliveredMailRetentionMs?: number;

  /**
   * Optional observer invoked at the moment a message is dead-lettered (the
   * arrival edge, never a poll). The DorkOS server wires this to the `/api/events`
   * SSE fan-out so the Pulse attention badge ticks instantly when a message
   * bounces (DOR-403). See {@link DeadLetterQueueOptions.onDeadLetter}.
   */
  onDeadLetter?: (notice: DeadLetterNotice) => void;
}

export interface PublishOptions {
  from: string;
  replyTo?: string;
  budget?: Partial<RelayBudget>;
  /**
   * The dispatch this publish belongs to, when the caller knows it.
   *
   * Stamped onto the envelope so the next hop inherits it, and used as the
   * `traceId` of the recorded span so all hops of one dispatch join into one
   * trace. Omitted, the span keeps its historical `traceId === messageId` and
   * the trace is a single row, exactly as before.
   */
  dispatchId?: string;
  /**
   * The publisher's assertion that it is trusted server code legitimately
   * publishing under a `relay.bridge.*` delivery principal (DOR-889).
   *
   * A `from` string reaching the publish pipeline carries no provenance, so the
   * pipeline cannot tell a trusted server-constructed bridge publish apart from
   * an untrusted, caller-supplied `from` that happens to spell one. This marker
   * is that provenance: it is an in-process argument, never a wire field, so
   * only code that calls `publish` directly can set it. The pipeline **rejects
   * any `relay.bridge.*` `from` that arrives without it** (see
   * `RelayPublishPipeline.publish`), making the server-only property hold for
   * every ingress by construction rather than relying on each HTTP route to
   * guard its own `from`.
   *
   * Set by exactly the three legitimate bridge publishers — chat-bridge
   * `deliver`, the task-completion notifier, and the `relay_notify_user` tool —
   * and by nothing else. It is inert on any non-bridge `from`, so setting it is
   * harmless but pointless outside those callers; the HTTP publish route never
   * sets it, which is what keeps a client-supplied bridge `from` unpublishable.
   */
  serverBridgePrincipal?: boolean;
}

// === Adapter Logger ===

/**
 * Minimal logger interface for relay adapters.
 *
 * Compatible with consola's tagged logger, Node's console, and custom
 * implementations. The relay package uses this instead of importing
 * the server logger directly to stay standalone.
 */
export interface RelayLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const noop = () => {};

/** Silent logger — used when no logger is injected. */
export const noopLogger: RelayLogger = { debug: noop, info: noop, warn: noop, error: noop };

// === Adapter Callbacks ===

/** Callbacks for inbound message handling (used by adapter sub-modules). */
export interface AdapterInboundCallbacks {
  trackInbound: () => void;
  recordError: (err: unknown) => void;
}

/** Callbacks for outbound message delivery (used by adapter sub-modules). */
export interface AdapterOutboundCallbacks {
  trackOutbound: () => void;
  recordError: (err: unknown) => void;
}

// === External Adapters ===

/**
 * Result of a publish operation.
 *
 * Defined here (not relay-publish.ts) so adapter interfaces can reference it
 * without introducing a circular import through relay-core.ts.
 */
export interface PublishResult {
  /** The ULID message ID assigned to the published envelope. */
  messageId: string;

  /** Number of endpoints the message was delivered to. */
  deliveredTo: number;

  /** Endpoints that rejected the message, with structured reasons. */
  rejected?: Array<{
    endpointHash: string;
    reason:
      | 'backpressure'
      | 'circuit_open'
      | 'rate_limited'
      | 'budget_exceeded'
      | 'initiate_denied'
      // DOR-889: a `relay.bridge.*` `from` reached the pipeline without the
      // `serverBridgePrincipal` trust marker — a caller-supplied bridge
      // principal that slipped past or around the HTTP route guard. Rejected
      // before the consent gate and any delivery.
      | 'untrusted_bridge_principal';
  }>;

  /** Per-endpoint pressure ratios for proactive signaling (0.0-1.0). */
  mailboxPressure?: Record<string, number>;

  /** Result from adapter delivery, if attempted. */
  adapterResult?: DeliveryResult;
}

/**
 * Minimal interface for adapter → relay communication.
 *
 * RelayCore implements this interface.
 */
export interface RelayPublisher {
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<PublishResult>;
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe;
  /**
   * Subscribe to messages matching a subject pattern.
   *
   * Uses NATS-style wildcards: `*` for single token, `>` for multi-token suffix.
   * Returns an unsubscribe function.
   *
   * @param pattern - Subject pattern to match (e.g., 'relay.system.approval.>')
   * @param handler - Callback invoked for each matching message
   */
  subscribe(pattern: string, handler: MessageHandler): Unsubscribe;
}

/**
 * Minimal trace store contract for delivery span recording.
 *
 * Used by RelayCore (insertSpan only) and ClaudeCodeAdapter (both methods).
 * Accepts loose span shapes via index signatures to allow adapter-specific fields.
 */
export interface TraceStoreLike {
  insertSpan(span: {
    messageId: string;
    traceId: string;
    subject: string;
    status?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  }): void;
  updateSpan(
    messageId: string,
    update: {
      status?: string;
      deliveredAt?: string | number | null;
      processedAt?: string | number | null;
      error?: string | null;
      [key: string]: unknown;
    }
  ): void;
}

/**
 * Minimal interface for AdapterRegistry used in RelayOptions.
 *
 * Avoids circular dependency between types.ts and adapter-registry.ts.
 */
export interface AdapterRegistryLike {
  setRelay(relay: RelayPublisher): void;
  deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult | null>;
  /**
   * Find the adapter whose subjectPrefix matches the given subject, if any.
   *
   * Optional so lightweight registry shims stay minimal. When present,
   * detached `relay.agent.*` delivery consults it BEFORE acknowledging
   * acceptance — a no-match returns `null` synchronously so publish() falls
   * back to the pending-buffer / dead-letter pipeline instead of counting a
   * phantom delivery.
   */
  getBySubject?(subject: string): RelayAdapter | undefined;
  shutdown(): Promise<void>;
}

/**
 * Plugin interface for external channel adapters.
 *
 * Each adapter bridges an external communication channel (Telegram, webhooks, etc.)
 * into the Relay subject hierarchy.
 */
export interface RelayAdapter {
  /** Unique identifier (e.g., 'telegram', 'webhook-github') */
  readonly id: string;

  /** Subject prefix(es) this adapter handles (e.g., 'relay.human.telegram' or ['relay.agent.', 'relay.system.tasks.']) */
  readonly subjectPrefix: string | readonly string[];

  /** Human-readable display name */
  readonly displayName: string;

  /**
   * Start the adapter — connect to external service, register Relay endpoints.
   *
   * Called by AdapterRegistry on startup or hot-reload.
   * Must be idempotent (safe to call if already started).
   *
   * @param relay - The RelayPublisher to publish inbound messages to
   */
  start(relay: RelayPublisher): Promise<void>;

  /**
   * Stop the adapter — disconnect from external service, unregister endpoints.
   *
   * Must drain in-flight messages before resolving.
   * Must be idempotent (safe to call if already stopped).
   */
  stop(): Promise<void>;

  /**
   * Deliver a Relay message to the external channel.
   *
   * Called by RelayCore when a published message matches this adapter's subjectPrefix.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional rich context for informed dispatch decisions
   */
  deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult>;

  /** Current adapter status */
  getStatus(): AdapterStatus;

  /**
   * Lightweight connection test — validate credentials without starting the
   * full adapter lifecycle (e.g., long-polling loops, webhook servers).
   *
   * When present, `AdapterManager.testConnection()` prefers this over the
   * heavier `start()`/`stop()` cycle, avoiding side-effects like Telegram's
   * 409 Conflict when a polling session lingers.
   */
  testConnection?(): Promise<{ ok: boolean; error?: string; botUsername?: string }>;
}

/**
 * Low-level platform communication interface.
 *
 * Abstracts the mechanics of sending/editing/streaming messages on a
 * specific platform (Telegram, Slack, etc.) from the relay adapter's
 * orchestration concerns (subject routing, envelope handling, status).
 *
 * A RelayAdapter owns a PlatformClient and delegates platform API calls
 * to it. The PlatformClient never touches RelayEnvelopes or subjects —
 * it operates on thread IDs and content strings.
 */
export interface PlatformClient {
  /** Human-readable platform name for logging and diagnostics. */
  readonly platform: string;

  /**
   * Post a new message to a thread.
   *
   * @param threadId - Platform-specific thread or chat identifier
   * @param content - Message body text
   * @param format - Optional content format hint (e.g., 'markdown', 'html')
   * @returns The platform-assigned message ID
   */
  postMessage(threadId: string, content: string, format?: string): Promise<{ messageId: string }>;

  /**
   * Edit an existing message in place.
   *
   * @param threadId - Platform-specific thread or chat identifier
   * @param messageId - ID of the message to edit
   * @param content - Replacement message body text
   */
  editMessage(threadId: string, messageId: string, content: string): Promise<void>;

  /**
   * Delete a message from the thread.
   *
   * @param threadId - Platform-specific thread or chat identifier
   * @param messageId - ID of the message to delete
   */
  deleteMessage(threadId: string, messageId: string): Promise<void>;

  /**
   * Wire up inbound message handling from the platform.
   *
   * Called once during adapter start. The client should forward all
   * inbound platform messages to the relay via `relay.publish()`.
   *
   * @param relay - The RelayPublisher to publish inbound messages to
   */
  handleInbound(relay: RelayPublisher): void;

  /**
   * Post an interactive action prompt with selectable options.
   *
   * Optional — platforms that support inline keyboards or action buttons
   * (e.g., Telegram inline keyboards, Slack Block Kit buttons) implement this.
   *
   * @param threadId - Platform-specific thread or chat identifier
   * @param prompt - Prompt text displayed above the action buttons
   * @param actions - Ordered list of label/value pairs for each action button
   * @returns The platform-assigned message ID
   */
  postAction?(
    threadId: string,
    prompt: string,
    actions: Array<{ label: string; value: string }>
  ): Promise<{ messageId: string }>;

  /**
   * Tear down the platform client — close connections and release resources.
   *
   * Must drain any in-flight requests before resolving.
   */
  destroy(): Promise<void>;
}

/**
 * Current status of an external channel adapter.
 *
 * A subset of the full {@link SharedAdapterStatus} from `@dorkos/shared/relay-schemas`.
 * Omits server-enriched fields (`id`, `type`, `displayName`) that are added by the
 * adapter manager when building catalog entries — relay adapters only track runtime state.
 */
export type AdapterStatus = Pick<
  SharedAdapterStatus,
  'state' | 'messageCount' | 'errorCount' | 'lastError' | 'lastErrorAt' | 'startedAt'
> & {
  /** Number of agents with queued messages waiting to be delivered. */
  queuedMessages?: number;
};

/**
 * Rich context passed to adapter deliver() for informed dispatch decisions.
 *
 * Contains optional agent info (from Mesh registry or envelope metadata),
 * optional platform info (for external adapters), and trace context.
 */
export interface AdapterContext {
  /** Agent info — populated from Mesh registry, envelope metadata, or static config */
  agent?: {
    /** Working directory for the agent (absolute path) */
    directory: string;
    /** Runtime type (e.g., 'claude-code', 'codex', 'open-code') */
    runtime: string;
    /** Agent manifest from Mesh registry (if available) */
    manifest?: Record<string, unknown>;
  };
  /** Platform info — for external adapters */
  platform?: {
    /** Platform name (e.g., 'telegram', 'slack', 'discord') */
    name: string;
    /** Platform-specific metadata */
    metadata?: Record<string, unknown>;
  };
  /** Trace context for delivery tracking */
  trace?: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
  /**
   * Set by the delivery pipeline on deliveries whose reply goes to **a person
   * in a bridged chat**, and on nothing else. It carries two things at once,
   * and both matter:
   *
   * 1. **Its presence is the adapter's licence to wait for capacity.** Every
   *    other delivery must be answered now. A Tasks dispatch or control message
   *    is awaited by the pipeline itself; `relay_send_and_wait` and the A2A
   *    executor are detached but block on a reply inbox with their own, shorter
   *    deadlines. Parking either kind turns a fast, actionable "at capacity"
   *    into a timeout, and leaves a turn running for a reader who has already
   *    given up. The pipeline is the only thing that can tell these apart, so
   *    an adapter that keys on this field cannot get it wrong.
   * 2. **Calling it announces the wait**, once the wait has lasted long enough
   *    to be worth mentioning. The adapter knows a message is waiting; only the
   *    pipeline knows where the person who wrote it is reading.
   *
   * Together they are what turns a busy runtime into "your message is waiting"
   * instead of the refusal that used to ask people to send it again (ADR
   * `260819-034718`). Called at most once per delivery, never for a hold that
   * clears quickly, and implementations must neither throw nor block.
   */
  onHeld?: () => void;
}

/**
 * Result of an adapter delivery attempt.
 *
 * Adapters return this from deliver() to indicate success, failure, or
 * dead-letter disposition.
 */
export interface DeliveryResult {
  success: boolean;
  /**
   * True when the adapter deliberately sent nothing — an echo of a message it
   * published itself, or a stream event it does not render. Not a failure, and
   * not a delivery: the publish pipeline counts it as neither, so a chat with
   * nothing bound behind it stops reporting messages as delivered.
   */
  skipped?: boolean;
  /** Error message if delivery failed */
  error?: string;
  /**
   * Machine code for a failure, when the adapter has one.
   *
   * Read in preference to the message text, so a surface that reacts to a
   * specific failure does not depend on the exact wording of somebody's error
   * string. The chats-as-channels delivery ladder (spec §10) branches on this:
   * `chat_unavailable` is terminal (the bot was blocked, kicked, or the chat was
   * deleted — a 403, §10.3), and `rate_limited` carries {@link DeliveryResult.retryAfterMs}
   * for the honour-`retry_after` path (§10.2). A failure with no code is treated
   * as transient (platform down / adapter disconnected, §10.1).
   */
  code?: 'at_capacity' | 'chat_unavailable' | 'rate_limited';
  /**
   * How long to wait before retrying, in milliseconds, when the platform asked
   * for it (a Telegram 429's `retry_after`). Set only alongside
   * `code: 'rate_limited'` (chats-as-channels spec §10.2).
   */
  retryAfterMs?: number;
  /** Whether a dead letter was created for this failure */
  deadLettered?: boolean;
  /** Response message ID if the adapter published a reply */
  responseMessageId?: string;
  /** Delivery duration in milliseconds */
  durationMs?: number;
}

/** Categorization of a Relay endpoint by subject prefix. */
export type EndpointType = 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown';

/**
 * Derive the logical type of a Relay endpoint from its subject prefix.
 *
 * Mirrors the prefix-matching convention used in ClaudeCodeAdapter and
 * throughout the subject hierarchy. Zero schema change — type is never stored.
 *
 * @param subject - The endpoint's full subject string
 */
export function inferEndpointType(subject: string): EndpointType {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.')) return 'query';
  if (subject.startsWith('relay.inbox.')) return 'persistent';
  if (subject.startsWith('relay.agent.')) return 'agent';
  return 'unknown';
}
