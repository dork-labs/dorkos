/**
 * Main entry point for the Relay message bus.
 *
 * Composes all sub-modules (EndpointRegistry, SubscriptionRegistry,
 * MaildirStore, SqliteIndex, DeadLetterQueue, AccessControl, SignalEmitter,
 * budget-enforcer) into a single cohesive API surface.
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
import { validateSubject, matchesPattern } from './subject-matcher.js';
import { enforceBudget, createDefaultBudget } from './budget-enforcer.js';
import { EndpointRegistry } from './endpoint-registry.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import { MaildirStore } from './maildir-store.js';
import { SqliteIndex } from './sqlite-index.js';
import { DeadLetterQueue } from './dead-letter-queue.js';
import { AccessControl } from './access-control.js';
import { SignalEmitter } from './signal-emitter.js';
import { checkRateLimit, DEFAULT_RATE_LIMIT_CONFIG } from './rate-limiter.js';
import { CircuitBreakerManager, DEFAULT_CB_CONFIG } from './circuit-breaker.js';
import { checkBackpressure, DEFAULT_BP_CONFIG } from './backpressure.js';
import type { RelayEnvelope, RelayBudget, Signal } from '@dorkos/shared/relay-schemas';
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
}

/** Internal result from delivering to a single endpoint. */
interface EndpointDeliveryResult {
  delivered: boolean;
  rejected?: {
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  };
  pressure?: number;
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
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly generateUlid = monotonicFactory();
  private readonly opts: ResolvedOptions;
  private rateLimitConfig: RateLimitConfig;
  private circuitBreaker: CircuitBreakerManager;
  private backpressureConfig: BackpressureConfig;
  private readonly configPath: string;
  private configWatcher: FSWatcher | null = null;
  private closed = false;
  private readonly adapterRegistry?: AdapterRegistryLike;

  constructor(options?: RelayOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.opts = {
      dataDir,
      maxHops: options?.maxHops ?? DEFAULT_MAX_HOPS,
      defaultTtlMs: options?.defaultTtlMs ?? DEFAULT_TTL_MS,
      defaultCallBudget: options?.defaultCallBudget ?? DEFAULT_CALL_BUDGET,
    };

    const mailboxesDir = path.join(dataDir, 'mailboxes');
    const dbPath = path.join(dataDir, 'index.db');

    this.endpointRegistry = new EndpointRegistry(dataDir);
    this.subscriptionRegistry = new SubscriptionRegistry(dataDir);
    this.maildirStore = new MaildirStore({ rootDir: mailboxesDir });
    this.sqliteIndex = new SqliteIndex({ dbPath });
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

    // Config hot-reload: load from disk then watch for changes
    this.configPath = path.join(dataDir, 'config.json');
    this.loadReliabilityConfig();
    this.startConfigWatcher();

    // Wire adapter registry — set this as the RelayPublisher for inbound messages
    if (options?.adapterRegistry) {
      this.adapterRegistry = options.adapterRegistry;
      this.adapterRegistry.setRelay(this);
    }
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

    // 5. Find matching endpoints
    const matchingEndpoints = this.findMatchingEndpoints(subject);

    // 6. Deliver to each matching endpoint
    if (matchingEndpoints.length === 0) {
      // No matching endpoints — send to DLQ for the sender's information
      // We still create a hash for DLQ storage based on subject
      const { hashSubject } = await import('./endpoint-registry.js');
      const subjectHash = hashSubject(subject);
      await this.maildirStore.ensureMaildir(subjectHash);
      await this.deadLetterQueue.reject(subjectHash, envelope, 'no matching endpoints');
      return { messageId, deliveredTo: 0 };
    }

    let deliveredTo = 0;
    const rejected: PublishResult['rejected'] = [];
    const mailboxPressure: Record<string, number> = {};

    for (const endpoint of matchingEndpoints) {
      const result = await this.deliverToEndpoint(endpoint, envelope);

      if (result.delivered) {
        deliveredTo++;
      }
      if (result.rejected) {
        rejected.push(result.rejected);
      }
      if (result.pressure !== undefined) {
        mailboxPressure[endpoint.hash] = result.pressure;
      }
    }

    // 7. Deliver to matching external adapter (after Maildir endpoints)
    if (this.adapterRegistry) {
      try {
        const adapterDelivered = await this.adapterRegistry.deliver(subject, envelope);
        if (adapterDelivered) {
          deliveredTo++;
        }
      } catch (err) {
        // Adapter delivery failure is non-fatal — log but don't fail the overall publish
        console.warn('RelayCore: adapter delivery failed:', err instanceof Error ? err.message : err);
      }
    }

    return {
      messageId,
      deliveredTo,
      ...(rejected.length > 0 && { rejected }),
      ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
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
    await this.startWatcher(info);
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
      this.stopWatcher(endpoint.hash);
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
    for (const [hash, watcher] of this.watchers) {
      await watcher.close();
      this.watchers.delete(hash);
    }

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
   * Deliver an envelope to a single endpoint.
   *
   * Pipeline order:
   * 1. Backpressure check — rejects if mailbox is full, emits warning signal
   * 2. Circuit breaker check — rejects if breaker is OPEN for this endpoint
   * 3. Budget enforcement — rejects expired/over-hop/over-call messages to DLQ
   * 4. Maildir delivery — writes envelope file, records CB success/failure
   * 5. SQLite indexing + synchronous handler dispatch
   *
   * All return paths include `pressure` so the publish() aggregator can
   * build the `mailboxPressure` map for every endpoint.
   *
   * @param endpoint - The target endpoint
   * @param envelope - The envelope to deliver
   * @returns An EndpointDeliveryResult with delivery status, rejection info, and pressure
   */
  private async deliverToEndpoint(
    endpoint: EndpointInfo,
    envelope: RelayEnvelope,
  ): Promise<EndpointDeliveryResult> {
    // 1. Backpressure check (before circuit breaker and budget)
    const newCount = this.sqliteIndex.countNewByEndpoint(endpoint.hash);
    const bpResult = checkBackpressure(newCount, this.backpressureConfig);

    if (bpResult.pressure >= this.backpressureConfig.pressureWarningAt) {
      this.signalEmitter.emit(endpoint.subject, {
        type: 'backpressure',
        state: bpResult.allowed ? 'warning' : 'critical',
        endpointSubject: endpoint.subject,
        timestamp: new Date().toISOString(),
        data: { pressure: bpResult.pressure, currentSize: bpResult.currentSize },
      });
    }

    if (!bpResult.allowed) {
      return {
        delivered: false,
        rejected: { endpointHash: endpoint.hash, reason: 'backpressure' },
        pressure: bpResult.pressure,
      };
    }

    // 2. Circuit breaker check (after backpressure, before budget)
    const cbResult = this.circuitBreaker.check(endpoint.hash);
    if (!cbResult.allowed) {
      return {
        delivered: false,
        rejected: { endpointHash: endpoint.hash, reason: 'circuit_open' },
        pressure: bpResult.pressure,
      };
    }

    // 3. Budget enforcement
    const budgetResult = enforceBudget(envelope, endpoint.subject);
    if (!budgetResult.allowed) {
      await this.deadLetterQueue.reject(
        endpoint.hash,
        envelope,
        budgetResult.reason ?? 'budget enforcement failed',
      );
      return {
        delivered: false,
        rejected: { endpointHash: endpoint.hash, reason: 'budget_exceeded' },
        pressure: bpResult.pressure,
      };
    }

    // Build the envelope with updated budget for this specific delivery
    const deliveryEnvelope: RelayEnvelope = {
      ...envelope,
      budget: budgetResult.updatedBudget!,
    };

    // 4. Deliver to Maildir
    const deliverResult = await this.maildirStore.deliver(endpoint.hash, deliveryEnvelope);
    if (!deliverResult.ok) {
      this.circuitBreaker.recordFailure(endpoint.hash);
      await this.deadLetterQueue.reject(
        endpoint.hash,
        envelope,
        `delivery failed: ${deliverResult.error}`,
      );
      return { delivered: false, pressure: bpResult.pressure };
    }

    // Record successful delivery for circuit breaker
    this.circuitBreaker.recordSuccess(endpoint.hash);

    // Index in SQLite
    this.sqliteIndex.insertMessage({
      id: deliverResult.messageId,
      subject: deliveryEnvelope.subject,
      sender: deliveryEnvelope.from,
      endpointHash: endpoint.hash,
      status: 'new',
      createdAt: deliveryEnvelope.createdAt,
      ttl: deliveryEnvelope.budget.ttl,
    });

    // Synchronous fast-path: dispatch to matching subscription handlers
    // This avoids relying on chokidar timing for locally-published messages
    await this.dispatchToSubscribers(endpoint, deliverResult.messageId, deliveryEnvelope);

    return { delivered: true, pressure: bpResult.pressure };
  }

  /**
   * Dispatch a delivered envelope to all matching subscription handlers.
   *
   * Claims the message from `new/` to `cur/`, invokes all handlers,
   * then completes (removes from `cur/`) on success or moves to `failed/`
   * on error.
   *
   * @param endpoint - The endpoint that received the message
   * @param messageId - The Maildir-assigned message ID (ULID filename)
   * @param envelope - The delivered envelope
   */
  private async dispatchToSubscribers(
    endpoint: EndpointInfo,
    messageId: string,
    envelope: RelayEnvelope,
  ): Promise<void> {
    const handlers = this.subscriptionRegistry.getSubscribers(endpoint.subject);
    if (handlers.length === 0) return;

    // Claim the message (move from new/ to cur/)
    const claimResult = await this.maildirStore.claim(endpoint.hash, messageId);
    if (!claimResult.ok) return;

    try {
      await Promise.all(handlers.map((handler) => handler(claimResult.envelope)));

      // All handlers succeeded — complete the message
      await this.maildirStore.complete(endpoint.hash, messageId);
      this.sqliteIndex.updateStatus(messageId, 'cur');
    } catch (err) {
      // Handler failed — move to failed/ and record for circuit breaker
      const reason = err instanceof Error ? err.message : String(err);
      await this.maildirStore.fail(endpoint.hash, messageId, reason);
      this.sqliteIndex.updateStatus(messageId, 'failed');
      this.circuitBreaker.recordFailure(endpoint.hash);
    }
  }

  /**
   * Start a chokidar watcher on an endpoint's `new/` directory.
   *
   * When a new file is created in `new/`, the watcher reads the envelope,
   * finds matching subscription handlers, and dispatches to them. After
   * successful handler invocation, the message is claimed and completed.
   * On handler error, the message is moved to `failed/`.
   *
   * Returns a promise that resolves once the watcher is ready and
   * actively monitoring the directory.
   *
   * @param endpoint - The endpoint to watch
   */
  private startWatcher(endpoint: EndpointInfo): Promise<void> {
    if (this.watchers.has(endpoint.hash)) return Promise.resolve();

    const newDir = path.join(endpoint.maildirPath, 'new');
    const watcher = chokidar.watch(newDir, {
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('add', (filePath: string) => {
      void this.handleNewMessage(endpoint, filePath);
    });

    this.watchers.set(endpoint.hash, watcher);

    // Wait for the watcher to be fully ready before returning
    return new Promise<void>((resolve) => {
      watcher.on('ready', () => resolve());
    });
  }

  /**
   * Handle a new message file appearing in an endpoint's `new/` directory.
   *
   * Reads the envelope, finds matching subscription handlers, invokes them,
   * then claims and completes the message. On handler error, the message
   * is moved to `failed/`.
   *
   * @param endpoint - The endpoint that received the message
   * @param filePath - The path to the new message file
   */
  private async handleNewMessage(endpoint: EndpointInfo, filePath: string): Promise<void> {
    // Extract message ID from filename (strip .json extension)
    const filename = path.basename(filePath);
    if (!filename.endsWith('.json')) return;
    const messageId = filename.slice(0, -5);

    // Find matching subscription handlers
    const handlers = this.subscriptionRegistry.getSubscribers(endpoint.subject);
    if (handlers.length === 0) return;

    // Claim the message (move from new/ to cur/)
    const claimResult = await this.maildirStore.claim(endpoint.hash, messageId);
    if (!claimResult.ok) return;

    // Invoke all handlers
    try {
      await Promise.all(handlers.map((handler) => handler(claimResult.envelope)));

      // All handlers succeeded — complete the message (remove from cur/)
      await this.maildirStore.complete(endpoint.hash, messageId);
      this.sqliteIndex.updateStatus(messageId, 'cur');
    } catch (err) {
      // Handler failed — move to failed/
      const reason = err instanceof Error ? err.message : String(err);
      await this.maildirStore.fail(endpoint.hash, messageId, reason);
      this.sqliteIndex.updateStatus(messageId, 'failed');
    }
  }

  /**
   * Stop the chokidar watcher for an endpoint.
   *
   * @param endpointHash - The hash of the endpoint whose watcher to stop
   */
  private stopWatcher(endpointHash: string): void {
    const watcher = this.watchers.get(endpointHash);
    if (watcher) {
      void watcher.close();
      this.watchers.delete(endpointHash);
    }
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
