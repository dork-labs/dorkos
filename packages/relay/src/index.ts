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

// API versioning
export { RELAY_ADAPTER_API_VERSION } from './version.js';

// Sub-modules (for advanced usage)
export { EndpointRegistry } from './endpoint-registry.js';
export { SubscriptionRegistry } from './subscription-registry.js';
export { MaildirStore } from './maildir-store.js';
export type {
  MaildirStoreOptions,
  DeliverResult,
  ClaimResult,
  FailResult,
} from './maildir-store.js';

export { SqliteIndex } from './sqlite-index.js';
export type { SqliteIndexOptions, IndexedMessage, MessageStatus } from './sqlite-index.js';

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

// Endpoint type inference
export { inferEndpointType } from './types.js';
export type { EndpointType } from './types.js';

// Adapter types
export type {
  RelayPublisher,
  RelayAdapter,
  RelayLogger,
  AdapterStatus,
  AdapterConfig,
  AdapterContext,
  DeliveryResult,
  TelegramAdapterConfig,
  WebhookAdapterConfig,
  SlackAdapterConfig,
  AdapterRegistryLike,
  PublishResult,
  AdapterInboundCallbacks,
  AdapterOutboundCallbacks,
  PlatformClient,
  StreamableAdapter,
} from './types.js';

export { noopLogger } from './types.js';

// Base class (optional convenience for adapter authors)
export { BaseRelayAdapter } from './base-adapter.js';

// Runtime adapter base — shared by agent-runtime adapters (Claude Code, Codex, TestMode).
// See packages/relay/src/adapters/runtime-adapter.ts for the abstract contract.
export {
  RuntimeAdapter,
  DEFAULT_RETRY_POLICY,
  type RuntimeAdapterContext,
  type RuntimeInboundMessage,
  type RuntimeOutboundEvent,
  type RuntimeSessionHandle,
  type RetryPolicy,
  type StreamMessageResult,
} from './adapters/runtime-adapter.js';

// Test-mode runtime adapter — permanent CI integration fixture proving that
// the RuntimeAdapter base is runtime-agnostic. See ADR 0257.
export { TestModeAdapter, type TestModeAdapterOptions } from './adapters/test-mode/index.js';

// Adapter registry
export { AdapterRegistry } from './adapter-registry.js';

// Adapter implementations
export { TelegramAdapter, TELEGRAM_MANIFEST } from './adapters/telegram/index.js';
export { WebhookAdapter, verifySignature, WEBHOOK_MANIFEST } from './adapters/webhook/index.js';
export { SlackAdapter, SLACK_MANIFEST } from './adapters/slack/index.js';

// Built-in adapters
export { ClaudeCodeAdapter, CLAUDE_CODE_MANIFEST } from './adapters/claude-code/index.js';
export {
  ChatSdkTelegramAdapter,
  TELEGRAM_CHATSDK_MANIFEST,
} from './adapters/telegram-chatsdk/index.js';
export type { ChatSdkTelegramAdapterConfig } from './adapters/telegram-chatsdk/index.js';
export type {
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  AgentRuntimeLike,
  AgentRuntimeLike as ClaudeCodeAgentRuntimeLike,
  AgentSessionStoreLike,
  TraceStoreLike,
  TasksStoreLike,
} from './adapters/claude-code/index.js';

// Payload utilities
export {
  formatForPlatform,
  extractAgentIdFromEnvelope,
  extractSessionIdFromEnvelope,
  splitMessage,
  TELEGRAM_MAX_LENGTH,
  SLACK_MAX_LENGTH,
} from './lib/payload-utils.js';

// Thread ID codecs
export type { ThreadIdCodec } from './lib/thread-id.js';
export {
  TelegramThreadIdCodec,
  SlackThreadIdCodec,
  ChatSdkTelegramThreadIdCodec,
} from './lib/thread-id.js';

// Agent subject parser — tolerates both legacy (`relay.agent.<sessionId>`) and
// runtime-scoped (`relay.agent.<runtimeType>.<sessionId>`) subject shapes.
export {
  parseAgentSubject,
  extractSessionIdFromSubject,
  isUuid,
  type ParsedAgentSubject,
} from './lib/subject-parser.js';

// Async primitives
export { AsyncQueue } from './lib/async-queue.js';

// Stream aggregation
export { AdapterStreamManager } from './adapter-stream-manager.js';

// Plugin loader
export { loadAdapters, validateAdapterShape } from './adapter-plugin-loader.js';
export type {
  PluginAdapterConfig,
  AdapterPluginModule,
  LoadedAdapter,
} from './adapter-plugin-loader.js';
