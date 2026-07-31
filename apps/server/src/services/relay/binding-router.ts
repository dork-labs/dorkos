/**
 * Central routing service for adapter-agent bindings.
 *
 * Subscribes to `relay.human.*` messages, resolves adapter-agent bindings
 * via {@link BindingStore}, manages session lifecycle based on session
 * strategies (per-chat, per-user, stateless), and republishes to
 * `relay.agent.<runtimeType>.<sessionId>` for runtime-specific adapters to handle.
 *
 * Dispatch is runtime-neutral: the router derives the runtime type from
 * `runtimeRegistry.getSessionRuntimeType(sessionId)` and embeds it in the
 * outgoing subject. No adapter class is referenced by name in dispatch logic —
 * adding a new runtime adapter does not require changes to this file.
 *
 * Persists the session map to `{relayDir}/sessions.json` for recovery
 * across restarts.
 *
 * @module services/relay/binding-router
 */
import { join as pathJoin } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import type { BindingTestResult } from '@dorkos/shared/relay-schemas';
import type { RelayFlowEvent } from '@dorkos/shared/relay-schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';
import type {
  ChatNoticeReason,
  ChatNoticeSender,
  PublishOptions,
  PublishResult,
  SubscriberVerdict,
  Unsubscribe,
} from '@dorkos/relay';
import { runtimeSessionSubject, legacyAgentSubject } from '@dorkos/relay';
import { logger } from '../../lib/logger.js';
import type { BindingStore } from './binding-store.js';
import type { AdapterMeshCoreLike } from './adapter-manager.js';
import { parseHumanSubject } from './human-subject.js';

/**
 * The identity fields an inbound chat payload carries for the person who wrote
 * the message. Slack writes `userId`; Telegram writes `fromId`.
 *
 * Read out of `payload.platformData`, which is `z.unknown()` in the envelope
 * schema, so it is parsed rather than cast. Numeric ids (Telegram's are
 * numbers) are coerced to their string form; anything else is treated as
 * absent.
 */
const PlatformIdentitySchema = z
  .object({
    /** Slack's author id (`U…`). */
    userId: z.union([z.string().min(1), z.number()]).optional(),
    /** Telegram's author id (`from.id`). */
    fromId: z.union([z.string().min(1), z.number()]).optional(),
  })
  .partial();

/**
 * The stable per-person key inside one chat, or `undefined` when the message
 * carries none.
 *
 * The `per-user` session strategy used to read `envelope.metadata?.userId` — a
 * field {@link RelayEnvelope} does not have — so it always resolved to the chat
 * id and was byte-identical to `per-chat`. In a group chat that put everyone's
 * conversation in one session: whatever one person said, the next person's turn
 * could read. The real id has always been in the payload the adapters build
 * (`platformData.userId` on Slack, `platformData.fromId` on Telegram); this
 * reads it from there.
 *
 * @param payload - The relay envelope payload as it arrived.
 * @returns The platform user id as a string, or `undefined`.
 */
function extractPlatformUserId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const platformData = (payload as { platformData?: unknown }).platformData;
  const parsed = PlatformIdentitySchema.safeParse(platformData);
  if (!parsed.success) return undefined;
  const raw = parsed.data.userId ?? parsed.data.fromId;
  if (raw === undefined) return undefined;
  const asString = String(raw);
  return asString.length > 0 ? asString : undefined;
}

/** Minimal interface for AgentManager session creation. */
export interface AgentSessionCreator {
  /**
   * @param cwd - Working directory for the new session.
   * @param permissionMode - Required, and deliberately so: an optional mode here
   *   invited a second `?? 'acceptEdits'` fallback to decide it (DOR-604). The
   *   caller resolves it from the binding, which always carries one.
   */
  createSession(cwd: string, permissionMode: PermissionMode): Promise<{ id: string }>;
}

/** Minimal interface for RelayCore publish and subscription. */
export interface RelayCoreLike {
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<PublishResult>;
  subscribe(
    pattern: string,
    handler: (
      envelope: RelayEnvelope
    ) => void | SubscriberVerdict | Promise<void | SubscriberVerdict>
  ): Unsubscribe;
}

/**
 * Minimal runtime-type lookup interface.
 *
 * Deliberately narrower than the full `RuntimeRegistry` — the router only
 * needs the session → runtime-type mapping. Tests can inject a fake.
 */
export interface RuntimeTypeResolver {
  /** Return the runtime type for a session (e.g. `'claude-code'`, `'test-mode'`). */
  getSessionRuntimeType(sessionId: string): Promise<string>;
}

export interface BindingRouterDeps {
  bindingStore: BindingStore;
  relayCore: RelayCoreLike;
  agentManager: AgentSessionCreator;
  meshCore: AdapterMeshCoreLike;
  relayDir: string;
  /**
   * Optional runtime-type resolver. When provided, dispatch subjects are
   * scoped to the session's runtime type (`relay.agent.<runtimeType>.<sessionId>`).
   * When omitted, dispatch falls back to the legacy `relay.agent.<sessionId>`
   * format — preserved for environments where the consolidated DB is not yet
   * wired (e.g. early boot, some tests).
   */
  runtimeResolver?: RuntimeTypeResolver;
  /** Optional recorder for binding routing failure events. */
  eventRecorder?: {
    insertAdapterEvent(adapterId: string, eventType: string, message: string): void;
  };
  /**
   * Tells the person, in the chat they wrote in, that their message was not
   * passed on. Optional only so unit tests can leave it out; in the server it is
   * always wired, because a refusal nobody is told about is the bug this
   * router had for every one of its drop paths (DOR-789).
   */
  chatNotice?: ChatNoticeSender;
  /**
   * Optional callback fired once per delivered inbound message (`deliveredTo
   * > 0`), used solely to animate the topology pulse. Injected rather than
   * imported so the router stays unit-testable and free of the SSE
   * singleton — mirrors {@link eventRecorder}.
   */
  onFlow?: (flow: RelayFlowEvent) => void;
}

/**
 * Central routing service that intercepts `relay.human.*` messages,
 * resolves adapter-agent bindings, and republishes to
 * `relay.agent.<runtimeType>.<sessionId>` for the appropriate runtime adapter
 * to handle. Routing is purely data-driven — the router never references any
 * adapter class by name.
 */
/**
 * One live chat session, as the rest of the server needs to read it.
 *
 * `scope` is the field that stops a lie the old shape told: a session key is
 * either `…:chat:<chatId>` or `…:user:<userId>`, and everything downstream read
 * the tail as a chat id regardless. Under the per-user strategy that meant a
 * group notification was addressed to a person's private id — the notice landed
 * in a DM, or nowhere.
 */
export interface BindingSessionEntry {
  /** The raw session-map key. */
  key: string;
  /** Whether this session belongs to a chat or to one person. */
  scope: 'chat' | 'user';
  /** The chat this session belongs to. Present when `scope` is `'chat'`. */
  chatId?: string;
  /** The person this session belongs to. Present when `scope` is `'user'`. */
  userId?: string;
  sessionId: string;
  /**
   * When a message last flowed through this session (epoch ms).
   *
   * `0` for a session restored from a file written before this field existed —
   * known to exist, never yet seen active. Recency comparisons treat it as the
   * oldest possible, which is what it is.
   */
  lastActivityAt: number;
}

/** What the router remembers about one session. */
interface SessionRecord {
  sessionId: string;
  /** Epoch ms of the last message routed through it; 0 when never observed. */
  lastActivityAt: number;
}

export class BindingRouter {
  /** Maximum number of session mappings before LRU eviction kicks in. */
  private static readonly MAX_SESSIONS = 10_000;

  /** Shortest gap between two activity-driven writes of the session file. */
  private static readonly ACTIVITY_SAVE_THROTTLE_MS = 60_000;

  /** Maps `bindingId:(chat|user):id` to the session that serves it. */
  private sessionMap: Map<string, SessionRecord> = new Map();
  /** When session activity was last flushed to disk. */
  private lastActivitySaveAt = 0;
  /** In-flight session creation promises, keyed the same as sessionMap. */
  private inFlight = new Map<string, Promise<string>>();
  private readonly sessionMapPath: string;
  private unsubscribe?: Unsubscribe;
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
   * Run a synthetic test probe through the routing pipeline without invoking the agent.
   *
   * Exercises binding resolution, enabled state, and agent lookup — the same
   * checks that {@link handleInbound} performs — but returns a verdict instead
   * of dispatching to `relay.agent.*`.
   *
   * @param bindingId - The binding UUID to test
   * @returns Routing verdict with `ok`, `resolved`, timing, and diagnostic fields
   */
  testBinding(bindingId: string): BindingTestResult {
    const start = performance.now();

    const binding = this.deps.bindingStore.getById(bindingId);
    if (!binding) {
      return {
        ok: false,
        resolved: false,
        latencyMs: Math.round(performance.now() - start),
        reason: 'Binding not found',
      };
    }

    if (!binding.enabled) {
      return {
        ok: false,
        resolved: false,
        latencyMs: Math.round(performance.now() - start),
        reason: 'Binding is paused (enabled=false)',
      };
    }

    // Verify the agent exists in the mesh registry
    const projectPath = this.deps.meshCore.getProjectPath(binding.agentId);
    if (!projectPath) {
      return {
        ok: false,
        resolved: false,
        latencyMs: Math.round(performance.now() - start),
        reason: `Agent '${binding.agentId}' not found in mesh registry`,
      };
    }

    return {
      ok: true,
      resolved: true,
      latencyMs: Math.round(performance.now() - start),
      wouldDeliverTo: binding.agentId,
      details: 'Routing succeeded. No agent was invoked.',
    };
  }

  /**
   * Get active sessions for a specific binding.
   *
   * @param bindingId - Binding UUID to filter by
   * @returns Session entries, each saying whether it is keyed by chat or person
   */
  getSessionsByBinding(bindingId: string): BindingSessionEntry[] {
    const results: BindingSessionEntry[] = [];
    for (const [key, record] of this.sessionMap) {
      if (key.startsWith(`${bindingId}:`)) results.push(describeSession(key, record));
    }
    return results;
  }

  /**
   * Get all active sessions across all bindings.
   *
   * @returns Session entries with their binding id
   */
  getAllSessions(): Array<BindingSessionEntry & { bindingId: string }> {
    const results: Array<BindingSessionEntry & { bindingId: string }> = [];
    for (const [key, record] of this.sessionMap) {
      results.push({ bindingId: key.split(':')[0] ?? 'unknown', ...describeSession(key, record) });
    }
    return results;
  }

  /**
   * Route one inbound chat message, or say why it was not routed.
   *
   * Every refusal path does three things now, where it used to do one:
   *
   * 1. **Returns a verdict.** A handler that dropped the message no longer
   *    counts as a delivery, so the publish trace stops reading `delivered`
   *    for a turn that never ran.
   * 2. **Tells the person.** A one-line notice goes back out through the
   *    adapter, into the chat they wrote in — except when nothing is bound
   *    there at all, where this machine has no standing to speak (see
   *    `chat-notice.ts`).
   * 3. **Keeps the log line**, for the operator reading the server side.
   *
   * @param envelope - The inbound `relay.human.*` envelope.
   * @returns Nothing when routed; a {@link SubscriberVerdict} when refused.
   */
  private async handleInbound(envelope: RelayEnvelope): Promise<void | SubscriberVerdict> {
    try {
      // Skip messages this server produced. Agent replies (`agent:*`) are
      // published to relay.human.* subjects for adapter delivery, and system
      // notices (`relay.system.*`) — including the refusal notices below — go
      // out the same way. Routing either back to an agent is a feedback loop:
      // the notice would arrive as a fresh prompt.
      if (envelope.from.startsWith('agent:') || envelope.from.startsWith('relay.system.')) {
        return { handled: false, reason: 'not an inbound message from a person' };
      }

      const { adapterId, chatId, channelType } = parseHumanSubject(envelope.subject);
      if (!adapterId) {
        logger.warn(`BindingRouter: could not parse subject '${envelope.subject}'`);
        return { handled: false, reason: `unreadable chat subject '${envelope.subject}'` };
      }

      const binding = this.deps.bindingStore.resolve(adapterId, chatId, channelType);
      if (!binding) {
        // Deliberately silent in-chat: nobody connected this conversation to
        // anything here, so there is no agent whose silence needs explaining,
        // and speaking would be this machine starting a conversation it has no
        // consent for. The trace and the log carry it instead.
        logger.info(`BindingRouter: no binding for adapter=${adapterId} chat=${chatId}, skipping`);
        return { handled: false, reason: 'no binding connects this chat to an agent' };
      }

      // Skip paused bindings — they do not participate in routing
      if (binding.enabled === false) {
        return this.refuse(envelope, binding, 'binding_paused', `binding ${binding.id} is paused`);
      }

      // Permission check: drop inbound if canReceive is false
      if (binding.canReceive === false) {
        return this.refuse(
          envelope,
          binding,
          'receive_denied',
          `binding ${binding.id} is set not to send messages to its agent`
        );
      }

      const projectPath = this.deps.meshCore.getProjectPath(binding.agentId);
      if (!projectPath) {
        this.deps.eventRecorder?.insertAdapterEvent(
          binding.adapterId,
          'binding.routing_failed',
          `Agent '${binding.agentId}' not found in mesh registry`
        );
        return this.refuse(
          envelope,
          binding,
          'agent_missing',
          `agent '${binding.agentId}' is not in the mesh registry`
        );
      }

      let sessionId: string;
      try {
        sessionId = await this.resolveSession(binding, chatId, envelope);
      } catch (err) {
        // A session that cannot be created is the one refusal that used to
        // reach only the catch-all below, where it became a log line with no
        // binding attached and no way for the person to know.
        return this.refuse(
          envelope,
          binding,
          'session_failed',
          err instanceof Error ? err.message : String(err)
        );
      }

      const enrichedPayload =
        envelope.payload && typeof envelope.payload === 'object'
          ? {
              ...(envelope.payload as Record<string, unknown>),
              cwd: projectPath,
              __bindingPermissions: {
                canReply: binding.canReply,
                canInitiate: binding.canInitiate,
                // No fallback: `AdapterBindingSchema` resolves this on parse and
                // `safe-defaults.ts` carries legacy entries forward, so a
                // binding always carries a mode (DOR-604). The consumer
                // (`agent-handler.ts`) does keep one, because it reads this back
                // off the wire as JSON where the field can genuinely be absent —
                // that one lands on the prompting mode, not `acceptEdits`.
                permissionMode: binding.permissionMode,
              },
            }
          : envelope.payload;

      const dispatchSubject = await this.buildDispatchSubject(sessionId);

      const { deliveredTo, rejected } = await this.deps.relayCore.publish(
        dispatchSubject,
        enrichedPayload,
        {
          from: envelope.from,
          replyTo: envelope.replyTo,
          budget: envelope.budget,
        }
      );

      // One accepted inbound message = one pulse. deliveredTo === 0 means the
      // message was budget-rejected (DOR-260), consent-denied (DOR-277), or had
      // no subscriber — it never reached the agent, so it must not pulse.
      //
      // What a pulse means, exactly: the runtime ACCEPTED the turn. Agent
      // deliveries are detached — an agent turn outlives any publish timeout —
      // so nothing here can wait for the turn to run. A turn that is accepted
      // and then fails (adapter at capacity, a thrown runtime) is dead-lettered
      // and the person is told through the chat-failure notice wired into
      // `AdapterDelivery`, not by retracting this pulse.
      if (deliveredTo > 0) {
        this.deps.onFlow?.({
          bindingId: binding.id,
          adapterId: binding.adapterId,
          agentId: binding.agentId,
          direction: 'inbound',
          at: new Date().toISOString(),
        });
        this.touchSession(binding, chatId, envelope);
        logger.info(
          `BindingRouter: dispatched ${envelope.subject} → ${dispatchSubject} ` +
            `(binding=${binding.id}, projectPath=${projectPath})`
        );
        return;
      }

      // Accepted by nobody. The gate that said so names itself in `rejected`;
      // that is the honest thing to put in front of the person, rather than a
      // silence that looks exactly like an agent thinking.
      const gate = rejected?.[0]?.reason;
      const noticeReason: ChatNoticeReason =
        gate === 'rate_limited'
          ? 'rate_limited'
          : gate === 'budget_exceeded'
            ? 'budget_exceeded'
            : 'delivery_failed';
      return this.refuse(
        envelope,
        binding,
        noticeReason,
        `the runtime did not accept the turn${gate ? ` (${gate})` : ''}`
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`BindingRouter: failed to route ${envelope.subject}:`, reason);
      return { handled: false, reason };
    }
  }

  /**
   * Refuse one inbound message: log it, tell the person, and report the drop.
   *
   * @param envelope - The message being dropped.
   * @param binding - The binding it resolved to.
   * @param notice - Which one-line notice the person should read.
   * @param reason - The operator-facing reason, recorded on the trace.
   */
  private async refuse(
    envelope: RelayEnvelope,
    binding: AdapterBinding,
    notice: ChatNoticeReason,
    reason: string
  ): Promise<SubscriberVerdict> {
    logger.warn(`BindingRouter: dropped ${envelope.subject} (binding=${binding.id}): ${reason}`);
    // The binding is named rather than re-resolved: this router just resolved
    // it from the store for this very message, and it is the only caller that
    // can honestly say so. It is also what lets a PAUSED binding be spoken
    // about at all — the sender's own resolver requires an enabled one, and
    // "this chat is paused" is exactly what a paused chat needs to hear.
    await this.deps.chatNotice?.(envelope.subject, notice, { binding: { id: binding.id } });
    return { handled: false, reason };
  }

  /**
   * Build the runtime-scoped dispatch subject for a session.
   *
   * Uses the injected `runtimeResolver` when available, producing
   * `relay.agent.<runtimeType>.<sessionId>`. Falls back to the legacy
   * `relay.agent.<sessionId>` subject when no resolver is configured or
   * the lookup throws — routing must never be blocked by a transient
   * DB error, so the legacy format is a safety net, not a preference.
   */
  private async buildDispatchSubject(sessionId: string): Promise<string> {
    const resolver = this.deps.runtimeResolver;
    if (!resolver) {
      return legacyAgentSubject(sessionId);
    }
    try {
      const runtimeType = await resolver.getSessionRuntimeType(sessionId);
      return runtimeSessionSubject(runtimeType, sessionId);
    } catch (err) {
      logger.warn(
        `BindingRouter: runtime-type lookup failed for session '${sessionId}', ` +
          `falling back to legacy subject`,
        err instanceof Error ? err.message : err
      );
      return legacyAgentSubject(sessionId);
    }
  }

  private async resolveSession(
    binding: AdapterBinding,
    chatId: string | undefined,
    envelope: RelayEnvelope
  ): Promise<string> {
    const key = this.sessionKeyFor(binding, chatId, envelope);
    if (!key) return this.createNewSession(binding);
    return this.getOrCreateSession(key, binding);
  }

  /**
   * The session-map key one message belongs to, or `undefined` for the
   * stateless strategy, which keeps no session to key.
   *
   * @param binding - The resolved binding.
   * @param chatId - The chat the message came from.
   * @param envelope - The inbound envelope (carries the platform user id).
   */
  private sessionKeyFor(
    binding: AdapterBinding,
    chatId: string | undefined,
    envelope: RelayEnvelope
  ): string | undefined {
    if (binding.sessionStrategy === 'stateless') return undefined;

    if (binding.sessionStrategy === 'per-user') {
      const userId = extractPlatformUserId(envelope.payload);
      if (!userId) {
        // No platform identity on this message — fall back to the chat, which
        // is what per-chat would have done. Said out loud because a per-user
        // binding silently behaving as per-chat is the bug this replaced.
        logger.warn(
          `[BindingRouter] Binding ${binding.id} uses the per-user strategy but this ` +
            `message carries no platform user id; falling back to a per-chat session. ` +
            `Everyone in this conversation will share one session.`
        );
        return `${binding.id}:chat:${chatId ?? 'unknown'}`;
      }
      return `${binding.id}:user:${userId}`;
    }

    return `${binding.id}:chat:${chatId ?? 'default'}`;
  }

  /**
   * Record that a message just flowed through this binding's session.
   *
   * This is the timestamp `resolveNotifyTarget` sorts on. Without it, "the
   * most-recently-active chat" was whichever entry the session file happened to
   * list last — so a task-completion notice could land in a channel nobody had
   * spoken in for weeks instead of the DM the person was using.
   *
   * @param binding - The binding the message routed through.
   * @param chatId - The chat the message came from.
   * @param envelope - The inbound envelope.
   */
  private touchSession(
    binding: AdapterBinding,
    chatId: string | undefined,
    envelope: RelayEnvelope
  ): void {
    const key = this.sessionKeyFor(binding, chatId, envelope);
    if (!key) return;
    const record = this.sessionMap.get(key);
    if (!record) return;
    const now = Date.now();
    record.lastActivityAt = now;

    // Persist at most once a minute. Writing the file on every message would
    // be an atomic rewrite per chat message; never writing it would mean a
    // restart forgets who was talking most recently, which is the whole point
    // of the field.
    if (now - this.lastActivitySaveAt < BindingRouter.ACTIVITY_SAVE_THROTTLE_MS) return;
    this.lastActivitySaveAt = now;
    void this.saveSessionMap().catch((err: unknown) => {
      logger.warn('BindingRouter: failed to persist session activity', err);
    });
  }

  private async getOrCreateSession(key: string, binding: AdapterBinding): Promise<string> {
    const existing = this.sessionMap.get(key);
    if (existing) {
      // Refresh LRU position so active sessions are not evicted
      this.sessionMap.delete(key);
      this.sessionMap.set(key, existing);
      return existing.sessionId;
    }

    // Deduplicate concurrent session creation for the same key
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const sessionId = await this.createNewSession(binding);
        this.sessionMap.set(key, { sessionId, lastActivityAt: Date.now() });
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

      const valid: Array<[string, SessionRecord]> = [];
      for (const entry of parsed) {
        const record = parseSessionEntry(entry);
        if (record) valid.push(record);
      }

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

  /** Atomic write of the session map, serialized against every in-process writer of this path. */
  private saveSessionMap(): Promise<void> {
    return writeFileAtomic(
      this.sessionMapPath,
      JSON.stringify(Array.from(this.sessionMap.entries()))
    );
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

/**
 * Read one persisted session entry, in either shape it can be on disk.
 *
 * The file used to hold `[key, sessionId]` pairs and now holds
 * `[key, {sessionId, lastActivityAt}]`. A file written by an older build is
 * read, not discarded: its sessions are real, they simply have no recorded
 * activity yet, which is exactly what `lastActivityAt: 0` says.
 *
 * @param entry - One parsed JSON array element.
 * @returns The key/record pair, or `null` when the entry is malformed.
 */
function parseSessionEntry(entry: unknown): [string, SessionRecord] | null {
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return null;
  const [key, value] = entry as [string, unknown];

  if (typeof value === 'string') return [key, { sessionId: value, lastActivityAt: 0 }];

  if (value !== null && typeof value === 'object') {
    const { sessionId, lastActivityAt } = value as Record<string, unknown>;
    if (typeof sessionId !== 'string') return null;
    return [
      key,
      {
        sessionId,
        lastActivityAt: typeof lastActivityAt === 'number' ? lastActivityAt : 0,
      },
    ];
  }

  return null;
}

/**
 * Describe one session-map entry without guessing what its key means.
 *
 * The key is `bindingId:(chat|user):id`, and the middle segment is the whole
 * point: read blindly, a per-user session's person id was reported as a chat id
 * and messages addressed to it went to the wrong conversation.
 *
 * @param key - The session-map key.
 * @param record - What the router remembers about that session.
 */
function describeSession(key: string, record: SessionRecord): BindingSessionEntry {
  const parts = key.split(':');
  const scope = parts[1] === 'user' ? 'user' : 'chat';
  // Ids can contain colons (Slack thread keys do), so the tail is rejoined.
  const id = parts.length >= 3 ? parts.slice(2).join(':') : 'unknown';
  return {
    key,
    scope,
    ...(scope === 'user' ? { userId: id } : { chatId: id }),
    sessionId: record.sessionId,
    lastActivityAt: record.lastActivityAt,
  };
}
