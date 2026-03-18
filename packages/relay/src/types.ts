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
} from '@dorkos/shared/relay-schemas';

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

export type MessageHandler = (envelope: RelayEnvelope) => void | Promise<void>;
export type SignalHandler = (subject: string, signal: Signal) => void;
export type Unsubscribe = () => void;

export interface EndpointInfo {
  subject: string;
  hash: string;
  maildirPath: string;
  registeredAt: string;
}

export interface SubscriptionInfo {
  id: string;
  pattern: string;
  createdAt: string;
}

export interface BudgetResult {
  allowed: boolean;
  reason?: string;
  updatedBudget?: RelayBudget;
}

export interface AccessResult {
  allowed: boolean;
  matchedRule?: RelayAccessRule;
}

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
}

export interface PublishOptions {
  from: string;
  replyTo?: string;
  budget?: Partial<RelayBudget>;
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
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
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
  updateSpan(messageId: string, update: {
    status?: string;
    deliveredAt?: string | number | null;
    processedAt?: string | number | null;
    error?: string | null;
    [key: string]: unknown;
  }): void;
}

/**
 * Minimal interface for AdapterRegistry used in RelayOptions.
 *
 * Avoids circular dependency between types.ts and adapter-registry.ts.
 */
export interface AdapterRegistryLike {
  setRelay(relay: RelayPublisher): void;
  deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult | null>;
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

  /** Subject prefix(es) this adapter handles (e.g., 'relay.human.telegram' or ['relay.agent.', 'relay.system.pulse.']) */
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
  deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult>;

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
}

/**
 * Result of an adapter delivery attempt.
 *
 * Adapters return this from deliver() to indicate success, failure, or
 * dead-letter disposition.
 */
export interface DeliveryResult {
  success: boolean;
  /** Error message if delivery failed */
  error?: string;
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
  if (subject.startsWith('relay.inbox.query.'))    return 'query';
  if (subject.startsWith('relay.inbox.'))           return 'persistent';
  if (subject.startsWith('relay.agent.'))           return 'agent';
  return 'unknown';
}
