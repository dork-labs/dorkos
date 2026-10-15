import type * as CoreTypes from './relay-core-types.js';
import {
  createOriginalServerDocumentOrigin,
  type OriginalDocumentOriginContext,
} from './relay-core-document-origin.js';
import {
  loadOriginalRelayReliability,
  startOriginalRelayConfigWatcher,
  runOriginalRelayTtlSweep,
  drainOriginalRelayBacklog,
  runOriginalRelayGcSweep,
  type OriginalRelayMaintenanceContext,
} from './relay-core-maintenance.js';
/**
 * Main entry point for the Relay message bus.
 *
 * Thin facade composing publish, subscription, and endpoint management
 * sub-modules into a single cohesive API surface.
 *
 * @module relay/relay-core
 */
import * as path from 'node:path';
import * as os from 'node:os';
import fs from 'node:fs';
import { RelayDatabase } from './lib/relay-database.js';
import { EndpointRegistry } from './endpoint-registry.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import { MaildirStore } from './maildir-store.js';
import { isDetachedAgentSubject } from './lib/detached-agent-subject.js';
import { SqliteIndex } from './sqlite-index.js';
import { DeadLetterQueue } from './dead-letter-queue.js';
import { AccessControl } from './access-control.js';
import { SignalEmitter } from './signal-emitter.js';
import { DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
import { CircuitBreakerManager } from './circuit-breaker.js';
import { DEFAULT_BP_CONFIG } from './backpressure.js';
import { DeliveryPipeline } from './delivery-pipeline.js';
import { AdapterDelivery } from './adapter-delivery.js';
import { WatcherManager } from './watcher-manager.js';
import {
  RelayGc,
  DEFAULT_GC_INTERVAL_MS,
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  DEFAULT_ORPHAN_MAILDIR_RETENTION_MS,
  DEFAULT_IN_FLIGHT_RECOVERY_MS,
  DEFAULT_UNDELIVERED_MAIL_RETENTION_MS,
} from './relay-gc.js';
import { createReplyFailureNotifier } from './reply-failure-notifier.js';
import { createChatNoticeSender } from './chat-notice.js';
import { RelayPublishPipeline, createOriginalDocumentPublishPipeline } from './relay-publish.js';
import { RelayTurnCeiling } from './turn-ceiling.js';
import { executeSubscribe, executeSignal, executeOnSignal } from './relay-subscriptions.js';
import {
  executeRegisterEndpoint,
  executeUnregisterEndpoint,
  executeListEndpoints,
  executeGetEndpoint,
  executeGetMessage,
  executeGetMessageDetail,
  executeListMessages,
  executeReadInbox,
  executeGetDeadLetters,
  executeAddAccessRule,
  executeRemoveAccessRule,
  executeListAccessRules,
  executeRebuildIndex,
  executeGetMetrics,
} from './relay-endpoint-management.js';
import { isDocumentSubject, type Signal, type RelayAccessRule } from '@dorkos/shared/relay-schemas';
import { noopLogger } from './types.js';

// Re-export public types from sub-modules
export type { PublishResult } from './relay-publish.js';
export type {
  InboxMessage,
  MessageDetail,
  ReadInboxOptions,
  RegisterEndpointOptions,
} from './relay-endpoint-management.js';

type OriginalRelayCoreContext = OriginalDocumentOriginContext & OriginalRelayMaintenanceContext;
const relayCoreOwners = new WeakMap<object, OriginalRelayCoreContext>();
const relayCoreOwnerGet = WeakMap.prototype.get,
  relayCoreOwnerSet = WeakMap.prototype.set,
  relayCoreOwnerApply = Reflect.apply;
/** Exact constructor-owned key lookup, with no exported issuer or registry. */
export function requireOriginalRelayCoreOwner(key: object): OriginalRelayCoreContext {
  const context = relayCoreOwnerApply(relayCoreOwnerGet, relayCoreOwners, [key]) as
    OriginalRelayCoreContext | undefined;
  if (!context) throw new Error('Original RelayCore owner required');
  return context;
}
// === Constants ===

/**
 * Default data directory for Relay state (standalone/test fallback).
 *
 * When used via the DorkOS server, the server always passes `dataDir` explicitly
 * via constructor options (see `apps/server/src/index.ts`), so this constant is
 * only reached in standalone or test usage.
 */
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dork', 'relay');
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_MAX_HOPS = 5;
const DEFAULT_CALL_BUDGET = 10;

// Only the actual fresh-bus constructor below can register an origin. No mint/checker
// callback or existing-bus attachment seam is exported, even from an internal module.
const documentOrigins = new WeakMap<object, CoreTypes.ServerDocumentRelayAccess>();
const originalAccessCheck = AccessControl.prototype.checkAccess;
const originalDocumentSubscribe = SubscriptionRegistry.prototype.subscribe;

/** Consume the actual new bus binding once; no second source may replace its owner. */
export function consumeServerDocumentRelayOrigin(
  origin: CoreTypes.ServerDocumentRelayOrigin
): CoreTypes.ServerDocumentRelayAccess {
  const access = documentOrigins.get(origin);
  if (!access) throw new Error('DOCUMENT_RELAY_ORIGIN_REQUIRED');
  // Retire even when closed: failure cannot enable a second assembly.
  documentOrigins.delete(origin);
  access.requireOpen();
  return access;
}

// === RelayCore ===

/**
 * Unified entry point for the Relay message bus.
 *
 * Composes all Relay sub-modules and provides a high-level API for
 * publishing messages, subscribing to patterns, emitting signals,
 * managing endpoints, and querying dead letters.
 *
 * @example
 * ```ts
 * const relay = new RelayCore({ dataDir: '/tmp/relay-test' });
 *
 * // Register an endpoint and subscribe
 * await relay.registerEndpoint('relay.agent.backend');
 * const unsub = relay.subscribe('relay.agent.>', (envelope) => {
 *   console.log('Received:', envelope.subject);
 * });
 *
 * // Publish a message
 * const result = await relay.publish('relay.agent.backend', { hello: 'world' }, {
 *   from: 'relay.agent.frontend',
 * });
 *
 * // Graceful shutdown
 * await relay.close();
 * ```
 */
export class RelayCore {
  /** Construct a fresh server bus and its single source-assembly origin together. */
  static createServerDocumentRelay(options: CoreTypes.RelayOptions): CoreTypes.ServerDocumentRelay {
    const relay = new RelayCore(options);
    return createOriginalServerDocumentOrigin(relay.#ownerKey);
  }
  readonly #ownerKey = {};

  readonly #publishDocumentWake: CoreTypes.PublishDocumentWake;
  private readonly publishPipeline: RelayPublishPipeline;
  private readonly subscriptionDeps: CoreTypes.SubscriptionDeps;
  private readonly endpointDeps: CoreTypes.EndpointManagementDeps;
  private readonly subscriptionRegistry: SubscriptionRegistry;
  private readonly deliveryPipeline: DeliveryPipeline;
  private readonly signalEmitter: SignalEmitter;
  private readonly sqliteIndex: SqliteIndex;
  private readonly database: RelayDatabase;
  readonly #accessControl: AccessControl;
  readonly #documentTurnCeiling: RelayTurnCeiling;
  private readonly configPath: string;
  private configWatcher: CoreTypes.FSWatcher | null = null;
  private readonly logger: CoreTypes.RelayLogger;
  private circuitBreaker: CircuitBreakerManager;
  private backpressureConfig: CoreTypes.BackpressureConfig;
  private readonly dispatchInboxTtlMs: number;
  private readonly ttlSweepIntervalMs: number;
  private ttlSweepInterval?: ReturnType<typeof setInterval>;
  private readonly gc: RelayGc;
  /**
   * Host-installed binding lookup that authorizes a chat-failure notice.
   *
   * Unset means "this relay cannot tell whose chat that is", which is a denial —
   * see {@link setChatNoticeTargetResolver}.
   */
  private chatNoticeTargetResolver?: CoreTypes.ChatNoticeTargetResolver;
  private readonly gcIntervalMs: number;
  private gcInterval?: ReturnType<typeof setInterval>;
  #closed = false;
  private readonly adapterRegistry?: CoreTypes.AdapterRegistryLike;

  constructor(options?: CoreTypes.RelayOptions) {
    this.logger = options?.logger ?? noopLogger;
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });

    const mailboxesDir = path.join(dataDir, 'mailboxes');
    const endpointRegistry = new EndpointRegistry(dataDir);
    this.subscriptionRegistry = new SubscriptionRegistry();
    const maildirStore = new MaildirStore({ rootDir: mailboxesDir });

    this.database = new RelayDatabase(path.join(dataDir, 'index.db'), options);
    this.sqliteIndex = new SqliteIndex(this.database.db);

    const deadLetterQueue = new DeadLetterQueue({
      maildirStore,
      sqliteIndex: this.sqliteIndex,
      logger: options?.logger,
      onDeadLetter: options?.onDeadLetter,
    });
    this.#accessControl = new AccessControl(dataDir, options?.logger);
    this.signalEmitter = new SignalEmitter();

    const rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...options?.reliability?.rateLimit };
    this.circuitBreaker = new CircuitBreakerManager(options?.reliability?.circuitBreaker);
    this.backpressureConfig = { ...DEFAULT_BP_CONFIG, ...options?.reliability?.backpressure };

    this.deliveryPipeline = new DeliveryPipeline(
      {
        sqliteIndex: this.sqliteIndex,
        maildirStore,
        subscriptionRegistry: this.subscriptionRegistry,
        circuitBreaker: this.circuitBreaker,
        signalEmitter: this.signalEmitter,
        deadLetterQueue,
      },
      this.backpressureConfig
    );
    // One ceiling, two readers (DOR-791). The pipeline reserves against it at
    // the dispatch; AdapterDelivery gives a reservation back when the dispatch
    // it was charged for turns out never to have run. A second instance here
    // would refund a counter nobody is spending.
    const turnCeiling = new RelayTurnCeiling(
      options?.turnCeiling ? { limits: options.turnCeiling } : {}
    );
    this.#documentTurnCeiling = turnCeiling;
    const adapterDelivery = new AdapterDelivery({
      adapterRegistry: options?.adapterRegistry,
      sqliteIndex: this.sqliteIndex,
      maildirStore,
      deadLetterQueue,
      logger: options?.logger,
    });
    const watcherManager = new WatcherManager(
      maildirStore,
      this.subscriptionRegistry,
      this.sqliteIndex,
      this.circuitBreaker,
      this.logger
    );
    watcherManager.setWasDispatched((id) => this.deliveryPipeline.wasDispatched(id));

    // Build publish pipeline
    const originalDocumentPipeline = createOriginalDocumentPublishPipeline(
      {
        endpointRegistry,
        subscriptionRegistry: this.subscriptionRegistry,
        maildirStore,
        sqliteIndex: this.sqliteIndex,
        receiptStore: this.database.receipts,
        accessControl: this.#accessControl,
        deadLetterQueue,
        deliveryPipeline: this.deliveryPipeline,
        adapterDelivery,
        adapterRegistry: options?.adapterRegistry,
        traceStore: options?.traceStore,
        logger: options?.logger,
        // The hourly ceiling on turns, at the one dispatch every surface
        // crosses (DOR-791). Built above rather than left to the pipeline's
        // fallback so a host that DID wire limits gets them; a host that wired
        // none still gets the shipped ones.
        turnCeiling,
      },
      {
        maxHops: options?.maxHops ?? DEFAULT_MAX_HOPS,
        defaultTtlMs: options?.defaultTtlMs ?? DEFAULT_TTL_MS,
        defaultCallBudget: options?.defaultCallBudget ?? DEFAULT_CALL_BUDGET,
      },
      rateLimitConfig,
      options?.adapterContextBuilder
    );

    this.publishPipeline = originalDocumentPipeline.pipeline;
    this.#publishDocumentWake = originalDocumentPipeline.publishDocumentWake;

    // Settle a waiting caller (relay_send_and_wait, A2A executor) when a
    // detached agent delivery dead-letters OR the publish pipeline's
    // authoritative budget gate rejects, instead of leaving it to time out.
    const replyFailureNotifier = createReplyFailureNotifier({
      publish: (subject, payload, opts) => this.publishPipeline.publish(subject, payload, opts),
      // A reply inbox may be a registered endpoint (relay_send_and_wait) or a
      // pure subscription (the A2A executor subscribes with no endpoint).
      hasConsumer: (subject) =>
        endpointRegistry.hasEndpoint(subject) ||
        this.subscriptionRegistry.getSubscribers(subject).length > 0,
    });
    adapterDelivery.setReplyFailureNotifier(replyFailureNotifier);
    this.publishPipeline.setReplyFailureNotifier(replyFailureNotifier);

    // A chat message whose turn was accepted and then failed — the runtime at
    // capacity, a thrown adapter — is dead-lettered above and, before this, told
    // nobody: the reply-inbox notifier deliberately covers only `relay.inbox.*`
    // and `relay.a2a.reply.*`, which is 0% of chat traffic. This second notifier
    // covers the person's own chat, and its `relay.system.*` principal is what
    // keeps the notice from being routed back to the agent as a fresh prompt.
    //
    // The subject it speaks on is the failed envelope's `replyTo`, which on
    // `relay_send` is written by the model — so it resolves through the
    // host-installed binding resolver below, and says nothing at all until that
    // is installed.
    adapterDelivery.setChatFailureNotifier(
      createChatNoticeSender({
        publish: (subject, payload, opts) => this.publishPipeline.publish(subject, payload, opts),
        resolveTarget: (subject) => this.chatNoticeTargetResolver?.(subject) ?? null,
        logger: options?.logger,
      })
    );

    this.subscriptionDeps = {
      subscriptionRegistry: this.subscriptionRegistry,
      signalEmitter: this.signalEmitter,
    };
    this.endpointDeps = {
      endpointRegistry,
      maildirStore,
      sqliteIndex: this.sqliteIndex,
      deadLetterQueue,
      accessControl: this.#accessControl,
      watcherManager,
    };

    this.gc = new RelayGc(
      {
        pruneDeliveryReceipts: () => this.database.receipts.pruneExpiredIfReady(),
        sqliteIndex: this.sqliteIndex,
        maildirStore,
        deadLetterQueue,
        endpointRegistry,
        deliveryPipeline: this.deliveryPipeline,
        traceStore: options?.traceStore,
        logger: options?.logger,
      },
      {
        deadLetterRetentionMs: options?.deadLetterRetentionMs ?? DEFAULT_DEAD_LETTER_RETENTION_MS,
        orphanMaildirRetentionMs:
          options?.orphanMaildirRetentionMs ?? DEFAULT_ORPHAN_MAILDIR_RETENTION_MS,
        inFlightRecoveryMs: options?.inFlightRecoveryMs ?? DEFAULT_IN_FLIGHT_RECOVERY_MS,
        undeliveredMailRetentionMs:
          options?.undeliveredMailRetentionMs ?? DEFAULT_UNDELIVERED_MAIL_RETENTION_MS,
      }
    );

    this.configPath = path.join(dataDir, 'config.json');
    const createOriginalOwnerContext = (owner: RelayCore): OriginalRelayCoreContext =>
      ({
        relay: this,
        accessControl: this.#accessControl,
        originalRegistry: this.subscriptionRegistry,
        requireOpen: () => {
          if (this.#closed) throw new Error('RelayCore has been closed');
        },
        originalAccessCheck,
        originalDocumentSubscribe,
        issueOrigin: (origin, access) => {
          documentOrigins.set(origin, access);
        },
        publishDocumentWake: (wake: import('./document-delivery.js').OriginalDocumentRelayWake) =>
          this.#publishDocumentWake(wake),
        documentTurnCeiling: this.#documentTurnCeiling,
        configPath: this.configPath,
        publishPipeline: this.publishPipeline,
        circuitBreaker: this.circuitBreaker,
        get backpressureConfig() {
          return owner.backpressureConfig;
        },
        set backpressureConfig(value: CoreTypes.BackpressureConfig) {
          owner.backpressureConfig = value;
        },
        deliveryPipeline: this.deliveryPipeline,
        gc: this.gc,
        get configWatcher() {
          return owner.configWatcher;
        },
        set configWatcher(value: CoreTypes.FSWatcher | null) {
          owner.configWatcher = value;
        },
        loadReliabilityConfig: () => loadOriginalRelayReliability(this.#ownerKey),
        logger: this.logger,
        endpointDeps: this.endpointDeps,
        get dispatchInboxTtlMs() {
          return owner.dispatchInboxTtlMs;
        },
        get closed() {
          return owner.#closed;
        },
        unregisterEndpoint: (subject: string) => this.unregisterEndpoint(subject),
      }) satisfies OriginalRelayCoreContext;
    relayCoreOwnerApply(relayCoreOwnerSet, relayCoreOwners, [
      this.#ownerKey,
      createOriginalOwnerContext(this),
    ]);
    loadOriginalRelayReliability(this.#ownerKey);
    startOriginalRelayConfigWatcher(this.#ownerKey);

    this.dispatchInboxTtlMs = options?.dispatchInboxTtlMs ?? 30 * 60 * 1000;
    this.ttlSweepIntervalMs = options?.ttlSweepIntervalMs ?? 5 * 60 * 1000;
    this.startTtlSweeper();

    this.gcIntervalMs = options?.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    this.startGcSweeper();

    if (options?.adapterRegistry) {
      this.adapterRegistry = options.adapterRegistry;
      this.adapterRegistry.setRelay(this);
    }
  }

  /**
   * Set the adapter context builder callback.
   *
   * @param builder - Callback that enriches AdapterContext for a given subject
   */
  setAdapterContextBuilder(builder: CoreTypes.AdapterContextBuilder): void {
    this.publishPipeline.setAdapterContextBuilder(builder);
  }

  /**
   * Set the authoritative agent→human initiate-consent gate (DOR-277).
   *
   * The host wires this after construction once the binding store is available.
   * Delegates to {@link RelayPublishPipeline.setInitiateConsentGate}.
   *
   * @param gate - The consent gate predicate.
   */
  setInitiateConsentGate(gate: CoreTypes.InitiateConsentGate): void {
    this.publishPipeline.setInitiateConsentGate(gate);
  }

  /**
   * Install the binding lookup that authorizes a chat-failure notice.
   *
   * Wired by the host beside {@link setInitiateConsentGate}, and for the same
   * reason: this relay cannot see the binding store, and the subject a notice
   * would speak on comes from a failed envelope's `replyTo` — a field the model
   * writes on `relay_send`. Until this is installed the notifier resolves
   * nothing and stays silent, so a relay that never got its bindings cannot be
   * talked into posting somewhere nobody bound.
   *
   * @param resolver - Chat subject → the enabled binding that owns it, or null.
   */
  setChatNoticeTargetResolver(resolver: CoreTypes.ChatNoticeTargetResolver): void {
    this.chatNoticeTargetResolver = resolver;
  }

  // --- Publish ---

  /** Publish a message to a subject. Delegates to {@link RelayPublishPipeline}. */
  async publish(
    subject: string,
    payload: unknown,
    options: CoreTypes.PublishOptions
  ): Promise<CoreTypes.PublishResult> {
    if (options.receiptContext && isDetachedAgentSubject(subject)) {
      this.database.receipts.assertOutsideTransaction();
    }
    this.assertOpen();
    return this.publishPipeline.publish(subject, payload, options);
  }

  /** Read minimized authoritative metadata with a server-resolved ownership policy. */
  getDeliveryReceipt(messageId: string, context: CoreTypes.RelayReceiptReadContext) {
    return this.database.receipts.get(messageId, context);
  }

  /** Deliver one private native notification without Maildir, pending buffers or dead letters. */
  async deliverPrivateNotification(
    subject: string,
    text: string,
    options: CoreTypes.PrivateNotificationOptions
  ): Promise<CoreTypes.PrivateNotificationResult> {
    this.assertOpen();
    return this.publishPipeline.deliverPrivateNotification(subject, text, options);
  }

  // --- Subscribe ---

  /**
   * Subscribe to messages matching a pattern.
   *
   * When the pattern exactly matches a registered endpoint's subject, any
   * messages already sitting in that endpoint's `new/` directory are drained
   * to the new subscriber asynchronously. Without this, a reply that lands
   * between endpoint registration and subscription (or during a window with
   * zero subscribers) would strand in `new/` forever.
   */
  subscribe(pattern: string, handler: CoreTypes.MessageHandler): CoreTypes.Unsubscribe {
    this.assertOpen();
    const unsubscribe = executeSubscribe(pattern, handler, this.subscriptionDeps);

    const endpoint = this.endpointDeps.endpointRegistry.getEndpoint(pattern);
    if (endpoint) void this.drainEndpointBacklog(endpoint);

    return unsubscribe;
  }

  /** Emit an ephemeral signal (never touches disk). */
  signal(subject: string, signalData: Signal): void {
    this.assertOpen();
    if (isDocumentSubject(subject) || isDocumentSubject(signalData.endpointSubject))
      throw new Error('DOCUMENT_RELAY_CONSTRUCTION_REQUIRED');
    executeSignal(subject, signalData, this.subscriptionDeps);
  }

  /** Subscribe to ephemeral signals matching a pattern. */
  onSignal(pattern: string, handler: CoreTypes.SignalHandler): CoreTypes.Unsubscribe {
    this.assertOpen();
    return executeOnSignal(pattern, handler, this.subscriptionDeps);
  }

  // --- Endpoint Management ---

  /**
   * Register a new message endpoint (creates Maildir directories).
   *
   * @param subject - The hierarchical subject for this endpoint
   * @param options - Pass `owner` to record which principal this mailbox
   *   belongs to, so ownership-gated callers can tell whose mail it is.
   */
  async registerEndpoint(
    subject: string,
    options?: CoreTypes.RegisterEndpointOptions
  ): Promise<CoreTypes.EndpointInfo> {
    this.assertOpen();
    if (isDocumentSubject(subject)) throw new Error('DOCUMENT_RELAY_CONSTRUCTION_REQUIRED');
    return executeRegisterEndpoint(subject, options, this.endpointDeps);
  }

  /** Unregister an endpoint and stop its watcher. */
  async unregisterEndpoint(subject: string): Promise<boolean> {
    this.assertOpen();
    return executeUnregisterEndpoint(subject, this.endpointDeps);
  }

  /** List all registered endpoints. */
  listEndpoints(): CoreTypes.EndpointInfo[] {
    this.assertOpen();
    return executeListEndpoints(this.endpointDeps);
  }

  /**
   * Look up one registered endpoint by its exact subject.
   *
   * Exact match only, on the same string the endpoint was registered with.
   *
   * @param subject - The endpoint subject to look up
   * @returns The endpoint, or `undefined` when no endpoint is registered
   */
  getEndpoint(subject: string): CoreTypes.EndpointInfo | undefined {
    this.assertOpen();
    return executeGetEndpoint(subject, this.endpointDeps);
  }

  /** Returns the configured dispatch inbox TTL in milliseconds. */
  getDispatchInboxTtlMs(): number {
    return this.dispatchInboxTtlMs;
  }

  /** Get a single representative message row from the index by ID. */
  getMessage(id: string): CoreTypes.IndexedMessage | null {
    this.assertOpen();
    return executeGetMessage(id, this.endpointDeps);
  }

  /**
   * Get the honest, joined detail for a message id: a representative row plus
   * the full per-endpoint delivery breakdown (all joined on the envelope id).
   */
  getMessageDetail(id: string): CoreTypes.MessageDetail | null {
    this.assertOpen();
    return executeGetMessageDetail(id, this.endpointDeps);
  }

  /** Query messages with optional filters and cursor-based pagination. */
  listMessages(filters?: {
    subject?: string;
    status?: string;
    from?: string;
    cursor?: string;
    limit?: number;
  }): { messages: CoreTypes.IndexedMessage[]; nextCursor?: string } {
    this.assertOpen();
    return executeListMessages(filters, this.endpointDeps);
  }

  /**
   * Read inbox messages for a specific endpoint, including envelope payloads.
   *
   * Pass `ack: true` to acknowledge returned unread messages so subsequent
   * unread reads no longer include them.
   */
  async readInbox(
    subject: string,
    options?: CoreTypes.ReadInboxOptions
  ): Promise<{ messages: CoreTypes.InboxMessage[]; nextCursor?: string }> {
    this.assertOpen();
    return executeReadInbox(subject, options, this.endpointDeps);
  }

  /** Get dead letters, optionally filtered by endpoint hash. */
  async getDeadLetters(options?: CoreTypes.ListDeadOptions): Promise<CoreTypes.DeadLetterEntry[]> {
    this.assertOpen();
    return executeGetDeadLetters(options, this.endpointDeps);
  }

  /**
   * Remove a single dead letter by endpoint hash and message ID.
   *
   * @param endpointHash - The endpoint hash where the dead letter resides
   * @param messageId - The ULID message ID to remove
   */
  async removeDeadLetter(endpointHash: string, messageId: string): Promise<void> {
    this.assertOpen();
    await this.endpointDeps.deadLetterQueue.removeDeadLetter(endpointHash, messageId);
  }

  /** Add an access control rule. */
  addAccessRule(rule: RelayAccessRule): void {
    this.assertOpen();
    executeAddAccessRule(rule, this.endpointDeps);
  }

  /** Remove the first access control rule matching the given patterns. */
  removeAccessRule(from: string, to: string): void {
    this.assertOpen();
    executeRemoveAccessRule(from, to, this.endpointDeps);
  }

  /** List all access control rules, sorted by priority (highest first). */
  listAccessRules(): RelayAccessRule[] {
    this.assertOpen();
    return executeListAccessRules(this.endpointDeps);
  }

  /**
   * Whether the access rules file exists but could not be read.
   *
   * While that is true the evaluator holds no rules and denies every message,
   * and `listAccessRules()` returns an empty list that looks exactly like "no
   * rules configured". This is how a caller tells those two apart — notably
   * `GET /api/health/deep`, which reports the difference to an operator.
   */
  isAccessControlQuarantined(): boolean {
    this.assertOpen();
    return this.#accessControl.isQuarantined();
  }

  /** Rebuild the SQLite index from Maildir files on disk. */
  async rebuildIndex(): Promise<number> {
    this.assertOpen();
    return executeRebuildIndex(this.endpointDeps);
  }

  /** Get aggregate metrics from the SQLite index. */
  getMetrics(): CoreTypes.RelayMetrics {
    this.assertOpen();
    return executeGetMetrics(this.endpointDeps);
  }

  // --- Lifecycle ---

  /** Gracefully shut down the relay. */
  async close(): Promise<void> {
    this.#closed = true;
    return this.database.close([
      () => {
        if (this.ttlSweepInterval) clearInterval(this.ttlSweepInterval);
        this.ttlSweepInterval = undefined;
        if (this.gcInterval) clearInterval(this.gcInterval);
        this.gcInterval = undefined;
      },
      () => {
        this.subscriptionRegistry.shutdown();
        this.subscriptionRegistry.clear();
        this.deliveryPipeline.close();
      },
      () => this.endpointDeps.watcherManager.closeAll(),
      async () => {
        if (this.configWatcher) {
          await this.configWatcher.close();
          this.configWatcher = null;
        }
      },
      () => {
        this.#accessControl.close();
        this.signalEmitter.removeAllSubscriptions();
      },
      () => this.adapterRegistry?.shutdown(),
      () => this.sqliteIndex.close(),
    ]);
  }

  // --- Private Helpers ---

  /**
   * Dispatch messages stranded in an endpoint's `new/` directory to the
   * current subscribers. Claims are atomic renames, so a concurrent watcher
   * dispatch for the same message safely no-ops.
   */
  private async drainEndpointBacklog(endpoint: CoreTypes.EndpointInfo): Promise<void> {
    return drainOriginalRelayBacklog(this.#ownerKey, endpoint);
  }
  /**
   * Start the periodic TTL sweeper for dispatch inboxes.
   *
   * Expiry is keyed on INACTIVITY, not age-since-registration: an inbox that is
   * still being polled or receiving replies has its last-activity timestamp
   * refreshed (see {@link EndpointRegistry.touch}), so a long but active
   * conversation is never swept out from under its participants (M3).
   */
  private startTtlSweeper(): void {
    this.ttlSweepInterval = setInterval(() => {
      void this.runTtlSweep();
    }, this.ttlSweepIntervalMs);
    this.ttlSweepInterval.unref();
  }

  /**
   * Run one TTL sweep of dispatch inboxes, unregistering any whose
   * inactivity window has elapsed. Exposed (mirroring {@link runGcSweep})
   * so callers — chiefly tests — can trigger a deterministic sweep instead
   * of racing the periodic timer, which can lag under event-loop load.
   *
   * @returns The subjects unregistered by this sweep.
   */
  async runTtlSweep(): Promise<string[]> {
    return runOriginalRelayTtlSweep(this.#ownerKey);
  }

  /**
   * Start the periodic storage GC sweeper (expiry, dead-letter retention,
   * crash recovery, orphan reaping). Runs one sweep immediately so a freshly
   * started relay recovers crash-stranded messages without waiting a full
   * interval — but that construction sweep SKIPS orphan reaping: the in-memory
   * endpoint registry is empty right after a restart, so every mailbox
   * directory would look unowned. Reaping starts one interval later, once
   * endpoints have had a chance to re-register.
   */
  private startGcSweeper(): void {
    void this.runGcSweep({ skipOrphanReap: true });
    this.gcInterval = setInterval(() => void this.runGcSweep(), this.gcIntervalMs);
    this.gcInterval.unref();
  }

  /**
   * Run one storage GC sweep. Exposed for tests and callers that want a
   * deterministic sweep; the periodic timer calls this internally.
   *
   * @param options - Per-sweep options (e.g. skip orphan reaping).
   * @returns Per-phase removal counts, or `undefined` if the relay is closed.
   */
  async runGcSweep(
    options?: CoreTypes.RelayGcSweepOptions
  ): Promise<Awaited<ReturnType<RelayGc['sweep']>> | undefined> {
    return runOriginalRelayGcSweep(this.#ownerKey, options);
  }

  /** Assert that the relay has not been closed. */
  private assertOpen(): void {
    if (this.#closed) {
      throw new Error('RelayCore has been closed');
    }
  }
}
