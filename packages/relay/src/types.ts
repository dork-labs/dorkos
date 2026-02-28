/**
 * Internal type definitions for the @dorkos/relay package.
 *
 * All types used across relay modules are defined here to avoid
 * circular imports and provide a single source of truth.
 *
 * @module relay/types
 */
import type { RelayEnvelope, RelayBudget, Signal, RelayAccessRule } from '@dorkos/shared/relay-schemas';

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

/** Configuration for per-sender sliding window rate limiting. */
export interface RateLimitConfig {
  enabled: boolean;
  /** Sliding window duration in seconds. Default: 60 */
  windowSecs: number;
  /** Maximum messages per sender per window. Default: 100 */
  maxPerWindow: number;
  /** Subject prefix to limit override for specific senders. */
  perSenderOverrides?: Record<string, number>;
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

/** Configuration for the per-endpoint circuit breaker. */
export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Consecutive failures to trip the breaker. Default: 5 */
  failureThreshold: number;
  /** Milliseconds before OPEN to HALF_OPEN transition. Default: 30000 */
  cooldownMs: number;
  /** Probe messages allowed in HALF_OPEN before re-evaluating. Default: 1 */
  halfOpenProbeCount: number;
  /** Consecutive successes required to close from HALF_OPEN. Default: 2 */
  successToClose: number;
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

/** Configuration for reactive backpressure load-shedding. */
export interface BackpressureConfig {
  enabled: boolean;
  /** Maximum unprocessed messages before hard rejection. Default: 1000 */
  maxMailboxSize: number;
  /** Pressure ratio (0–1) at which to emit a warning signal. Default: 0.8 */
  pressureWarningAt: number;
}

// --- Composite Reliability Config ---

/**
 * Composite reliability configuration for the relay pipeline.
 *
 * All three subsystems (rate limiting, circuit breakers, backpressure) are
 * independently configurable. Omitting a subsystem keeps its built-in defaults.
 */
export interface ReliabilityConfig {
  rateLimit?: Partial<RateLimitConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  backpressure?: Partial<BackpressureConfig>;
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
}

export interface PublishOptions {
  from: string;
  replyTo?: string;
  budget?: Partial<RelayBudget>;
}

// === External Adapters ===

/**
 * Minimal publish result shape for adapter → relay communication.
 *
 * Mirrors PublishResult from relay-core.ts without creating a circular import.
 */
export interface PublishResultLike {
  messageId: string;
  deliveredTo: number;
  rejected?: Array<{
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  }>;
  mailboxPressure?: Record<string, number>;
  /** Result from adapter delivery, if attempted. */
  adapterResult?: DeliveryResult;
}

/**
 * Minimal interface for adapter → relay communication.
 *
 * Avoids circular dependency between types.ts and relay-core.ts.
 * RelayCore implements this interface.
 */
export interface RelayPublisher {
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<PublishResultLike>;
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe;
}

/** Minimal trace store contract for RelayCore to record delivery spans. */
export interface TraceStoreLike {
  insertSpan(span: {
    messageId: string;
    traceId: string;
    subject: string;
    status?: string;
    metadata?: Record<string, unknown>;
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
  testConnection?(): Promise<{ ok: boolean; error?: string }>;
}

/** Current status of an external channel adapter. */
export interface AdapterStatus {
  state: 'connected' | 'disconnected' | 'error' | 'starting' | 'stopping';
  messageCount: { inbound: number; outbound: number };
  errorCount: number;
  lastError?: string;
  lastErrorAt?: string;
  startedAt?: string;
}

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

/** Persisted configuration for a single adapter instance. */
export interface AdapterConfig {
  id: string;
  type: 'telegram' | 'webhook' | 'claude-code' | 'plugin';
  enabled: boolean;
  /** Built-in adapter flag — when true, adapter is loaded from @dorkos/relay */
  builtin?: boolean;
  /** Plugin source — required when type is 'plugin' */
  plugin?: { package?: string; path?: string };
  config: TelegramAdapterConfig | WebhookAdapterConfig | Record<string, unknown>;
}

/** Configuration for the Telegram Bot API adapter. */
export interface TelegramAdapterConfig {
  token: string;
  mode: 'polling' | 'webhook';
  webhookUrl?: string;
  webhookPort?: number;
  /** Secret token for validating incoming webhook requests from Telegram. Auto-generated if omitted. */
  webhookSecret?: string;
}

/** Configuration for the generic webhook adapter. */
export interface WebhookAdapterConfig {
  /** Inbound webhook configuration */
  inbound: {
    /** Subject to publish inbound messages to */
    subject: string;
    /** HMAC-SHA256 secret for signature verification */
    secret: string;
    /** Previous secret for rotation (optional, 24h transition window) */
    previousSecret?: string;
  };
  /** Outbound delivery configuration */
  outbound: {
    /** URL to POST messages to */
    url: string;
    /** HMAC-SHA256 secret for signing outbound requests */
    secret: string;
    /** Custom headers to include */
    headers?: Record<string, string>;
  };
}
