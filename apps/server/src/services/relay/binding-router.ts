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
import type { StandardPayload } from '@dorkos/shared/relay-schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';
import type {
  ChatNoticeReason,
  ChatNoticeSender,
  InboundTurnBudgets,
  PublishOptions,
  PublishResult,
  SubscriberVerdict,
  Unsubscribe,
} from '@dorkos/relay';
import { runtimeSessionSubject, legacyAgentSubject } from '@dorkos/relay';
import { isDispatchId, newDispatchId } from '@dorkos/shared/dispatch-id';
import { logError, logger } from '../../lib/logger.js';
import { currentDispatchId, runInDispatch } from '../../lib/dispatch-context.js';
import { describeSession, parseSessionEntry, type SessionRecord } from './binding-session-map.js';
import { recordDispatchEnd, recordDispatchStart } from '../observability/dispatch-buffers.js';
import { logRefusal, type Refusal } from '../observability/refusals.js';
import type { BindingStore } from './binding-store.js';
import type { AdapterMeshCoreLike } from './adapter-manager.js';
import { parseHumanSubject } from './human-subject.js';
import {
  extractPlatformChatType,
  extractPlatformUserId,
  extractSenderName,
} from './platform-identity.js';
import type { UnclaimedChat, UnclaimedChatStore } from './unclaimed-chat-store.js';
import type { ChatBridgeIngest } from './chat-bridge/index.js';
import { resolveSessionCwd } from '../workspace/resolve-session-cwd.js';

/**
 * Whether an inbound envelope's `content` is the empty string.
 *
 * Only recognizes the exact empty-string shape {@link StandardPayload}
 * produces for a captionless media message — a payload with no `content`
 * field at all (any non-`StandardPayload` shape a test or a future producer
 * might publish) is left alone, so this cannot widen to "any payload missing
 * a field."
 *
 * @param payload - The relay envelope payload as it arrived.
 */
function hasEmptyContent(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  return (payload as { content?: unknown }).content === '';
}

/**
 * The chat/channel's display title — the second of the two payload fields the
 * unclaimed-chat claim feed is allowed to read, beside the sender name
 * `extractSenderName` reads. Both are TOP-LEVEL `StandardPayload` fields every
 * adapter sets (`packages/relay/src/adapters/{telegram,slack}/inbound.ts` —
 * `senderName` always, `channelName` for a group/channel chat, sourced from
 * Telegram's `chat.title` / Slack's resolved channel name, already computed
 * for the message's own routing metadata, no extra platform lookup) — never
 * the message body/content field, and never read from anywhere else in the
 * payload (connection-scoping spec `specs/connection-scoping/` §Part 3 D6).
 */
const ChatTitleSchema = z.object({ channelName: z.string().min(1).optional() }).partial();

/** The claim-feed-safe display fields read off one inbound payload. */
interface ClaimFeedDisplayFields {
  senderName: string | undefined;
  chatTitle: string | undefined;
}

/**
 * Read the sender's display name and the chat's display title off an
 * inbound payload, for the unclaimed-chat claim feed's cockpit card — never
 * the message text.
 *
 * The sender half goes through `platform-identity.ts` rather than a reader of
 * its own: that module owns every "who wrote this" question asked of a payload,
 * so the name a claim card shows and the name a bridged room mints an author
 * under cannot drift apart.
 *
 * @param payload - The relay envelope payload as it arrived.
 */
function extractClaimFeedDisplayFields(payload: unknown): ClaimFeedDisplayFields {
  const senderName = extractSenderName(payload);
  if (payload === null || typeof payload !== 'object') return { senderName, chatTitle: undefined };
  const parsed = ChatTitleSchema.safeParse(payload);
  return { senderName, chatTitle: parsed.success ? parsed.data.channelName : undefined };
}

/** Minimal interface for AgentManager session creation. */
export interface AgentSessionCreator {
  /**
   * @param cwd - Working directory for the new session, which is also where the
   *   answering agent's `.dork/agent.json` lives.
   * @param permissionMode - Required, and deliberately so: an optional mode here
   *   invited a second `?? 'acceptEdits'` fallback to decide it (DOR-604). The
   *   caller resolves it from the binding, which always carries one.
   */
  createSession(cwd: string, permissionMode: PermissionMode): Promise<{ id: string }>;
}

/** Minimal interface for RelayCore publish and subscription. */
export interface RelayCoreLike {
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<PublishResult>;
  /**
   * Which inbound envelope each running agent turn is answering (DOR-791).
   *
   * Optional here only because this interface is a narrow structural subset a
   * test double may implement; the real `RelayCore` always has one. The router
   * never reads it — `AdapterManager` does, to hand the dispatching adapter the
   * SAME map the tool surface reads back from.
   */
  readonly inboundBudgets?: InboundTurnBudgets;
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
   * The inbound bridge (chats-as-channels spec §5). When a resolved binding has
   * `bridge: 'room'`, routing hands the message here INSTEAD of resolving a
   * session — the terminal branch that writes a room post and stops (§5.1,
   * A2.1/A5.2). Optional only so unit tests that never bridge can omit it; in the
   * server it is always wired once the rooms subsystem exists.
   */
  bridgeIngest?: ChatBridgeIngest;
  /**
   * Optional callback fired once per delivered inbound message (`deliveredTo
   * > 0`), used solely to animate the topology pulse. Injected rather than
   * imported so the router stays unit-testable and free of the SSE
   * singleton — mirrors {@link eventRecorder}.
   */
  onFlow?: (flow: RelayFlowEvent) => void;
  /**
   * The durable claim feed for chats with no binding (connection-scoping
   * spec `specs/connection-scoping/` §Part 3). Optional so unit tests that
   * don't exercise the unbound-inbound path can omit it; in the server it is
   * always wired.
   */
  unclaimedChats?: UnclaimedChatStore;
  /**
   * Fired once per NEW unclaimed chat (first sighting only — damped, see
   * {@link UnclaimedChatStore.recordSighting}), for the client's
   * attention surfaces to subscribe to on the global event stream. Injected
   * rather than imported, mirroring {@link onFlow}. Further rate-limited
   * across chats — see {@link onUnclaimedChatBurst}.
   */
  onUnclaimedChat?: (chat: UnclaimedChat) => void;
  /**
   * Fired at most once per rate-limit window when individual
   * {@link onUnclaimedChat} broadcasts were suppressed for exceeding the
   * per-window cap (adversarial review MAJOR 4) — so a burst is visible as
   * "a burst happened, N more than shown," never silently dropped.
   */
  onUnclaimedChatBurst?: (burst: UnclaimedChatBurst) => void;
  /**
   * Where a turn for the bound agent runs — the shared precedence chain
   * (`services/workspace/resolve-session-cwd.ts`). Injected rather than
   * imported so the router stays unit-testable, and defaulted in the
   * constructor to the real resolver so the server wiring says nothing.
   */
  resolveCwd?: (req: { agentPath: string }) => Promise<{ cwd: string }>;
}

/** One rate-limit window's worth of suppressed unclaimed-chat broadcasts. */
export interface UnclaimedChatBurst {
  /** The rolling window this cap was counted over, in ms. */
  windowMs: number;
  /** The per-window broadcast cap that was exceeded. */
  limit: number;
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

/**
 * Whether this server produced the message, rather than a person.
 *
 * Optional-chained rather than asserted: `from` is typed a string because the
 * envelope schema says so, and this runs on data that arrived from another
 * process. A malformed envelope should take its own message out of routing, not
 * throw before the handler's own try can turn it into a verdict.
 *
 * @param from - The envelope's sender principal.
 * @returns `true` for an agent reply or a system notice.
 */
function isOwnProduced(from: string): boolean {
  return from?.startsWith('agent:') === true || from?.startsWith('relay.system.') === true;
}

/**
 * Routes inbound chat messages onto the agent that a binding connects them to,
 * and says — in the chat and in the log — why any of them was not routed.
 *
 * It also owns the persisted `binding:(chat|user):id → session` map, which is
 * what makes a conversation in a chat app resume the same agent session rather
 * than starting a new one every message.
 */
export class BindingRouter {
  /** Maximum number of session mappings before LRU eviction kicks in. */
  private static readonly MAX_SESSIONS = 10_000;

  /** Shortest gap between two activity-driven writes of the session file. */
  private static readonly ACTIVITY_SAVE_THROTTLE_MS = 60_000;

  /**
   * Max individual `relay_chat_unclaimed` broadcasts admitted per window
   * (connection-scoping spec §Part 3, adversarial review MAJOR 4) — bounds a
   * burst across MANY DIFFERENT chats, which per-chat damping alone cannot.
   */
  private static readonly UNCLAIMED_BROADCAST_LIMIT = 20;
  /** Rolling window the broadcast cap above is counted over. */
  private static readonly UNCLAIMED_BROADCAST_WINDOW_MS = 60_000;

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
  /** Start of the current unclaimed-broadcast rate-limit window (epoch ms). */
  private unclaimedBroadcastWindowStart = 0;
  /** Individual broadcasts admitted so far in the current window. */
  private unclaimedBroadcastCount = 0;
  /** Whether the once-per-window burst summary has already fired. */
  private unclaimedBroadcastSummarySent = false;

  /** Where a turn for the bound agent runs — see {@link BindingRouterDeps.resolveCwd}. */
  private readonly resolveCwd: (req: { agentPath: string }) => Promise<{ cwd: string }>;

  constructor(private readonly deps: BindingRouterDeps) {
    this.sessionMapPath = pathJoin(deps.relayDir, 'sessions.json');
    this.resolveCwd = deps.resolveCwd ?? ((req) => resolveSessionCwd(req));
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
    logger.info('[BindingSubsystem] BindingRouter loaded persisted sessions', {
      sessions: this.sessionMap.size,
    });
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
   * Remove every session mapping for ONE binding — called after
   * `BindingStore.moveToAgent` (connection-scoping spec §Part 2 Move
   * semantics). Unlike {@link cleanupOrphanedSessions}, the binding still
   * exists; its sessions are stale because they were created in the OLD
   * agent's project directory, and the binding now points elsewhere. The
   * next inbound message on this binding creates a fresh session under the
   * new agent's project.
   *
   * @param bindingId - The binding whose sessions to clear.
   * @returns Number of session entries removed.
   */
  async clearSessionsForBinding(bindingId: string): Promise<number> {
    let removed = 0;
    for (const [key] of this.sessionMap) {
      if (key.startsWith(`${bindingId}:`)) {
        this.sessionMap.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      try {
        await this.saveSessionMap();
      } catch (err) {
        logger.warn(
          'BindingRouter: failed to persist session map after a binding move, will retry on next write',
          err
        );
      }
      logger.info(`Cleared ${removed} session mapping(s) for moved binding ${bindingId}`);
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
   * Take the single `{bindingId}:chat:{chatId}` session out of the map — the
   * migration off `sessionMap` a chat performs when it is bridged
   * (chats-as-channels spec §7.3, step 1; §7.2).
   *
   * **The key identifies the conversation, not the strategy label.** A chat's
   * session is keyed `{bindingId}:chat:{chatId}` whatever the binding's
   * `sessionStrategy` was (a `per-user` binding only ever writes a `:chat:` key
   * as its no-user-id fallback — {@link BindingRouter.sessionKeyFor}), so this
   * looks for exactly that key and nothing else. Zero matches, or more than one,
   * means there is no single conversation to adopt and the caller starts fresh.
   *
   * **It removes unconditionally, and persists.** Once a chat is bridged its
   * binding vacates `sessionMap` entirely (§7.2, §7.4): the room's ledger owns
   * the session now, and a stale id left behind here would be resurrected by
   * {@link BindingRouter.resolveSession} the moment the chat ever returns to
   * private-pipe mode — resuming a conversation the room had already taken over.
   * So the entry leaves the map whether or not the caller's transcript probe
   * later adopts it; the probe decides the ledger write and the notice, not
   * whether this row survives.
   *
   * The removed id is NOT itself the adoption verdict — it may name a session
   * that was rekeyed out from under `sessions.json` (the router is not an
   * `onProjectorRekey` listener), which is exactly why the caller probes the
   * durable transcript before trusting it (§7.3, step 2).
   *
   * @param bindingId - The binding being bridged.
   * @param chatId - The platform chat id the bridge is for.
   * @returns The taken session's id, or `undefined` when there was not exactly
   *   one candidate.
   */
  async takeChatSession(
    bindingId: string,
    chatId: string
  ): Promise<{ sessionId: string } | undefined> {
    const key = `${bindingId}:chat:${chatId}`;
    const matches = [...this.sessionMap.keys()].filter((k) => k === key);
    if (matches.length !== 1) return undefined;
    const record = this.sessionMap.get(key);
    if (!record) return undefined;
    this.sessionMap.delete(key);
    this.inFlight.delete(key);
    try {
      await this.saveSessionMap();
    } catch (err) {
      logger.warn('BindingRouter: failed to persist sessionMap after taking a bridged chat', err);
    }
    return { sessionId: record.sessionId };
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
  private handleInbound(envelope: RelayEnvelope): Promise<void | SubscriberVerdict> {
    // Skip messages this server produced. Agent replies (`agent:*`) are
    // published to relay.human.* subjects for adapter delivery, and system
    // notices (`relay.system.*`) — including the refusal notices below — go out
    // the same way. Routing either back to an agent is a feedback loop: the
    // notice would arrive as a fresh prompt.
    //
    // **Checked BEFORE any dispatch bookkeeping, and that ordering is
    // load-bearing.** This branch fires for every agent reply the server sends,
    // which is the single most frequent thing on this subscription. Minting an
    // id and opening a ring row first meant a start-only row per reply, at reply
    // rate, flushing the 256-entry ring of the real dispatches it exists to
    // show. Not a dispatch: no id, no row, no scope.
    if (isOwnProduced(envelope.from)) {
      return Promise.resolve({ handled: false, reason: 'not an inbound message from a person' });
    }

    // The bus is the one hop AsyncLocalStorage provably cannot cross, so the id
    // rides the envelope instead. An inbound message that already carries a
    // well-formed one CONTINUES that dispatch; anything else starts a fresh one.
    // The validity check is not ceremony: an envelope arrives from another
    // process (and, with a remote adapter, from another machine), and a
    // malformed value adopted verbatim would become a `traceId` that groups
    // unrelated spans into one fictitious trace.
    const inherited = envelope.dispatchId;
    const dispatchId =
      inherited !== undefined && isDispatchId(inherited) ? inherited : newDispatchId();
    // The scope wraps the whole routing body rather than delegating to a second
    // method, so every line the routing writes — the refusals, the session
    // resolution, the dispatch — carries the id without being edited to.
    recordDispatchStart({ dispatchId, origin: 'relay' });
    return runInDispatch(
      { dispatchId, origin: 'relay' },
      async (): Promise<void | SubscriberVerdict> => {
        try {
          const { adapterId, chatId, channelType } = parseHumanSubject(envelope.subject);
          if (!adapterId) {
            // Nothing to speak into: without an adapter id there is no chat to
            // answer in, so the log is the only record.
            return this.drop(
              dispatchId,
              '[relay] could not read the chat subject of an inbound message',
              { reason: 'unreadable_subject', visibility: 'silent' },
              `unreadable chat subject '${envelope.subject}'`
            );
          }

          // `resolve()` only considers ENABLED bindings (connection-scoping
          // spec §Part 2): a disabled specific binding can no longer shadow an
          // enabled fallback the way the audited bug allowed. Checked BEFORE
          // the blocked-chat lookup below (adversarial review MAJOR 5): a
          // chat's block state must never override a real, explicitly-created
          // binding — someone blocked a stranger, then later a person
          // manually bound that same chat to an agent, and that manual
          // binding has to win. Bound chats also never pay the extra SQLite
          // hit `isBlocked` would otherwise cost on every single message.
          const binding = this.deps.bindingStore.resolve(adapterId, chatId, channelType);
          if (!binding) {
            // A resolve() miss might still mean "the chat's binding exists but
            // is paused" — that case gets the told `binding_paused` refusal
            // (DOR-789), never silence, even though `resolve()` itself can no
            // longer return it.
            const pausedMatch = this.deps.bindingStore.resolveIncludingDisabled(
              adapterId,
              chatId,
              channelType
            );
            if (pausedMatch) {
              return this.refuse(
                envelope,
                pausedMatch,
                'binding_paused',
                `binding ${pausedMatch.id} is paused`
              );
            }

            // Truly unbound — NOW the blocked-chat check applies (spec §Part
            // 3 step 1: block only means anything once nothing legitimate
            // claims this chat). Short-circuits before ANY claim-feed write:
            // "block drops future traffic recordless." A chat only reaches
            // `blocked` through the claim feed, which is why this needs
            // `chatId` — an adapter-root subject (no chat) was never a
            // candidate for the feed in the first place.
            if (chatId && this.deps.unclaimedChats?.isBlocked(adapterId, chatId)) {
              return this.drop(
                dispatchId,
                '[relay] this chat is blocked',
                { reason: 'chat_blocked', visibility: 'silent', detail: { adapterId } },
                'chat is blocked'
              );
            }

            // Truly unbound and not blocked: record it in the claim feed
            // (damped, metadata-only — see `unclaimed-chat-store.ts`) and drop
            // silently in-chat, exactly as before. Deliberately silent
            // in-chat: nobody connected this conversation to anything here, so
            // there is no agent whose silence needs explaining, and speaking
            // would be this machine starting a conversation it has no consent
            // for. The trace and the log carry it instead.
            this.recordUnclaimedChat(adapterId, chatId, channelType, envelope);
            return this.drop(
              dispatchId,
              '[relay] nothing connects this chat to an agent',
              { reason: 'no_binding', visibility: 'silent', detail: { adapterId } },
              'no binding connects this chat to an agent'
            );
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

          // Interim gate (DOR-866). The Telegram adapter now publishes a
          // captionless photo/sticker/voice/document/video/location with
          // `content: ''` and a `platformData.media` descriptor, so a future
          // bridge (task 1.6) can build a placeholder from it — that is the
          // consumer this envelope was published for. Nothing on THIS,
          // classic/unbridged path reads that descriptor yet: dispatching
          // empty content anyway would run a real agent turn over nothing and
          // have the agent reply about a message that said nothing. This
          // restores today's behavior byte-for-byte for every binding that is
          // not bridged. A `bridge: 'room'` binding is deliberately let
          // through — that is exactly the envelope task 1.6 is built to
          // consume. Silent: nothing was said for an empty message before
          // this task either, so there is no new silence to explain in-chat.
          if (binding.bridge !== 'room' && hasEmptyContent(envelope.payload)) {
            return this.drop(
              dispatchId,
              '[relay] dropped an inbound message with no text content',
              { reason: 'empty_content', visibility: 'silent', detail: { bindingId: binding.id } },
              'no text content'
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

          // A bridged binding's inbound message becomes a room post, and that
          // branch is TERMINAL: `ingest` writes the entry and stops. Falling
          // through to `resolveSession` would run the turn twice from one
          // message (chats-as-channels spec §5.1, A2.1/A5.2). The turn, if any,
          // is chosen by `RoomTriggerDispatcher` off the committed post — never
          // here — and `sessionMap` is neither read nor written for a bridged
          // binding (§7.2, A7.3). `projectPath` above is the bound agent's
          // directory, threaded so `@botusername` can address it (§5.4).
          if (binding.bridge === 'room') {
            if (!this.deps.bridgeIngest) {
              // Can't happen in the server — the bridge is wired whenever the
              // rooms subsystem exists — but falling through is the exact
              // double-run this branch prevents, so refuse loudly instead.
              logger.error('[relay] a bridged binding arrived but no chat bridge is wired', {
                bindingId: binding.id,
              });
              recordDispatchEnd(dispatchId, 'refused');
              return { handled: false, reason: 'the chat bridge is not available' };
            }
            const result = await this.deps.bridgeIngest.ingest(binding, envelope, {
              agentPath: projectPath,
            });
            if (result.status === 'refused') {
              recordDispatchEnd(dispatchId, 'refused');
              return result.verdict;
            }
            // The message reached the room; any answer runs on the room's own
            // dispatch, so from THIS relay dispatch nothing further is emitted.
            recordDispatchEnd(dispatchId, 'quiet');
            return;
          }

          let sessionId: string;
          try {
            sessionId = await this.resolveSession(binding, chatId, envelope);
          } catch (err) {
            // A session that cannot be created is the one refusal that used to
            // reach only the catch-all below, where it became a log line with no
            // binding attached and no way for the person to know.
            return this.refuse(envelope, binding, 'session_failed', logError(err).error);
          }

          // Where the turn runs, from the shared precedence chain rather than
          // from `projectPath` directly. For the default `home` binding the two
          // are the same path; for an agent that asked for a checkout of its
          // own they are not, and this stamp is what the runtime obeys.
          // `agentPath` above stays the agent's OWN directory — it answers "who
          // is this", not "where does it work", and `@botusername` addressing
          // keys on identity.
          const { cwd: dispatchCwd } = await this.resolveCwd({ agentPath: projectPath });

          const enrichedPayload =
            envelope.payload && typeof envelope.payload === 'object'
              ? {
                  ...(envelope.payload as Record<string, unknown>),
                  cwd: dispatchCwd,
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
              // The republish is the SAME logical delivery, so it carries the same
              // dispatch id. Without this the inbound and outbound `messageId`s of
              // one message are unrelated ULIDs and the two spans never join.
              dispatchId,
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
            // The relay's dispatch is over the moment the turn is ACCEPTED —
            // agent deliveries are detached, and nothing here can wait for the
            // turn. Its own ingress opens a dispatch of its own.
            recordDispatchEnd(dispatchId, 'answered', sessionId);
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
          const { error } = logError(err);
          logger.error(`BindingRouter: failed to route ${envelope.subject}:`, error);
          return { handled: false, reason: error };
        }
      }
    );
  }

  /**
   * Drop one inbound message that never reached a binding: log the refusal,
   * close its dispatch, and report the verdict.
   *
   * The two callers are the only refusals that happen BEFORE a binding is
   * resolved, so {@link BindingRouter.refuse} — which needs one, both to speak
   * into the chat and to name itself on the line — cannot serve them. They went
   * straight to `logRefusal` instead, which left their dispatch row open
   * forever: a `refused` outcome the ring never learned, sitting at the top of
   * `GET /api/debug/dispatches` reading as still running.
   *
   * Sharing one exit is what stops the next such branch forgetting the end.
   *
   * @param dispatchId - The dispatch this drop terminates.
   * @param message - The `'[tag] sentence'` refusal line.
   * @param refusal - Why, and whether anybody was told.
   * @param verdict - The reason string the subscriber verdict carries.
   * @returns The `handled: false` verdict.
   */
  private drop(
    dispatchId: string,
    message: string,
    refusal: Omit<Refusal, 'dispatchId'>,
    verdict: string
  ): SubscriberVerdict {
    logRefusal(message, { ...refusal, dispatchId });
    recordDispatchEnd(dispatchId, 'refused');
    return { handled: false, reason: verdict };
  }

  /**
   * Record one sighting of a truly-unbound chat in the claim feed
   * (connection-scoping spec §Part 3), and broadcast the claim-feed event on
   * a first sighting only (damping — see
   * {@link UnclaimedChatStore.recordSighting}), itself further rate-limited
   * across DIFFERENT chats (see {@link admitUnclaimedBroadcast} — the
   * per-chat damping alone does not bound a burst of MANY distinct new
   * chats, e.g. a publicly-discoverable bot getting spammed by many
   * strangers at once). A no-op when either `unclaimedChats` was not wired
   * (some unit tests) or the subject carried no `chatId` (an adapter-root
   * subject is not a chat to claim).
   *
   * Reads ONLY subject-derived routing fields and the payload's top-level
   * `senderName`/`channelName`/platform-identity fields — never the message
   * body. See `specs/connection-scoping/design-decisions.md` D6.
   *
   * @param adapterId - The adapter the message arrived on.
   * @param chatId - The chat id, when the subject carried one.
   * @param channelType - `'group'` or undefined (dm), from the subject.
   * @param envelope - The inbound envelope, read only for sender/title identity.
   */
  private recordUnclaimedChat(
    adapterId: string,
    chatId: string | undefined,
    channelType: string | undefined,
    envelope: RelayEnvelope
  ): void {
    if (!chatId || !this.deps.unclaimedChats) return;
    const { senderName, chatTitle } = extractClaimFeedDisplayFields(envelope.payload);
    const { chat, isFirstSighting } = this.deps.unclaimedChats.recordSighting({
      adapterId,
      chatId,
      channelType,
      chatKind: channelType === 'group' ? 'group' : 'dm',
      // The RAW platform type, kept alongside the folded `chatKind` so a
      // broadcast stays distinguishable from a group all the way to the binding
      // a claim creates (DOR-907, spec §3.3).
      platformChatType: extractPlatformChatType(envelope.payload),
      senderName,
      chatTitle,
      senderId: extractPlatformUserId(envelope.payload),
    });
    if (!isFirstSighting) return;

    if (this.admitUnclaimedBroadcast()) {
      this.deps.onUnclaimedChat?.(chat);
    } else if (!this.unclaimedBroadcastSummarySent) {
      // Beyond the per-window cap: tell the client ONE summary event instead
      // of going fully silent, so a burst is still visible as "a burst
      // happened," not as N cards that just never arrived.
      this.unclaimedBroadcastSummarySent = true;
      this.deps.onUnclaimedChatBurst?.({
        windowMs: BindingRouter.UNCLAIMED_BROADCAST_WINDOW_MS,
        limit: BindingRouter.UNCLAIMED_BROADCAST_LIMIT,
      });
    }
  }

  /**
   * Token-bucket-lite rate limit for {@link onUnclaimedChat} broadcasts,
   * across every chat (not per-chat — {@link UnclaimedChatStore.recordSighting}
   * already damps repeats of the SAME chat to zero broadcasts). Resets the
   * window and the once-per-window summary flag when the current window has
   * elapsed.
   *
   * @returns `true` when this sighting is still under the per-window cap and
   *   should broadcast individually.
   */
  private admitUnclaimedBroadcast(): boolean {
    const now = Date.now();
    if (now - this.unclaimedBroadcastWindowStart >= BindingRouter.UNCLAIMED_BROADCAST_WINDOW_MS) {
      this.unclaimedBroadcastWindowStart = now;
      this.unclaimedBroadcastCount = 0;
      this.unclaimedBroadcastSummarySent = false;
    }
    this.unclaimedBroadcastCount += 1;
    return this.unclaimedBroadcastCount <= BindingRouter.UNCLAIMED_BROADCAST_LIMIT;
  }

  /**
   * Refuse one inbound message: log it, tell the person, and report the drop.
   *
   * @param envelope - The message being dropped.
   * @param binding - The binding it resolved to.
   * @param notice - Which one-line notice the person should read. Narrowed to
   *   exclude the three {@link ChatNoticeReason} values that are NOT inbound
   *   refusals: `empty_response` (a turn that ran and said nothing — the agent's
   *   own choice, rendered by the adapter), `channel_archived` (a bridge
   *   lifecycle notice `BridgeLifecycle` sends, not a per-message drop this
   *   router decides), and `agent_held` (a message WAITING for a busy agent,
   *   which is the opposite of a refusal and has no `RefusalReason`). None can
   *   be produced here, and the narrowing is what lets the notice double as the
   *   structured `reason` on the refusal line without a cast.
   * @param reason - The operator-facing reason, recorded on the trace.
   */
  private async refuse(
    envelope: RelayEnvelope,
    binding: AdapterBinding,
    notice: Exclude<ChatNoticeReason, 'empty_response' | 'channel_archived' | 'agent_held'>,
    reason: string
  ): Promise<SubscriberVerdict> {
    // The binding is named rather than re-resolved: this router just resolved
    // it from the store for this very message, and it is the only caller that
    // can honestly say so. It is also what lets a PAUSED binding be spoken
    // about at all — the sender's own resolver requires an enabled one, and
    // "this chat is paused" is exactly what a paused chat needs to hear.
    await this.deps.chatNotice?.(envelope.subject, notice, { binding: { id: binding.id } });
    // `shown` when a notifier exists to carry the one-line notice back into the
    // chat, `silent` when none is wired — an install with no notice path drops
    // the message with nothing but this line to show for it.
    // The dispatch ends here: nothing reached an agent, so no ingress downstream
    // will close it. Guarded rather than passed a sentinel — a refusal reached
    // from outside a dispatch scope has no dispatch to close.
    const dispatchId = currentDispatchId();
    if (dispatchId !== undefined) recordDispatchEnd(dispatchId, 'refused');
    logRefusal('[relay] an inbound chat message was dropped', {
      reason: notice,
      visibility: this.deps.chatNotice !== undefined ? 'shown' : 'silent',
      detail: { bindingId: binding.id, agentId: binding.agentId, cause: reason },
    });
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
    // Same chain as the dispatch stamp above, and it must be: a session created
    // in one directory and then fed turns stamped with another would split the
    // agent's work across two trees.
    const { cwd } = await this.resolveCwd({ agentPath: projectPath });
    logger.debug('[BindingRouter] createNewSession', {
      bindingId: binding.id,
      adapterId: binding.adapterId,
      agentId: binding.agentId,
      projectPath,
      cwd,
    });
    const session = await this.deps.agentManager.createSession(cwd, binding.permissionMode);
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
