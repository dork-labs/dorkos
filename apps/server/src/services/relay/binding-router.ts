/**
 * Central routing service for adapter-agent bindings.
 *
 * Subscribes to `relay.human.*` messages, resolves adapter-agent bindings
 * via {@link BindingStore}, manages session lifecycle based on session
 * strategies (per-chat, per-user, stateless), and republishes to
 * `relay.agent.*` for ClaudeCodeAdapter to handle.
 *
 * Persists the session map to `{relayDir}/sessions.json` for recovery
 * across restarts.
 *
 * @module services/relay/binding-router
 */
import { join as pathJoin } from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';
import type { PublishOptions, Unsubscribe } from '@dorkos/relay';
import { logger } from '../../lib/logger.js';
import type { BindingStore } from './binding-store.js';
import type { AdapterMeshCoreLike } from './adapter-manager.js';

/** Minimal interface for AgentManager session creation. */
export interface AgentSessionCreator {
  createSession(cwd: string, permissionMode?: PermissionMode): Promise<{ id: string }>;
}

/** Minimal interface for RelayCore publish and subscription. */
export interface RelayCoreLike {
  publish(
    subject: string,
    payload: unknown,
    options: PublishOptions
  ): Promise<{ messageId: string; deliveredTo: number }>;
  subscribe(
    pattern: string,
    handler: (envelope: RelayEnvelope) => void | Promise<void>
  ): Unsubscribe;
}

export interface BindingRouterDeps {
  bindingStore: BindingStore;
  relayCore: RelayCoreLike;
  agentManager: AgentSessionCreator;
  meshCore: AdapterMeshCoreLike;
  relayDir: string;
  /** Optional recorder for binding routing failure events. */
  eventRecorder?: {
    insertAdapterEvent(adapterId: string, eventType: string, message: string): void;
  };
}

/**
 * Central routing service that intercepts `relay.human.*` messages,
 * resolves adapter-agent bindings, and republishes to `relay.agent.*`
 * for ClaudeCodeAdapter to handle.
 */
export class BindingRouter {
  /** Maximum number of session mappings before LRU eviction kicks in. */
  private static readonly MAX_SESSIONS = 10_000;

  /** Maps `bindingId:context` to sessionId for session reuse. */
  private sessionMap: Map<string, string> = new Map();
  /** In-flight session creation promises, keyed the same as sessionMap. */
  private inFlight = new Map<string, Promise<string>>();
  private readonly sessionMapPath: string;
  private unsubscribe?: Unsubscribe;
  /** Serializes saveSessionMap calls to prevent concurrent tmp+rename races. */
  private writeLock: Promise<void> = Promise.resolve();
  /** Guards against concurrent shutdown calls corrupting session data. */
  private isShutdown = false;

  constructor(private readonly deps: BindingRouterDeps) {
    this.sessionMapPath = pathJoin(deps.relayDir, 'sessions.json');
  }

  /** Load persisted session map, subscribe to inbound messages. */
  async init(): Promise<void> {
    await this.loadSessionMap();
    // Use `>` wildcard to match one-or-more remaining tokens.
    // `relay.human.*` only matches 3-token subjects, but adapter subjects
    // like `relay.human.telegram.123456` have 4+ tokens.
    this.unsubscribe = this.deps.relayCore.subscribe(
      'relay.human.>',
      this.handleInbound.bind(this)
    );
    logger.info(`BindingRouter initialized with ${this.sessionMap.size} persisted session(s)`);
  }

  /**
   * Remove session mappings for bindings that no longer exist.
   *
   * @param activeBindingIds - Set of currently active binding IDs
   * @returns Number of orphaned session entries removed
   */
  async cleanupOrphanedSessions(activeBindingIds: Set<string>): Promise<number> {
    let removed = 0;
    for (const [key] of this.sessionMap) {
      const bindingId = key.split(':')[0];
      if (!activeBindingIds.has(bindingId)) {
        this.sessionMap.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      try {
        await this.saveSessionMap();
      } catch (err) {
        logger.warn(
          'BindingRouter: failed to persist session map after cleanup, will retry on next write',
          err
        );
      }
      logger.info(`Cleaned up ${removed} orphaned session mapping(s)`);
    }
    return removed;
  }

  /**
   * Get active sessions for a specific binding.
   *
   * @param bindingId - Binding UUID to filter by
   * @returns Array of session entries with parsed chatId
   */
  getSessionsByBinding(
    bindingId: string
  ): Array<{ key: string; chatId: string; sessionId: string }> {
    const results: Array<{ key: string; chatId: string; sessionId: string }> = [];
    for (const [key, sessionId] of this.sessionMap) {
      if (key.startsWith(`${bindingId}:`)) {
        const parts = key.split(':');
        const chatId = parts.length >= 3 ? parts.slice(2).join(':') : 'unknown';
        results.push({ key, chatId, sessionId });
      }
    }
    return results;
  }

  /**
   * Get all active sessions across all bindings.
   *
   * @returns Array of session entries with parsed bindingId and chatId
   */
  getAllSessions(): Array<{ key: string; bindingId: string; chatId: string; sessionId: string }> {
    const results: Array<{ key: string; bindingId: string; chatId: string; sessionId: string }> =
      [];
    for (const [key, sessionId] of this.sessionMap) {
      const parts = key.split(':');
      const bindingId = parts[0] ?? 'unknown';
      const chatId = parts.length >= 3 ? parts.slice(2).join(':') : 'unknown';
      results.push({ key, bindingId, chatId, sessionId });
    }
    return results;
  }

  private async handleInbound(envelope: RelayEnvelope): Promise<void> {
    try {
      // Skip response events from agents — only route inbound human messages.
      // Agent responses are published to relay.human.* subjects for adapter delivery
      // (step 7 in relay-core), but BindingRouter (step 7b) must not re-route them
      // back to relay.agent.* as that creates a feedback loop.
      if (envelope.from.startsWith('agent:')) {
        return;
      }

      const { adapterId, chatId, channelType } = this.parseSubject(envelope.subject);
      if (!adapterId) {
        logger.warn(`BindingRouter: could not parse subject '${envelope.subject}'`);
        return;
      }

      const binding = this.deps.bindingStore.resolve(adapterId, chatId, channelType);
      if (!binding) {
        logger.info(`BindingRouter: no binding for adapter=${adapterId} chat=${chatId}, skipping`);
        return;
      }

      // Permission check: drop inbound if canReceive is false
      if (binding.canReceive === false) {
        logger.debug(
          '[BindingRouter] Dropping inbound \u2014 canReceive=false for binding %s',
          binding.id
        );
        return;
      }

      const projectPath = this.deps.meshCore.getProjectPath(binding.agentId);
      if (!projectPath) {
        logger.warn(
          `BindingRouter: agent '${binding.agentId}' not found in mesh registry, skipping`
        );
        this.deps.eventRecorder?.insertAdapterEvent(
          binding.adapterId,
          'binding.routing_failed',
          `Agent '${binding.agentId}' not found in mesh registry`
        );
        return;
      }

      const sessionId = await this.resolveSession(binding, chatId, envelope);

      const enrichedPayload =
        envelope.payload && typeof envelope.payload === 'object'
          ? {
              ...(envelope.payload as Record<string, unknown>),
              cwd: projectPath,
              __bindingPermissions: {
                canReply: binding.canReply,
                canInitiate: binding.canInitiate,
                permissionMode: binding.permissionMode ?? 'acceptEdits',
              },
            }
          : envelope.payload;

      await this.deps.relayCore.publish(`relay.agent.${sessionId}`, enrichedPayload, {
        from: envelope.from,
        replyTo: envelope.replyTo,
        budget: envelope.budget,
      });

      logger.info(
        `BindingRouter: routed ${envelope.subject} → relay.agent.${sessionId} ` +
          `(binding=${binding.id}, projectPath=${projectPath})`
      );
    } catch (err) {
      logger.error(
        `BindingRouter: failed to route ${envelope.subject}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  private async resolveSession(
    binding: AdapterBinding,
    chatId: string | undefined,
    envelope: RelayEnvelope
  ): Promise<string> {
    switch (binding.sessionStrategy) {
      case 'stateless':
        return this.createNewSession(binding);

      case 'per-user': {
        const metadata = envelope as Record<string, unknown>;
        const userId =
          (metadata.metadata as Record<string, unknown> | undefined)?.userId ?? chatId ?? 'unknown';
        const key = `${binding.id}:user:${String(userId)}`;
        return this.getOrCreateSession(key, binding);
      }

      case 'per-chat':
      default: {
        const key = `${binding.id}:chat:${chatId ?? 'default'}`;
        return this.getOrCreateSession(key, binding);
      }
    }
  }

  private async getOrCreateSession(key: string, binding: AdapterBinding): Promise<string> {
    const existing = this.sessionMap.get(key);
    if (existing) {
      // Refresh LRU position so active sessions are not evicted
      this.sessionMap.delete(key);
      this.sessionMap.set(key, existing);
      return existing;
    }

    // Deduplicate concurrent session creation for the same key
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const sessionId = await this.createNewSession(binding);
        this.sessionMap.set(key, sessionId);
        this.evictOldestSessions();
        try {
          await this.saveSessionMap();
        } catch (err) {
          logger.warn(
            'BindingRouter: failed to persist session map, will retry on next write',
            err
          );
        }
        return sessionId;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Evict oldest session map entries when size exceeds MAX_SESSIONS.
   *
   * Uses Map insertion order as a proxy for LRU — oldest entries are evicted first.
   */
  private evictOldestSessions(): void {
    const excess = this.sessionMap.size - BindingRouter.MAX_SESSIONS;
    if (excess <= 0) return;
    const keys = this.sessionMap.keys();
    for (let i = 0; i < excess; i++) {
      const { value } = keys.next();
      if (value) this.sessionMap.delete(value);
    }
    logger.info(`BindingRouter: evicted ${excess} oldest session mapping(s)`);
  }

  private async createNewSession(binding: AdapterBinding): Promise<string> {
    const projectPath = this.deps.meshCore.getProjectPath(binding.agentId);
    if (!projectPath) {
      throw new Error(`Agent '${binding.agentId}' not found in mesh registry`);
    }
    logger.debug('[BindingRouter] createNewSession', {
      bindingId: binding.id,
      adapterId: binding.adapterId,
      agentId: binding.agentId,
      projectPath,
    });
    const session = await this.deps.agentManager.createSession(projectPath, binding.permissionMode);
    return session.id;
  }

  /**
   * Parse a relay subject into adapter routing components.
   *
   * Expected patterns (instance-aware format):
   * - `relay.human.{platformType}.{instanceId}.{chatId}` (DM)
   * - `relay.human.{platformType}.{instanceId}.group.{chatId}` (group chat)
   *
   * The instance ID segment is the adapter's unique ID and is used directly
   * as the `adapterId` for binding resolution.
   */
  private parseSubject(subject: string): {
    adapterId?: string;
    chatId?: string;
    channelType?: string;
  } {
    const parts = subject.split('.');
    if (parts[0] !== 'relay' || parts[1] !== 'human') return {};

    const platformType = parts[2];
    if (!platformType) return {};

    const remaining = parts.slice(3);

    // First remaining token is the instance ID (adapter ID)
    const instanceId = remaining[0];
    if (!instanceId) return {};

    const adapterId = instanceId;
    const afterInstance = remaining.slice(1);

    let chatId: string | undefined;
    let channelType: string | undefined;

    if (afterInstance.length >= 2 && afterInstance[0] === 'group') {
      channelType = 'group';
      chatId = afterInstance.slice(1).join('.');
    } else if (afterInstance.length >= 1) {
      chatId = afterInstance.join('.');
    }

    return { adapterId, chatId, channelType };
  }

  private async loadSessionMap(): Promise<void> {
    try {
      const raw = await readFile(this.sessionMapPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      // Validate shape: must be an array of [string, string] tuples
      if (!Array.isArray(parsed)) {
        logger.warn('BindingRouter: sessionMap is not an array, starting fresh');
        this.sessionMap = new Map();
        return;
      }

      const valid = parsed.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string'
      );

      if (valid.length < parsed.length) {
        logger.warn(
          `BindingRouter: discarded ${parsed.length - valid.length} malformed sessionMap entries`
        );
      }

      this.sessionMap = new Map(valid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        logger.debug('BindingRouter: no sessions.json found, starting with empty session map');
      } else {
        logger.warn('BindingRouter: failed to load sessions.json, starting fresh', err);
      }
      this.sessionMap = new Map();
    }
  }

  private saveSessionMap(): Promise<void> {
    this.writeLock = this.writeLock.then(
      () => this.doSaveSessionMap(),
      () => this.doSaveSessionMap()
    );
    return this.writeLock;
  }

  /** Atomic tmp+rename write of the session map. Must be serialized via writeLock. */
  private async doSaveSessionMap(): Promise<void> {
    await mkdir(this.deps.relayDir, { recursive: true });
    const data = JSON.stringify(Array.from(this.sessionMap.entries()));
    const tmpPath = `${this.sessionMapPath}.tmp`;
    await writeFile(tmpPath, data, 'utf-8');
    await rename(tmpPath, this.sessionMapPath);
  }

  /** Save session map, unsubscribe, and clear state. Idempotent — safe to call multiple times. */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;
    this.unsubscribe?.();
    try {
      await this.saveSessionMap();
    } catch (err) {
      logger.warn('BindingRouter: failed to persist session map on shutdown', err);
    }
    this.sessionMap.clear();
  }
}
