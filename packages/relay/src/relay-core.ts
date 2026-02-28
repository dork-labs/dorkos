/**
 * Main entry point for the Relay message bus.
 *
 * Composes all sub-modules (EndpointRegistry, SubscriptionRegistry,
 * MaildirStore, SqliteIndex, DeadLetterQueue, AccessControl, SignalEmitter,
 * DeliveryPipeline, AdapterDelivery, WatcherManager, budget-enforcer)
 * into a single cohesive API surface.
 *
 * The publish pipeline validates subjects, checks access control, builds
 * envelopes with budget constraints, delivers to matching endpoints via
 * Maildir, and indexes in SQLite. Push delivery via chokidar watches
 * registered endpoints' `new/` directories and dispatches to subscriber
 * handlers automatically.
 *
 * @module relay/relay-core
 */
import * as path from 'node:path';
import * as os from 'node:os';
import fs from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { monotonicFactory } from 'ulidx';
import { createDb, runMigrations } from '@dorkos/db';
import { validateSubject, matchesPattern } from './subject-matcher.js';
import { createDefaultBudget } from './budget-enforcer.js';
import { EndpointRegistry, hashSubject } from './endpoint-registry.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import { MaildirStore } from './maildir-store.js';
import { SqliteIndex } from './sqlite-index.js';
import { DeadLetterQueue } from './dead-letter-queue.js';
import { AccessControl } from './access-control.js';
import { SignalEmitter } from './signal-emitter.js';
import { checkRateLimit, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
import { CircuitBreakerManager, DEFAULT_CB_CONFIG } from './circuit-breaker.js';
import { DEFAULT_BP_CONFIG } from './backpressure.js';
import { DeliveryPipeline } from './delivery-pipeline.js';
import { AdapterDelivery } from './adapter-delivery.js';
import { WatcherManager } from './watcher-manager.js';
import type { RelayEnvelope, Signal } from '@dorkos/shared/relay-schemas';
import { ReliabilityConfigSchema } from '@dorkos/shared/relay-schemas';
import type {
  RateLimitConfig,
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
  DeliveryResult,
  TraceStoreLike,
} from './types.js';
import type { DeadLetterEntry, ListDeadOptions } from './dead-letter-queue.js';

// === Constants ===

/** Default data directory for Relay state. */
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dork', 'relay');

/** Default TTL: 1 hour in milliseconds. */
const DEFAULT_TTL_MS = 3_600_000;

/** Default maximum hop count. */
const DEFAULT_MAX_HOPS = 5;

/** Default call budget per message. */
const DEFAULT_CALL_BUDGET = 10;

// === Types ===

/** Fully resolved options with no optional fields. */
interface ResolvedOptions {
  dataDir: string;
  maxHops: number;
  defaultTtlMs: number;
  defaultCallBudget: number;
}

/** Result of a publish operation. */
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
  private readonly endpointRegistry: EndpointRegistry;
  private readonly subscriptionRegistry: SubscriptionRegistry;
  private readonly maildirStore: MaildirStore;
  private readonly sqliteIndex: SqliteIndex;
  private readonly deadLetterQueue: DeadLetterQueue;
  private readonly accessControl: AccessControl;
  private readonly signalEmitter: SignalEmitter;
  private readonly deliveryPipeline: DeliveryPipeline;
  private readonly adapterDelivery: AdapterDelivery;
  private readonly watcherManager: WatcherManager;
  private readonly generateUlid = monotonicFactory();
  private readonly opts: ResolvedOptions;
  private rateLimitConfig: RateLimitConfig;
  private circuitBreaker: CircuitBreakerManager;
  private backpressureConfig: BackpressureConfig;
  private readonly configPath: string;
  private configWatcher: FSWatcher | null = null;
  private closed = false;
  private readonly adapterRegistry?: AdapterRegistryLike;
  private readonly traceStore?: TraceStoreLike;
  private adapterContextBuilder?: (subject: string) => AdapterContext | undefined;

  constructor(options?: RelayOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.opts = {
      dataDir,
      maxHops: options?.maxHops ?? DEFAULT_MAX_HOPS,
      defaultTtlMs: options?.defaultTtlMs ?? DEFAULT_TTL_MS,
      defaultCallBudget: options?.defaultCallBudget ?? DEFAULT_CALL_BUDGET,
    };

    // Ensure data directory exists before any sub-module tries to read/write files
    fs.mkdirSync(dataDir, { recursive: true });

    const mailboxesDir = path.join(dataDir, 'mailboxes');

    this.endpointRegistry = new EndpointRegistry(dataDir);
    this.subscriptionRegistry = new SubscriptionRegistry(dataDir);
    this.maildirStore = new MaildirStore({ rootDir: mailboxesDir });

    // Use injected Drizzle db when provided; otherwise create a standalone one
    if (options?.db) {
      this.sqliteIndex = new SqliteIndex(options.db);
    } else {
      // Legacy/test path: create standalone database for this relay instance
      const dbPath = path.join(dataDir, 'index.db');
      const legacyDb = createDb(dbPath);
      runMigrations(legacyDb);
      this.sqliteIndex = new SqliteIndex(legacyDb);
    }
    this.deadLetterQueue = new DeadLetterQueue({
      maildirStore: this.maildirStore,
      sqliteIndex: this.sqliteIndex,
      rootDir: mailboxesDir,
    });
    this.accessControl = new AccessControl(dataDir);
    this.signalEmitter = new SignalEmitter();
    this.rateLimitConfig = {
      ...DEFAULT_RATE_LIMIT_CONFIG,
      ...options?.reliability?.rateLimit,
    };
    this.circuitBreaker = new CircuitBreakerManager(options?.reliability?.circuitBreaker);
    this.backpressureConfig = {
      ...DEFAULT_BP_CONFIG,
      ...options?.reliability?.backpressure,
    };

    // Compose extracted sub-modules
    this.deliveryPipeline = new DeliveryPipeline(
      {
        sqliteIndex: this.sqliteIndex,
        maildirStore: this.maildirStore,
        subscriptionRegistry: this.subscriptionRegistry,
        circuitBreaker: this.circuitBreaker,
        signalEmitter: this.signalEmitter,
        deadLetterQueue: this.deadLetterQueue,
      },
      this.backpressureConfig,
    );
    this.adapterDelivery = new AdapterDelivery(
      options?.adapterRegistry,
      this.sqliteIndex,
    );
    this.watcherManager = new WatcherManager(
      this.maildirStore,
      this.subscriptionRegistry,
      this.sqliteIndex,
      this.circuitBreaker,
    );

    // Config hot-reload: load from disk then watch for changes
    this.configPath = path.join(dataDir, 'config.json');
    this.loadReliabilityConfig();
    this.startConfigWatcher();

    // Wire optional trace store for delivery span recording
    if (options?.traceStore) {
      this.traceStore = options.traceStore;
    }

    // Wire adapter registry — set this as the RelayPublisher for inbound messages
    if (options?.adapterRegistry) {
      this.adapterRegistry = options.adapterRegistry;
      this.adapterRegistry.setRelay(this);
    }
    if (options?.adapterContextBuilder) {
      this.adapterContextBuilder = options.adapterContextBuilder;
    }
  }

  /**
   * Set the adapter context builder callback.
   *
   * Called after construction when the builder depends on services
   * initialized after RelayCore (e.g., AdapterManager with Mesh integration).
   *
   * @param builder - Callback that enriches AdapterContext for a given subject
   */
  setAdapterContextBuilder(builder: (subject: string) => AdapterContext | undefined): void {
    this.adapterContextBuilder = builder;
  }

  // --- Publish ---

  /**
   * Publish a message to a subject.
   *
   * Pipeline:
   * 1. Validate subject
   * 2. Check access control (from -> subject)
   * 3. Rate limit check (per-sender sliding window, before fan-out)
   * 4. Build envelope with ULID ID, budget, and payload
   * 5. Find all registered endpoints matching the subject
   * 6. For each endpoint: enforce budget, deliver via Maildir, index in SQLite
   * 7. If no endpoints match, reject to dead letter queue
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
    options: PublishOptions,
  ): Promise<PublishResult> {
    this.assertOpen();

    // 1. Validate subject
    const validation = validateSubject(subject);
    if (!validation.valid) {
      throw new Error(`Invalid subject: ${validation.reason.message}`);
    }

    // 2. Access control check
    const accessResult = this.accessControl.checkAccess(options.from, subject);
    if (!accessResult.allowed) {
      throw new Error(
        `Access denied: ${options.from} -> ${subject}` +
          (accessResult.matchedRule
            ? ` (rule: ${accessResult.matchedRule.from} -> ${accessResult.matchedRule.to})`
            : ''),
      );
    }

    // 3. Rate limit check (per-sender, before fan-out)
    if (this.rateLimitConfig.enabled) {
      const windowStartIso = new Date(
        Date.now() - this.rateLimitConfig.windowSecs * 1000,
      ).toISOString();
      const countInWindow = this.sqliteIndex.countSenderInWindow(
        options.from,
        windowStartIso,
      );
      const rateLimitResult = checkRateLimit(options.from, countInWindow, this.rateLimitConfig);
      if (!rateLimitResult.allowed) {
        return {
          messageId: '',
          deliveredTo: 0,
          rejected: [{ endpointHash: '*', reason: 'rate_limited' }],
        };
      }
    }

    // 4. Build envelope
    const messageId = this.generateUlid();
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
      createdAt: new Date().toISOString(),
      payload,
    };

    // 5. Find matching Maildir endpoints
    const matchingEndpoints = this.findMatchingEndpoints(subject);

    // 6. Deliver to Maildir endpoints (may be empty — that's OK)
    let deliveredTo = 0;
    const rejected: PublishResult['rejected'] = [];
    const mailboxPressure: Record<string, number> = {};

    for (const endpoint of matchingEndpoints) {
      const result = await this.deliveryPipeline.deliverToEndpoint(endpoint, envelope);
      if (result.delivered) deliveredTo++;
      if (result.rejected) rejected.push(result.rejected);
      if (result.pressure !== undefined) mailboxPressure[endpoint.hash] = result.pressure;
    }

    // 7. Deliver to matching adapter (unified fan-out — always attempted)
    let adapterResult: DeliveryResult | null = null;
    if (this.adapterRegistry) {
      adapterResult = await this.adapterDelivery.deliver(
        subject,
        envelope,
        this.adapterContextBuilder,
      );
      if (adapterResult?.success) deliveredTo++;
    }

    // 7b. Dispatch to matching subscription handlers (direct fast-path).
    // When Maildir endpoints exist, subscriptions are already dispatched via
    // dispatchToSubscribers() inside deliverToEndpoint(). This block only
    // fires when there are NO matching Maildir endpoints, enabling
    // BindingRouter and other subscribers to intercept messages published
    // to subjects with no registered endpoint (e.g., relay.human.telegram.*).
    let subscriberCount = 0;
    if (matchingEndpoints.length === 0) {
      const subscribers = this.subscriptionRegistry.getSubscribers(subject);
      for (const handler of subscribers) {
        try {
          await handler(envelope);
          subscriberCount++;
        } catch {
          // Subscription handler errors are non-fatal for publish()
        }
      }
      deliveredTo += subscriberCount;
    }

    // 8. Dead-letter only when NO delivery targets matched at all
    // Reliability rejections (backpressure, circuit_open) are NOT dead-lettered
    if (deliveredTo === 0 && matchingEndpoints.length === 0 && subscriberCount === 0) {
      const subjectHash = hashSubject(subject);
      await this.maildirStore.ensureMaildir(subjectHash);

      const reason = adapterResult?.error
        ? `adapter delivery failed: ${adapterResult.error}`
        : 'no matching endpoints or adapters';
      await this.deadLetterQueue.reject(subjectHash, envelope, reason);
    }

    // 9. Record trace span for delivery tracking
    if (this.traceStore) {
      try {
        this.traceStore.insertSpan({
          messageId,
          traceId: messageId,
          subject,
          status: deliveredTo > 0 ? 'delivered' : 'failed',
          metadata: {
            deliveredTo,
            rejectedCount: rejected.length,
            hasAdapterResult: !!adapterResult,
            durationMs: Date.now() - new Date(envelope.createdAt).getTime(),
          },
        });
      } catch {
        // Trace insertion is best-effort — never fail a publish for tracing
      }
    }

    return {
      messageId,
      deliveredTo,
      ...(rejected.length > 0 && { rejected }),
      ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
      ...(adapterResult && { adapterResult }),
    };
  }

  // --- Subscribe ---

  /**
   * Subscribe to messages matching a pattern.
   *
   * The handler will be invoked for every new message that arrives
   * at any endpoint whose subject matches the given pattern. Pattern
   * matching uses NATS-style wildcards (`*` and `>`).
   *
   * @param pattern - A subject pattern, possibly with wildcards
   * @param handler - Callback invoked with matching envelopes
   * @returns An Unsubscribe function to remove this subscription
   */
  subscribe(pattern: string, handler: MessageHandler): Unsubscribe {
    this.assertOpen();
    return this.subscriptionRegistry.subscribe(pattern, handler);
  }

  // --- Signals ---

  /**
   * Emit an ephemeral signal (never touches disk).
   *
   * @param subject - A concrete subject for the signal
   * @param signalData - The signal payload
   */
  signal(subject: string, signalData: Signal): void {
    this.assertOpen();
    this.signalEmitter.emit(subject, signalData);
  }

  /**
   * Subscribe to ephemeral signals matching a pattern.
   *
   * @param pattern - A subject pattern, possibly with wildcards
   * @param handler - Callback invoked for matching signals
   * @returns An Unsubscribe function to remove this subscription
   */
  onSignal(pattern: string, handler: SignalHandler): Unsubscribe {
    this.assertOpen();
    return this.signalEmitter.subscribe(pattern, handler);
  }

  // --- Endpoint Management ---

  /**
   * Register a new message endpoint (creates Maildir directories).
   *
   * Also starts a chokidar watcher on the endpoint's `new/` directory
   * to enable push delivery to subscription handlers.
   *
   * @param subject - The hierarchical subject for this endpoint
   * @returns The registered EndpointInfo
   */
  async registerEndpoint(subject: string): Promise<EndpointInfo> {
    this.assertOpen();
    const info = await this.endpointRegistry.registerEndpoint(subject);
    await this.maildirStore.ensureMaildir(info.hash);
    await this.watcherManager.startWatcher(info);
    return info;
  }

  /**
   * Unregister an endpoint and stop its watcher.
   *
   * @param subject - The subject of the endpoint to unregister
   * @returns `true` if the endpoint was found and removed
   */
  async unregisterEndpoint(subject: string): Promise<boolean> {
    this.assertOpen();
    const endpoint = this.endpointRegistry.getEndpoint(subject);
    if (endpoint) {
      this.watcherManager.stopWatcher(endpoint.hash);
    }
    return this.endpointRegistry.unregisterEndpoint(subject);
  }

  // --- Query Facade ---

  /**
   * List all registered endpoints.
   *
   * @returns Array of EndpointInfo objects
   */
  listEndpoints(): EndpointInfo[] {
    this.assertOpen();
    return this.endpointRegistry.listEndpoints();
  }

  /**
   * Get a single message from the index by ID.
   *
   * @param id - The ULID of the message
   * @returns The indexed message, or null if not found
   */
  getMessage(id: string): import('./sqlite-index.js').IndexedMessage | null {
    this.assertOpen();
    return this.sqliteIndex.getMessage(id);
  }

  /**
   * Query messages with optional filters and cursor-based pagination.
   *
   * @param filters - Optional query filters (subject, status, from, cursor, limit)
   * @returns Object with messages array and optional nextCursor
   */
  listMessages(filters?: {
    subject?: string;
    status?: string;
    from?: string;
    cursor?: string;
    limit?: number;
  }): { messages: import('./sqlite-index.js').IndexedMessage[]; nextCursor?: string } {
    this.assertOpen();
    return this.sqliteIndex.queryMessages({
      subject: filters?.subject,
      status: filters?.status,
      sender: filters?.from,
      cursor: filters?.cursor,
      limit: filters?.limit,
    });
  }

  /**
   * Read inbox messages for a specific endpoint.
   *
   * @param subject - The endpoint subject to read inbox for
   * @param options - Optional query filters (status, cursor, limit)
   * @returns Object with messages array and optional nextCursor
   * @throws If the endpoint is not found
   */
  readInbox(
    subject: string,
    options?: { status?: string; cursor?: string; limit?: number },
  ): { messages: import('./sqlite-index.js').IndexedMessage[]; nextCursor?: string } {
    this.assertOpen();
    const endpoint = this.endpointRegistry.getEndpoint(subject);
    if (!endpoint) {
      const error = new Error(`Endpoint not found: ${subject}`);
      (error as Error & { code: string }).code = 'ENDPOINT_NOT_FOUND';
      throw error;
    }
    return this.sqliteIndex.queryMessages({
      endpointHash: endpoint.hash,
      status: options?.status,
      cursor: options?.cursor,
      limit: options?.limit,
    });
  }

  // --- Dead Letter Queue ---

  /**
   * Get dead letters, optionally filtered by endpoint hash.
   *
   * @param options - Optional filtering options
   * @returns Array of dead letter entries
   */
  async getDeadLetters(options?: ListDeadOptions): Promise<DeadLetterEntry[]> {
    this.assertOpen();
    return this.deadLetterQueue.listDead(options);
  }

  // --- Access Rule Management ---

  /**
   * Add an access control rule.
   *
   * Delegates to the internal {@link AccessControl} module, which
   * persists the rule to `access-rules.json` on disk.
   *
   * @param rule - The access rule to add (from, to, action, priority)
   */
  addAccessRule(rule: import('@dorkos/shared/relay-schemas').RelayAccessRule): void {
    this.assertOpen();
    this.accessControl.addRule(rule);
  }

  /**
   * Remove the first access control rule matching the given patterns.
   *
   * @param from - The `from` pattern to match
   * @param to - The `to` pattern to match
   */
  removeAccessRule(from: string, to: string): void {
    this.assertOpen();
    this.accessControl.removeRule(from, to);
  }

  /**
   * List all access control rules, sorted by priority (highest first).
   *
   * @returns A shallow copy of the current rules array
   */
  listAccessRules(): import('@dorkos/shared/relay-schemas').RelayAccessRule[] {
    this.assertOpen();
    return this.accessControl.listRules();
  }

  // --- Index ---

  /**
   * Rebuild the SQLite index from Maildir files on disk.
   *
   * This is the recovery mechanism for index corruption. Drops all
   * existing index data and re-scans all endpoint Maildir directories.
   *
   * @returns The number of messages re-indexed
   */
  async rebuildIndex(): Promise<number> {
    this.assertOpen();
    const endpoints = this.endpointRegistry.listEndpoints();
    const hashMap = new Map<string, string>();
    for (const ep of endpoints) {
      hashMap.set(ep.hash, ep.subject);
    }
    return this.sqliteIndex.rebuild(this.maildirStore, hashMap);
  }

  // --- Metrics ---

  /**
   * Get aggregate metrics from the SQLite index.
   *
   * @returns Relay metrics including total messages, counts by status and subject
   */
  getMetrics(): RelayMetrics {
    this.assertOpen();
    return this.sqliteIndex.getMetrics();
  }

  // --- Lifecycle ---

  /**
   * Gracefully shut down the relay.
   *
   * Stops all chokidar watchers, closes the AccessControl watcher,
   * removes all signal subscriptions, and closes the SQLite database
   * (triggering a WAL checkpoint).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Stop all endpoint watchers
    await this.watcherManager.closeAll();

    // Stop config watcher
    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = null;
    }

    // Close access control (stops its chokidar watcher)
    this.accessControl.close();

    // Clear signal subscriptions
    this.signalEmitter.removeAllSubscriptions();

    // Shut down adapter registry (graceful stop of all external adapters)
    if (this.adapterRegistry) {
      await this.adapterRegistry.shutdown();
    }

    // Close SQLite (WAL checkpoint)
    this.sqliteIndex.close();
  }

  // --- Private Helpers ---

  /**
   * Find all registered endpoints whose subject matches the given target.
   *
   * Uses `matchesPattern(endpointSubject, targetSubject)` to support
   * direct subject delivery. Also checks if the target is a concrete
   * match or if the endpoint subject matches as a pattern.
   *
   * @param subject - The target subject to match against
   */
  private findMatchingEndpoints(subject: string): EndpointInfo[] {
    const endpoints = this.endpointRegistry.listEndpoints();
    return endpoints.filter((ep) => matchesPattern(ep.subject, subject));
  }

  /**
   * Load reliability configuration from the config file on disk.
   *
   * Reads `{dataDir}/config.json`, parses the `reliability` key with
   * the Zod schema, and updates rate limit, circuit breaker, and
   * backpressure configs. If the file doesn't exist or contains invalid
   * JSON, the current settings are silently retained.
   */
  private loadReliabilityConfig(): void {
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const json: unknown = JSON.parse(raw);
      const obj = json as Record<string, unknown>;
      const parsed = ReliabilityConfigSchema.safeParse(obj.reliability);
      if (parsed.success) {
        this.rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...parsed.data.rateLimit };
        this.circuitBreaker.updateConfig({ ...DEFAULT_CB_CONFIG, ...parsed.data.circuitBreaker });
        this.backpressureConfig = { ...DEFAULT_BP_CONFIG, ...parsed.data.backpressure };
        // Propagate updated backpressure config to the delivery pipeline
        this.deliveryPipeline.setBackpressureConfig(this.backpressureConfig);
      }
    } catch {
      // File doesn't exist or is invalid — keep current config
    }
  }

  /**
   * Start a chokidar watcher on the config file for hot-reload.
   *
   * When `config.json` changes on disk (e.g., edited externally or by
   * another process), the reliability configuration is reloaded automatically.
   */
  private startConfigWatcher(): void {
    this.configWatcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.configWatcher.on('change', () => this.loadReliabilityConfig());
    this.configWatcher.on('add', () => this.loadReliabilityConfig());
  }

  /**
   * Assert that the relay has not been closed.
   *
   * @throws If close() has already been called
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error('RelayCore has been closed');
    }
  }
}
