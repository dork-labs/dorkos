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
import type { PublishOptions, Unsubscribe } from '@dorkos/relay';
import { logger } from '../../lib/logger.js';
import type { BindingStore } from './binding-store.js';

/** Minimal interface for AgentManager session creation. */
export interface AgentSessionCreator {
  createSession(cwd: string): Promise<{ id: string }>;
}

/** Minimal interface for RelayCore publish and subscription. */
export interface RelayCoreLike {
  publish(
    subject: string,
    payload: unknown,
    options: PublishOptions,
  ): Promise<{ messageId: string; deliveredTo: number }>;
  subscribe(pattern: string, handler: (envelope: RelayEnvelope) => void | Promise<void>): Unsubscribe;
}

export interface BindingRouterDeps {
  bindingStore: BindingStore;
  relayCore: RelayCoreLike;
  agentManager: AgentSessionCreator;
  relayDir: string;
  /** Maps a platform type (e.g., 'telegram') to the adapter instance ID from config. */
  resolveAdapterInstanceId?: (platformType: string) => string | undefined;
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
      this.handleInbound.bind(this),
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
      await this.saveSessionMap();
      logger.info(`Cleaned up ${removed} orphaned session mapping(s)`);
    }
    return removed;
  }

  private async handleInbound(envelope: RelayEnvelope): Promise<void> {
    try {
      const { adapterId, chatId, channelType } = this.parseSubject(envelope.subject);
      if (!adapterId) {
        logger.warn(`BindingRouter: could not parse subject '${envelope.subject}'`);
        return;
      }

      const binding = this.deps.bindingStore.resolve(adapterId, chatId, channelType);
      if (!binding) {
        logger.info(
          `BindingRouter: no binding for adapter=${adapterId} chat=${chatId}, skipping`,
        );
        return;
      }

      const sessionId = await this.resolveSession(binding, chatId, envelope);

      await this.deps.relayCore.publish(`relay.agent.${sessionId}`, envelope.payload, {
        from: envelope.from,
        replyTo: envelope.replyTo,
        budget: envelope.budget,
      });

      logger.info(
        `BindingRouter: routed ${envelope.subject} → relay.agent.${sessionId} (binding=${binding.id})`,
      );
    } catch (err) {
      logger.error(
        `BindingRouter: failed to route ${envelope.subject}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async resolveSession(
    binding: AdapterBinding,
    chatId: string | undefined,
    envelope: RelayEnvelope,
  ): Promise<string> {
    switch (binding.sessionStrategy) {
      case 'stateless':
        return this.createNewSession(binding);

      case 'per-user': {
        const metadata = envelope as Record<string, unknown>;
        const userId =
          (metadata.metadata as Record<string, unknown> | undefined)?.userId ??
          chatId ??
          'unknown';
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
    if (existing) return existing;

    // Deduplicate concurrent session creation for the same key
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      const sessionId = await this.createNewSession(binding);
      this.sessionMap.set(key, sessionId);
      this.inFlight.delete(key);
      this.evictOldestSessions();
      await this.saveSessionMap();
      return sessionId;
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
    const session = await this.deps.agentManager.createSession(binding.agentDir);
    return session.id;
  }

  /**
   * Parse a relay subject into adapter routing components.
   *
   * Expected patterns:
   * - `relay.human.{platformType}.{chatId}` (DM)
   * - `relay.human.{platformType}.group.{chatId}` (group chat — chatId may be negative)
   *
   * The platform type (e.g., 'telegram') is resolved to the adapter instance ID
   * via the `resolveAdapterInstanceId` dependency. Falls back to the raw
   * platform type when no resolver is provided.
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

    // Resolve platform type → adapter instance ID (e.g., 'telegram' → 'tg-bot-1')
    const adapterId =
      this.deps.resolveAdapterInstanceId?.(platformType) ?? platformType;

    // Remaining tokens form the chat context
    const remaining = parts.slice(3);
    let chatId: string | undefined;
    let channelType: string | undefined;

    if (remaining.length >= 2 && remaining[0] === 'group') {
      channelType = 'group';
      // Join remaining tokens to handle negative group IDs (e.g., '-123456')
      chatId = remaining.slice(1).join('.');
    } else if (remaining.length >= 1) {
      chatId = remaining.join('.');
    }

    return { adapterId, chatId, channelType };
  }

  private async loadSessionMap(): Promise<void> {
    try {
      const raw = await readFile(this.sessionMapPath, 'utf-8');
      const entries: [string, string][] = JSON.parse(raw);
      this.sessionMap = new Map(entries);
    } catch {
      // File doesn't exist yet or is invalid — start fresh
      this.sessionMap = new Map();
    }
  }

  private async saveSessionMap(): Promise<void> {
    await mkdir(this.deps.relayDir, { recursive: true });
    const data = JSON.stringify(Array.from(this.sessionMap.entries()));
    const tmpPath = `${this.sessionMapPath}.tmp`;
    await writeFile(tmpPath, data, 'utf-8');
    await rename(tmpPath, this.sessionMapPath);
  }

  /** Save session map, unsubscribe, and clear state. */
  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    await this.saveSessionMap();
    this.sessionMap.clear();
  }
}
