/**
 * @dorkos/relay -- Foundational message bus for DorkOS.
 *
 * Provides NATS-style subject matching, Maildir-based persistence,
 * SQLite indexing, budget envelope enforcement, ephemeral signals,
 * and pattern-based access control.
 *
 * @module relay
 */

// Main entry point
export { RelayCore } from './relay-core.js';
export type { PublishResult } from './relay-core.js';

// Sub-modules (for advanced usage)
export { EndpointRegistry, hashSubject } from './endpoint-registry.js';
export { SubscriptionRegistry } from './subscription-registry.js';
export { MaildirStore } from './maildir-store.js';
export type {
  MaildirStoreOptions,
  DeliverResult,
  ClaimResult,
  FailResult,
} from './maildir-store.js';

export { SqliteIndex } from './sqlite-index.js';
export type {
  SqliteIndexOptions,
  IndexedMessage,
  MessageStatus,
} from './sqlite-index.js';

export { DeadLetterQueue } from './dead-letter-queue.js';
export type {
  DeadLetterQueueOptions,
  RejectResult,
  DeadLetterEntry,
  ListDeadOptions,
  PurgeOptions,
  PurgeResult,
} from './dead-letter-queue.js';

export { AccessControl } from './access-control.js';
export { SignalEmitter } from './signal-emitter.js';

// Pure functions
export { validateSubject, matchesPattern } from './subject-matcher.js';
export type { SubjectValidationResult, SubjectValidationError } from './subject-matcher.js';
export { enforceBudget, createDefaultBudget } from './budget-enforcer.js';

// Reliability modules
export { checkRateLimit, resolveLimit, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
export { CircuitBreakerManager, DEFAULT_CB_CONFIG } from './circuit-breaker.js';
export { checkBackpressure, DEFAULT_BP_CONFIG } from './backpressure.js';

// Types
export type {
  MessageHandler,
  SignalHandler,
  Unsubscribe,
  EndpointInfo,
  SubscriptionInfo,
  BudgetResult,
  AccessResult,
  DeadLetter,
  RelayMetrics,
  RelayOptions,
  PublishOptions,
} from './types.js';

// Reliability types
export type {
  RateLimitResult,
  RateLimitConfig,
  CircuitState,
  CircuitBreakerState,
  CircuitBreakerResult,
  CircuitBreakerConfig,
  BackpressureResult,
  BackpressureConfig,
  ReliabilityConfig,
} from './types.js';

// Adapter types
export type {
  RelayPublisher,
  RelayAdapter,
  AdapterStatus,
  AdapterConfig,
  AdapterContext,
  DeliveryResult,
  TelegramAdapterConfig,
  WebhookAdapterConfig,
  AdapterRegistryLike,
  PublishResultLike,
} from './types.js';

// Adapter registry
export { AdapterRegistry } from './adapter-registry.js';

// Adapter implementations
export { TelegramAdapter, TELEGRAM_MANIFEST } from './adapters/telegram-adapter.js';
export { WebhookAdapter, verifySignature, WEBHOOK_MANIFEST } from './adapters/webhook-adapter.js';

// Built-in adapters
export { ClaudeCodeAdapter, CLAUDE_CODE_MANIFEST } from './adapters/claude-code-adapter.js';
export type {
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  AgentManagerLike as ClaudeCodeAgentManagerLike,
  TraceStoreLike,
  PulseStoreLike,
} from './adapters/claude-code-adapter.js';

// Plugin loader
export { loadAdapters, validateAdapterShape } from './adapter-plugin-loader.js';
export type {
  PluginAdapterConfig,
  AdapterPluginModule,
  LoadedAdapter,
} from './adapter-plugin-loader.js';
