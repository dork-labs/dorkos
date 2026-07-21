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
import chokidar, { type FSWatcher } from 'chokidar';
import { createDb, runMigrations } from '@dorkos/db';
import { EndpointRegistry } from './endpoint-registry.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import { MaildirStore } from './maildir-store.js';
import { SqliteIndex } from './sqlite-index.js';
import { DeadLetterQueue } from './dead-letter-queue.js';
import { AccessControl } from './access-control.js';
import { SignalEmitter } from './signal-emitter.js';
import { DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
import { CircuitBreakerManager, DEFAULT_CB_CONFIG } from './circuit-breaker.js';
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
} from './relay-gc.js';
import type { RelayGcSweepOptions } from './relay-gc.js';
import { createReplyFailureNotifier } from './reply-failure-notifier.js';
import { ReliabilityConfigSchema } from '@dorkos/shared/relay-schemas';
import { inferEndpointType } from './types.js';
import { RelayPublishPipeline } from './relay-publish.js';
import { executeSubscribe, executeSignal, executeOnSignal } from './relay-subscriptions.js';
import {
  executeRegisterEndpoint,
  executeUnregisterEndpoint,
  executeListEndpoints,
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
import type { Signal, RelayAccessRule } from '@dorkos/shared/relay-schemas';
import type {
  BackpressureConfig,
  RelayOptions,
  PublishOptions,
  MessageHandler,
  SignalHandler,
  Unsubscribe,
  EndpointInfo,
  RelayMetrics,
  AdapterRegistryLike,
  AdapterContext,
  InitiateConsentGate,
} from './types.js';
import type { DeadLetterEntry, ListDeadOptions } from './dead-letter-queue.js';
import type { IndexedMessage } from './sqlite-index.js';
import type { PublishResult } from './relay-publish.js';
import type { SubscriptionDeps } from './relay-subscriptions.js';
import type {
  EndpointManagementDeps,
  InboxMessage,
  MessageDetail,
  ReadInboxOptions,
} from './relay-endpoint-management.js';

// Re-export public types from sub-modules
export type { PublishResult } from './relay-publish.js';
export type { InboxMessage, MessageDetail, ReadInboxOptions } from './relay-endpoint-management.js';

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
  private readonly publishPipeline: RelayPublishPipeline;
  private readonly subscriptionDeps: SubscriptionDeps;
  private readonly endpointDeps: EndpointManagementDeps;
  private readonly subscriptionRegistry: SubscriptionRegistry;
  private readonly deliveryPipeline: DeliveryPipeline;
  private readonly signalEmitter: SignalEmitter;
  private readonly sqliteIndex: SqliteIndex;
  private readonly accessControl: AccessControl;
  private readonly configPath: string;
  private configWatcher: FSWatcher | null = null;
  private circuitBreaker: CircuitBreakerManager;
  private backpressureConfig: BackpressureConfig;
  private readonly dispatchInboxTtlMs: number;
  private readonly ttlSweepIntervalMs: number;
  private ttlSweepInterval?: ReturnType<typeof setInterval>;
  private readonly gc: RelayGc;
  private readonly gcIntervalMs: number;
  private gcInterval?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly adapterRegistry?: AdapterRegistryLike;

  constructor(options?: RelayOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });

    const mailboxesDir = path.join(dataDir, 'mailboxes');
    const endpointRegistry = new EndpointRegistry(dataDir);
    this.subscriptionRegistry = new SubscriptionRegistry();
    const maildirStore = new MaildirStore({ rootDir: mailboxesDir });

    if (options?.db) {
      this.sqliteIndex = new SqliteIndex(options.db);
    } else {
      const dbPath = path.join(dataDir, 'index.db');
      const legacyDb = createDb(dbPath);
      runMigrations(legacyDb);
      this.sqliteIndex = new SqliteIndex(legacyDb);
    }

    const deadLetterQueue = new DeadLetterQueue({
      maildirStore,
      sqliteIndex: this.sqliteIndex,
      rootDir: mailboxesDir,
      onDeadLetter: options?.onDeadLetter,
    });
    this.accessControl = new AccessControl(dataDir);
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
      this.circuitBreaker
    );
    watcherManager.setWasDispatched((id) => this.deliveryPipeline.wasDispatched(id));

    // Build publish pipeline
    this.publishPipeline = new RelayPublishPipeline(
      {
        endpointRegistry,
        subscriptionRegistry: this.subscriptionRegistry,
        maildirStore,
        sqliteIndex: this.sqliteIndex,
        accessControl: this.accessControl,
        deadLetterQueue,
        deliveryPipeline: this.deliveryPipeline,
        adapterDelivery,
        adapterRegistry: options?.adapterRegistry,
        traceStore: options?.traceStore,
        logger: options?.logger,
      },
      {
        maxHops: options?.maxHops ?? DEFAULT_MAX_HOPS,
        defaultTtlMs: options?.defaultTtlMs ?? DEFAULT_TTL_MS,
        defaultCallBudget: options?.defaultCallBudget ?? DEFAULT_CALL_BUDGET,
      },
      rateLimitConfig,
      options?.adapterContextBuilder
    );

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

    this.subscriptionDeps = {
      subscriptionRegistry: this.subscriptionRegistry,
      signalEmitter: this.signalEmitter,
    };
    this.endpointDeps = {
      endpointRegistry,
      maildirStore,
      sqliteIndex: this.sqliteIndex,
      deadLetterQueue,
      accessControl: this.accessControl,
      watcherManager,
    };

    this.gc = new RelayGc(
      {
        sqliteIndex: this.sqliteIndex,
        maildirStore,
        deadLetterQueue,
        endpointRegistry,
        deliveryPipeline: this.deliveryPipeline,
        logger: options?.logger,
      },
      {
        deadLetterRetentionMs: options?.deadLetterRetentionMs ?? DEFAULT_DEAD_LETTER_RETENTION_MS,
        orphanMaildirRetentionMs:
          options?.orphanMaildirRetentionMs ?? DEFAULT_ORPHAN_MAILDIR_RETENTION_MS,
        inFlightRecoveryMs: options?.inFlightRecoveryMs ?? DEFAULT_IN_FLIGHT_RECOVERY_MS,
      }
    );

    this.configPath = path.join(dataDir, 'config.json');
    this.loadReliabilityConfig();
    this.startConfigWatcher();

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
  setAdapterContextBuilder(builder: (subject: string) => AdapterContext | undefined): void {
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
  setInitiateConsentGate(gate: InitiateConsentGate): void {
    this.publishPipeline.setInitiateConsentGate(gate);
  }

  // --- Publish ---

  /** Publish a message to a subject. Delegates to {@link RelayPublishPipeline}. */
  async publish(
    subject: string,
    payload: unknown,
    options: PublishOptions
  ): Promise<PublishResult> {
    this.assertOpen();
    return this.publishPipeline.publish(subject, payload, options);
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
  subscribe(pattern: string, handler: MessageHandler): Unsubscribe {
    this.assertOpen();
    const unsubscribe = executeSubscribe(pattern, handler, this.subscriptionDeps);

    const endpoint = this.endpointDeps.endpointRegistry.getEndpoint(pattern);
    if (endpoint) void this.drainEndpointBacklog(endpoint);

    return unsubscribe;
  }

  /** Emit an ephemeral signal (never touches disk). */
  signal(subject: string, signalData: Signal): void {
    this.assertOpen();
    executeSignal(subject, signalData, this.subscriptionDeps);
  }

  /** Subscribe to ephemeral signals matching a pattern. */
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe {
    this.assertOpen();
    return executeOnSignal(pattern, handler, this.subscriptionDeps);
  }

  // --- Endpoint Management ---

  /** Register a new message endpoint (creates Maildir directories). */
  async registerEndpoint(subject: string): Promise<EndpointInfo> {
    this.assertOpen();
    return executeRegisterEndpoint(subject, this.endpointDeps);
  }

  /** Unregister an endpoint and stop its watcher. */
  async unregisterEndpoint(subject: string): Promise<boolean> {
    this.assertOpen();
    return executeUnregisterEndpoint(subject, this.endpointDeps);
  }

  /** List all registered endpoints. */
  listEndpoints(): EndpointInfo[] {
    this.assertOpen();
    return executeListEndpoints(this.endpointDeps);
  }

  /** Returns the configured dispatch inbox TTL in milliseconds. */
  getDispatchInboxTtlMs(): number {
    return this.dispatchInboxTtlMs;
  }

  /** Get a single representative message row from the index by ID. */
  getMessage(id: string): IndexedMessage | null {
    this.assertOpen();
    return executeGetMessage(id, this.endpointDeps);
  }

  /**
   * Get the honest, joined detail for a message id: a representative row plus
   * the full per-endpoint delivery breakdown (all joined on the envelope id).
   */
  getMessageDetail(id: string): MessageDetail | null {
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
  }): { messages: IndexedMessage[]; nextCursor?: string } {
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
    options?: ReadInboxOptions
  ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> {
    this.assertOpen();
    return executeReadInbox(subject, options, this.endpointDeps);
  }

  /** Get dead letters, optionally filtered by endpoint hash. */
  async getDeadLetters(options?: ListDeadOptions): Promise<DeadLetterEntry[]> {
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

  /** Rebuild the SQLite index from Maildir files on disk. */
  async rebuildIndex(): Promise<number> {
    this.assertOpen();
    return executeRebuildIndex(this.endpointDeps);
  }

  /** Get aggregate metrics from the SQLite index. */
  getMetrics(): RelayMetrics {
    this.assertOpen();
    return executeGetMetrics(this.endpointDeps);
  }

  // --- Lifecycle ---

  /** Gracefully shut down the relay. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.ttlSweepInterval) {
      clearInterval(this.ttlSweepInterval);
      this.ttlSweepInterval = undefined;
    }

    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = undefined;
    }

    this.subscriptionRegistry.shutdown();
    this.subscriptionRegistry.clear();
    this.deliveryPipeline.close();
    await this.endpointDeps.watcherManager.closeAll();

    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = null;
    }

    this.accessControl.close();
    this.signalEmitter.removeAllSubscriptions();

    if (this.adapterRegistry) {
      await this.adapterRegistry.shutdown();
    }

    this.sqliteIndex.close();
  }

  // --- Private Helpers ---

  /**
   * Dispatch messages stranded in an endpoint's `new/` directory to the
   * current subscribers. Claims are atomic renames, so a concurrent watcher
   * dispatch for the same message safely no-ops.
   */
  private async drainEndpointBacklog(endpoint: EndpointInfo): Promise<void> {
    try {
      const messageIds = await this.endpointDeps.maildirStore.listNew(endpoint.hash);
      for (const messageId of messageIds) {
        await this.deliveryPipeline.dispatchToSubscribers(endpoint, messageId);
      }
    } catch {
      // Best-effort — stranded messages remain pollable via readInbox
    }
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
    if (this.closed) return [];
    const now = Date.now();
    const registry = this.endpointDeps.endpointRegistry;
    const swept: string[] = [];
    for (const endpoint of registry.listEndpoints()) {
      if (inferEndpointType(endpoint.subject) === 'dispatch') {
        const lastActivity =
          registry.getLastActivityMs(endpoint.subject) ?? Date.parse(endpoint.registeredAt);
        if (now - lastActivity > this.dispatchInboxTtlMs) {
          await this.unregisterEndpoint(endpoint.subject).catch(() => undefined);
          swept.push(endpoint.subject);
        }
      }
    }
    return swept;
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
    options?: RelayGcSweepOptions
  ): Promise<Awaited<ReturnType<RelayGc['sweep']>> | undefined> {
    if (this.closed) return undefined;
    return this.gc.sweep(Date.now(), options);
  }

  /** Load reliability configuration from disk (hot-reload safe). */
  private loadReliabilityConfig(): void {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const json: unknown = JSON.parse(raw);
      const obj = json as Record<string, unknown>;
      const parsed = ReliabilityConfigSchema.safeParse(obj.reliability);
      if (parsed.success) {
        this.publishPipeline.setRateLimitConfig({
          ...DEFAULT_RATE_LIMIT_CONFIG,
          ...parsed.data.rateLimit,
        });
        this.circuitBreaker.updateConfig({ ...DEFAULT_CB_CONFIG, ...parsed.data.circuitBreaker });
        this.backpressureConfig = { ...DEFAULT_BP_CONFIG, ...parsed.data.backpressure };
        this.deliveryPipeline.setBackpressureConfig(this.backpressureConfig);
      }
    } catch {
      // File doesn't exist or is invalid -- keep current config
    }
  }

  /** Start a chokidar watcher on the config file for hot-reload. */
  private startConfigWatcher(): void {
    this.configWatcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.configWatcher.on('change', () => this.loadReliabilityConfig());
    this.configWatcher.on('add', () => this.loadReliabilityConfig());
  }

  /** Assert that the relay has not been closed. */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error('RelayCore has been closed');
    }
  }
}
