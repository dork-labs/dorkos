/**
 * Binding subsystem initialization for the Relay adapter manager.
 *
 * Owns BindingStore, AgentSessionStore, and BindingRouter lifecycle.
 * Created by AdapterManager BEFORE any adapter starts, and fatal on failure:
 * an adapter that runs without this has nowhere to route a message and no
 * consent to check. See {@link BindingSubsystem.init}.
 *
 * @module services/relay/binding-subsystem
 */
import { dirname } from 'node:path';
import type { AgentRuntimeLike } from '@dorkos/relay';
import { createChatNoticeSender } from '@dorkos/relay';
import type { ChatNoticeTargetResolver } from '@dorkos/relay';
import { parseHumanSubject } from './human-subject.js';
import type { PermissionMode } from '@dorkos/shared/schemas';
import type { RelayFlowEvent, Signal, SignalType } from '@dorkos/shared/relay-schemas';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { logger } from '../../lib/logger.js';
import { BindingStore } from './binding-store.js';
import { AgentSessionStore } from './agent-session-store.js';
import { createTurnExecutionSettingsResolver } from './turn-execution-settings.js';
import {
  BindingRouter,
  type RelayCoreLike,
  type AgentSessionCreator,
  type UnclaimedChatBurst,
} from './binding-router.js';
import type { AdapterMeshCoreLike } from './adapter-manager.js';
import type { UnclaimedChat, UnclaimedChatStore } from './unclaimed-chat-store.js';
import type { RoomEntry, RoomPresencePayload } from '@dorkos/shared/room-schemas';
import {
  ChatBridge,
  BridgeLifecycle,
  BridgeSessionAdopter,
  ChatBridgeDelivery,
  BridgeCatchUp,
  BridgedAskDelivery,
  ChatBridgePresence,
  type BridgeStore,
  type BridgeRoomOps,
  type IngestRoomOps,
  type AdoptRoomOps,
  type TranscriptProbe,
  type Bridge,
  type DeliverEntryReader,
  type DeliverAuthorReader,
  type AskRoomBindings,
  type AskRosterReader,
} from './chat-bridge/index.js';

/**
 * The fallback transcript probe when the composition root wired none: it can
 * probe no runtime, so every bridge starts a fresh session (chats-as-channels
 * spec §7.3's per-runtime flag). Safe by construction — it never claims a
 * session exists — and the shape the tests that omit rooms wiring inherit.
 */
const NO_TRANSCRIPT_PROBE: TranscriptProbe = {
  canProbe: () => false,
  hasTranscript: () => Promise.resolve({ exists: false }),
};

/** Dependencies required to initialize the binding subsystem. */
export interface BindingSubsystemDeps {
  /** Relay publish/subscribe core. */
  relayCore: RelayCoreLike;
  /** MeshCore for resolving agent project paths. */
  meshCore: AdapterMeshCoreLike;
  /**
   * Map from runtime type to the concrete `AgentRuntimeLike` used to create
   * fresh sessions for incoming chat-platform messages. See
   * {@link resolveSessionCreatorRuntime} for which entry gets picked when
   * `runtimes.default` names a runtime the relay does not hold. Multi-runtime
   * dispatch of existing sessions happens in the adapter manager.
   */
  agentRuntimes: Map<string, AgentRuntimeLike>;
  /** Absolute path to the adapter config file (used to derive relayDir). */
  configPath: string;
  /** Optional recorder for binding routing failure events. */
  eventRecorder?: {
    insertAdapterEvent(adapterId: string, eventType: string, message: string): void;
  };
  /** Optional callback fired once per delivered inbound message (topology pulse). */
  onFlow?: (flow: RelayFlowEvent) => void;
  /** The durable claim feed store (connection-scoping spec §Part 3). */
  unclaimedChats?: UnclaimedChatStore;
  /** Fired once per NEW unclaimed chat (first sighting only). */
  onUnclaimedChat?: (chat: UnclaimedChat) => void;
  /** Fired at most once per rate-limit window when broadcasts were capped. */
  onUnclaimedChatBurst?: (burst: UnclaimedChatBurst) => void;
  /**
   * The rooms service, for the inbound chat bridge (chats-as-channels §5). The
   * real `RoomService` satisfies both structural seams the bridge needs. Present
   * only once the rooms subsystem is wired; without it, bridged bindings cannot
   * be routed and `bridge: 'room'` never resolves in the router.
   */
  roomService?: BridgeRoomOps & IngestRoomOps & AdoptRoomOps;
  /** The bridge identity store — the same instance the rooms service writes through. */
  roomBridges?: BridgeStore;
  /**
   * The per-runtime transcript probe for session adoption at bridge time
   * (chats-as-channels spec §7.3). Backed by the claude-code `TranscriptReader`
   * in the composition root so the runtime SDK stays confined to its adapter
   * dir. When absent, the adopter reports no runtime can be probed and every
   * bridge starts a fresh session — the safe default.
   */
  transcriptProbe?: TranscriptProbe;
  /**
   * The install owner's author id, read per call (an install becomes owned
   * partway through its life). The bridge acts as the operator for its
   * lifecycle writes (§3.5, §10.9).
   */
  operatorAuthorId?: () => string;
  /**
   * The REAL name to prefix an operator-authored post with in a bridged chat
   * (§6.7), or `null` when nothing is configured, read per call. Threaded
   * straight to {@link ChatBridgeDeliveryDeps.operatorDisplayName} — see its
   * doc for why this must never be the author registry's own `displayName`
   * (DOR-899). Optional: a caller that omits it gets `deliver.ts`'s neutral
   * fallback label, never `'You'`.
   */
  operatorDisplayName?: () => string | null;
  /**
   * Refresh a bridged room's `visibility` badge from the platform, right after
   * it is created — the bridge-create half of chats-as-channels §8's refresh
   * cadence (task 1.13; the adapter-start/reconnect half lives in
   * `AdapterManager.emitAdapterLifecycle`, which is also this function's other
   * caller). The composition root wires this to `AdapterManager`'s own
   * `getMe()`-backed refresh, so the binding subsystem never needs to know an
   * adapter registry exists. Best-effort by contract: `BridgeLifecycle.bridge`
   * awaits it but a failure must never fail the bridge it followed.
   */
  refreshVisibility?: (adapterId: string) => Promise<void>;
  /**
   * The room store, for outbound delivery to read an entry by id — provenance
   * classification and the catch-up scan (chats-as-channels §6). Present only
   * once the rooms subsystem is wired; without it, outbound delivery is not
   * built and posts never reach the platform.
   */
  roomStore?: DeliverEntryReader;
  /** The author registry, for the delivering-author check and the name prefix (§6.6, §6.7). */
  roomAuthors?: DeliverAuthorReader;
  /**
   * Which room a session answers for — the bridged Ask card's first question
   * (spec `ask-entitlement` §5.2). A PORT, like every other rooms seam here:
   * the composition root hands over the session ledger, and a boot with no
   * rooms hands over nothing, in which case no room-bound Ask exists to card.
   */
  roomSessionBindings?: AskRoomBindings;
  /**
   * A room's membership rows, for working out who is on the other end of a
   * bridged chat (§5.1). Only the outside people matter, and only their count
   * and their platform ids.
   */
  roomMembers?: AskRosterReader;
  /**
   * The approver allowlist configured on one adapter, read per call (§5.1).
   * Supplied by `AdapterManager`, which is the only thing that holds the
   * adapter configs.
   *
   * @param adapterId - The adapter a bridge belongs to.
   */
  approverAllowlistFor?: (adapterId: string) => unknown;
  /**
   * Build a chat's `relay.human.*` subject from its bridge row — outbound
   * delivery's target (§6.4). The platform segment lives on the adapter, not the
   * bridge row, so the composition root supplies this from the adapter registry.
   */
  resolveBridgeSubject?: (bridge: Bridge) => string | null;
  /**
   * Register the outbound bridge's inline-delivery hook on the room service
   * (§6.1). The composition root wires this to `RoomService.setEntryCommitListener`,
   * so the binding subsystem never needs the service's concrete shape.
   */
  registerEntryCommitListener?: (listener: (entry: RoomEntry) => void) => void;
  /**
   * Emit an ephemeral relay signal — {@link RelayCore.signal}. Present only
   * once the rooms subsystem is wired; without it, the presence forwarder is
   * not built and a bridged room's typing indicator never reaches the
   * platform (chats-as-channels §6.8). Narrower than `relayCore` on purpose:
   * presence never goes through the publish/consent pipeline `relayCore`'s
   * other uses do, so widening `RelayCoreLike` for this one method would hand
   * every other consumer of that type a capability nothing else here needs.
   */
  relaySignal?: (subject: string, signal: Signal) => void;
  /**
   * Register the chat bridge's presence forwarder on the room service (§6.8).
   * The composition root wires this to `RoomService.setSignalListener`, the
   * same pattern as {@link BindingSubsystemDeps.registerEntryCommitListener}.
   */
  registerSignalListener?: (
    listener: (
      roomId: string,
      signal: SignalType,
      authorId: string,
      presence?: Partial<RoomPresencePayload>
    ) => void
  ) => void;
}

/**
 * Pick the runtime that new chat-originated sessions are created against.
 *
 * Prefers `runtimes.default` when the relay actually holds a runtime for it —
 * that is the honest reading of "the user's default" and stays correct the day
 * the relay carries more than one runtime.
 *
 * When it doesn't, this falls back to the relay's own registered runtime
 * instead of failing. The relay is wired to exactly one runtime today (the
 * Claude Code adapter is Claude-specific by construction), so under
 * `runtimes.default: opencode` the default lookup finds nothing — and the old
 * code threw there, which `init` caught and turned into a warn line and a
 * silently disabled BindingRouter. Chat platforms accepted messages and
 * delivered none. A message that arrives has to be answered by somebody; the
 * runtime the relay was actually given is the only honest candidate, and the
 * mismatch is logged rather than swallowed.
 *
 * @param agentRuntimes - Runtime-type → runtime map held by the AdapterManager.
 * @returns The runtime to create new sessions with.
 * @throws If the relay holds no runtimes at all — there is nothing to fall back to.
 */
function resolveSessionCreatorRuntime(
  agentRuntimes: Map<string, AgentRuntimeLike>
): AgentRuntimeLike {
  const defaultType = runtimeRegistry.getDefaultType();
  const preferred = agentRuntimes.get(defaultType);
  if (preferred) return preferred;

  // First insertion wins. Unambiguous today — the relay is wired to exactly one
  // runtime — but the day it carries more than one, "first inserted" stops being
  // a decision and becomes an accident of composition-root ordering. Give it a
  // real rule then (an explicit relay-preferred type), rather than letting the
  // map's iteration order quietly choose who answers a stranger's first message.
  const [fallbackType, fallback] = agentRuntimes.entries().next().value ?? [];
  if (!fallback || fallbackType === undefined) {
    throw new Error(
      '[BindingSubsystem] The relay holds no agent runtimes — cannot initialize ' +
        'the session creator. The composition root must pass `agentRuntimes`.'
    );
  }

  logger.info(
    `[BindingSubsystem] Default runtime '${defaultType}' is not wired into the relay; ` +
      `new chat-originated sessions will be created on '${fallbackType}'. ` +
      'Existing sessions still route to their own runtime.'
  );
  return fallback;
}

/**
 * Build the lookup that decides whether this machine may speak in a chat.
 *
 * Used by every chat notice that did not come from the binding router — most
 * importantly the one for a turn that died after acceptance, whose subject is
 * the failed envelope's `replyTo` and therefore, on `relay_send`, a string the
 * model chose. Resolving it here means a chat with no binding, or one whose
 * binding is paused, is answered with `null`: silence.
 *
 * @param bindingStore - The store to resolve chat subjects against.
 * @returns A resolver for {@link createChatNoticeSender}.
 */
export function makeChatNoticeTargetResolver(
  bindingStore: Pick<BindingStore, 'resolve'>
): ChatNoticeTargetResolver {
  return (subject) => {
    const { adapterId, chatId, channelType } = parseHumanSubject(subject);
    if (!adapterId) return null;
    const binding = bindingStore.resolve(adapterId, chatId, channelType);
    if (!binding || binding.enabled === false) return null;
    return { bindingId: binding.id };
  };
}

/**
 * Container for the adapter binding subsystem.
 *
 * Encapsulates BindingStore, AgentSessionStore, and BindingRouter so that
 * AdapterManager can delegate binding concerns to a focused module. All
 * three components share the same `relayDir` derived from configPath.
 */
export class BindingSubsystem {
  private readonly bindingStore: BindingStore;
  private readonly agentSessionStore: AgentSessionStore;
  private bindingRouter: BindingRouter | undefined;
  private isShutdown = false;
  /**
   * The outbound catch-up scan (chats-as-channels §6.1), when outbound delivery
   * is wired. `AdapterManager` reads it to re-scan a chat's undelivered entries
   * when its adapter reconnects.
   */
  bridgeCatchUp: BridgeCatchUp | undefined;
  /**
   * The bridged Ask card sender, when the rooms seams it needs are wired
   * (spec `ask-entitlement` §5.2). Held so {@link shutdown} can release its
   * projector subscription.
   */
  private bridgedAsks: BridgedAskDelivery | undefined;
  /**
   * The bridge lifecycle coordinator (chats-as-channels §3.5), when the rooms
   * subsystem is wired. The cockpit's "Bridge to a channel" action (DOR-878)
   * reaches it through {@link AdapterManager.getBridgeLifecycle} to turn a
   * binding's bridge on and off — the first production caller of
   * `BridgeLifecycle.bridge`. Absent (with the whole bridge stack) when rooms
   * are not wired, and the PATCH route then falls back to a plain field write,
   * which is inert because a bridged binding is never routed without `bridgeIngest`.
   */
  private bridgeLifecycle: BridgeLifecycle | undefined;

  private constructor(bindingStore: BindingStore, agentSessionStore: AgentSessionStore) {
    this.bindingStore = bindingStore;
    this.agentSessionStore = agentSessionStore;
  }

  /**
   * Initialize the binding subsystem: BindingStore, AgentSessionStore, and BindingRouter.
   *
   * **Throws on failure, and that is the fix.** This used to catch everything,
   * log one warning, and return `undefined`. The caller then carried on and
   * started the chat adapters anyway — so Telegram and Slack connected, accepted
   * messages, and had nowhere to route them, while the consent gate that reads
   * this subsystem's binding store was never installed. Every visible signal
   * said the integration was up. The failure is reachable, not theoretical: the
   * stores and the router open chokidar watchers, and `EMFILE` on a machine
   * running several agents is a documented way to get here.
   *
   * The caller (`AdapterManager.initialize`) runs this BEFORE starting any
   * adapter, so a throw means no adapter starts, the server logs the failure,
   * and the relay stays quiet — which is the honest reading of "we cannot tell
   * who may talk to whom".
   *
   * Anything opened before the failure is closed on the way out, so a retry
   * (a hot-reload, a restart) does not leak a watcher or a file handle.
   *
   * @param deps - Required dependencies for subsystem initialization
   * @returns The initialized subsystem
   * @throws If any of the three components fails to initialize
   */
  static async init(deps: BindingSubsystemDeps): Promise<BindingSubsystem> {
    const relayDir = dirname(deps.configPath);
    let subsystem: BindingSubsystem | undefined;
    try {
      const bindingStore = new BindingStore(relayDir);
      await bindingStore.init();
      logger.info('[BindingSubsystem] BindingStore initialized');

      const agentSessionStore = new AgentSessionStore(relayDir);
      await agentSessionStore.init();
      logger.info('[BindingSubsystem] AgentSessionStore initialized');

      subsystem = new BindingSubsystem(bindingStore, agentSessionStore);
      // A definite handle for the closures below: `subsystem` is a reassignable
      // `let` whose narrowing does not survive into an arrow function, but the
      // instance is built now and never replaced, so the adopter's lazy read of
      // `bindingRouter` (set later in this same init) closes over this instead.
      const self = subsystem;

      // New sessions created by the BindingRouter (e.g., first chat-platform
      // message from a user) need a runtime to be created against. Existing
      // sessions route to their owning runtime via session_metadata.
      const agentManager = resolveSessionCreatorRuntime(deps.agentRuntimes);
      // What a chat-originated session runs on — the SAME answer the relay
      // adapter resolves for a turn (`turn-execution-settings.ts`), and it has
      // to be resolved HERE because this is where the session is created. The
      // adapter's own `ensureSession` runs after the router has published to
      // `relay.agent.*`, by which time the session exists and that call is a
      // no-op; a model resolved only there reached nothing on this path, so an
      // agent answered a stranger on Telegram with the SDK's default while
      // answering a room on its own model (DOR-1344).
      const resolveSettings = createTurnExecutionSettingsResolver(
        agentManager.type ?? runtimeRegistry.getDefaultType()
      );
      const sessionCreator: AgentSessionCreator = {
        async createSession(cwd: string, permissionMode: PermissionMode) {
          const id = crypto.randomUUID();
          // No fallback: the binding decides the mode (DOR-604), and the
          // resolver above cannot answer about permissions at all.
          agentManager.ensureSession(id, {
            permissionMode,
            cwd,
            // The id is minted one line up, so there is no settings row to find
            // — this is the manifest-then-server ladder, every time. `cwd` is
            // the agent's own project directory, which is where its manifest is.
            ...(await resolveSettings({ sessionId: id, agentDirectory: cwd })),
          });
          return { id };
        },
      };

      // Wired here, and never optional in the server: a refusal the person
      // never hears about is indistinguishable from an agent thinking. Shared
      // between the router's refusals and the bridge's broken-bridge notices, so
      // both damp against one `(binding, chat, reason)` window.
      const chatNotice = createChatNoticeSender({
        publish: (subject, payload, options) => deps.relayCore.publish(subject, payload, options),
        resolveTarget: makeChatNoticeTargetResolver(bindingStore),
        logger,
      });

      // The inbound chat bridge (chats-as-channels §5). Built here — the one
      // place `bindingStore` and `chatNotice` already exist — from the rooms
      // deps the composition root threaded in. `BridgeLifecycle` is constructed
      // for the first time outside a test here; `ingest` calls its §10.9
      // archived-out-of-band recovery seam. Absent when the rooms subsystem is
      // not wired (some unit tests), and the router then refuses a bridged
      // binding rather than routing it as an unbridged one.
      let bridgeIngest: ChatBridge | undefined;
      if (deps.roomService && deps.roomBridges && deps.operatorAuthorId) {
        const roomService = deps.roomService;
        // Session adoption at bridge time (chats-as-channels §7.3). The
        // `takeChatSession` seam reads the router built LATER in this same init
        // (line below), so it is a lazy closure rather than a captured handle —
        // it is only ever called at a user-triggered bridge, long after init.
        // The probe is gated per runtime: absent (`transcriptProbe` unwired) or a
        // non-claude-code session both take the fresh-start path (§7.3's flag).
        const adopter = new BridgeSessionAdopter({
          takeChatSession: (bindingId, chatId) =>
            self.bindingRouter?.takeChatSession(bindingId, chatId) ?? Promise.resolve(undefined),
          getSessionRuntimeType: (sessionId) => runtimeRegistry.getSessionRuntimeType(sessionId),
          probe: deps.transcriptProbe ?? NO_TRANSCRIPT_PROBE,
          resolveAgentRoot: (agentId) => deps.meshCore.getProjectPath(agentId) ?? undefined,
          rooms: roomService,
        });
        // One lifecycle shared by the inbound and outbound halves: the §10.9
        // archived-out-of-band recovery ingest calls and the §10.3 terminal
        // archival delivery calls are the same coordinator over the same tables.
        const bridgeLifecycle = new BridgeLifecycle({
          rooms: deps.roomService,
          bridges: deps.roomBridges,
          bindings: bindingStore,
          chatNotice,
          operatorAuthorId: deps.operatorAuthorId,
          adopter,
          refreshVisibility: deps.refreshVisibility,
        });
        // Held for the cockpit's bridge action (DOR-878), which reaches it via
        // the adapter manager. The same coordinator the ingest/delivery halves use.
        self.bridgeLifecycle = bridgeLifecycle;
        bridgeIngest = new ChatBridge({
          rooms: deps.roomService,
          bridges: deps.roomBridges,
          lifecycle: bridgeLifecycle,
          chatNotice,
        });

        // The outbound half (chats-as-channels §6), when the extra rooms reads
        // are wired. Built here so it shares the lifecycle and the one
        // `bindingStore`/`relayCore` the whole subsystem already holds.
        if (deps.roomStore && deps.roomAuthors && deps.resolveBridgeSubject) {
          // The Approve/Deny card for a room-bound Ask (spec `ask-entitlement`
          // §5.2), built BEFORE outbound delivery because delivery asks it
          // whether a card is already standing before sending the waiting
          // sentence behind it (§5.4). It needs three seams beyond the outbound
          // set, so a boot without them simply has no bridged card and keeps
          // today's sentence-only behaviour.
          const asks =
            deps.roomSessionBindings && deps.roomMembers && deps.approverAllowlistFor
              ? new BridgedAskDelivery({
                  bindings: deps.roomSessionBindings,
                  bridges: deps.roomBridges,
                  members: deps.roomMembers,
                  authors: deps.roomAuthors,
                  approverAllowlistFor: deps.approverAllowlistFor,
                  resolveSubject: deps.resolveBridgeSubject,
                  publisher: deps.relayCore,
                })
              : undefined;
          asks?.start();
          subsystem.bridgedAsks = asks;
          const delivery = new ChatBridgeDelivery({
            entries: deps.roomStore,
            rooms: deps.roomService,
            bridges: deps.roomBridges,
            authors: deps.roomAuthors,
            publisher: deps.relayCore,
            lifecycle: bridgeLifecycle,
            resolveSubject: deps.resolveBridgeSubject,
            operatorAuthorId: deps.operatorAuthorId,
            operatorDisplayName: deps.operatorDisplayName,
            ...(asks ? { asks } : {}),
          });
          const catchUp = new BridgeCatchUp({
            bridges: deps.roomBridges,
            entries: deps.roomStore,
            delivery,
          });
          // The third catch-up trigger (§6.1): a delivery that recovers from a
          // transient failure re-scans its room to flush whatever queued behind.
          delivery.setRecoveryHook((roomId) => void catchUp.scanRoom(roomId));
          // The inline fast path (§6.1): deliver on commit.
          deps.registerEntryCommitListener?.((entry) => delivery.onCommit(entry));
          subsystem.bridgeCatchUp = catchUp;
          // The first trigger (§6.1): catch up everything the log already holds,
          // detached so a disk walk never sits in front of the router coming up.
          void catchUp.scanAll().catch((err: unknown) => {
            logger.warn('[BindingSubsystem] initial bridge catch-up failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          // The startup stranded-ref sweep (spec §10.1's crash divergence,
          // DOR-898): a null-id outbound ref old enough that it cannot still
          // be an in-flight retry survived a PRIOR process's crash between
          // the write-before-send ref write and the platform call. It is
          // invisible to `catchUp.scanAll` above (an entry with any ref, null
          // id or not, is excluded from that scan's candidate list), so this
          // runs alongside it, at the same startup trigger, detached for the
          // same reason.
          void delivery.sweepStrandedRefs().catch((err: unknown) => {
            logger.warn('[BindingSubsystem] initial bridge stranded-ref sweep failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        // The presence forwarder (chats-as-channels §6.8), independent of the
        // outbound entry-delivery block above: it needs only the bridge store,
        // the subject resolver, and a way to emit a live relay signal — never
        // `roomStore`/`roomAuthors`, which are entry-delivery-specific.
        if (deps.resolveBridgeSubject && deps.relaySignal) {
          const presence = new ChatBridgePresence({
            bridges: deps.roomBridges,
            resolveSubject: deps.resolveBridgeSubject,
            publisher: { signal: deps.relaySignal },
          });
          deps.registerSignalListener?.((roomId, signal, authorId, payload) => {
            // Only a whole `progress` payload is forwardable: `state` is what
            // decides the Telegram chat action, and a partial community-adapter
            // publish that omits it has nothing to forward (chats-as-channels
            // §6.8 is about the dispatcher's own claim lifecycle, which always
            // supplies all three fields — `publishPresence`'s dep type in
            // `room-trigger.ts` requires them).
            if (signal !== 'progress' || !payload?.state || !payload.entryId || !payload.since) {
              return;
            }
            presence.forward(roomId, authorId, {
              state: payload.state,
              entryId: payload.entryId,
              since: payload.since,
            });
          });
        }
      }

      subsystem.bindingRouter = new BindingRouter({
        bindingStore,
        relayCore: deps.relayCore,
        agentManager: sessionCreator,
        meshCore: deps.meshCore,
        relayDir,
        // Resolve runtime type per session from the consolidated DB so dispatch
        // subjects embed the runtime type (`relay.agent.<runtimeType>.<sessionId>`).
        // Legacy sessions without metadata are inferred as `'claude-code'`.
        runtimeResolver: {
          getSessionRuntimeType: (sessionId: string) =>
            runtimeRegistry.getSessionRuntimeType(sessionId),
        },
        eventRecorder: deps.eventRecorder,
        onFlow: deps.onFlow,
        unclaimedChats: deps.unclaimedChats,
        onUnclaimedChat: deps.onUnclaimedChat,
        onUnclaimedChatBurst: deps.onUnclaimedChatBurst,
        chatNotice,
        bridgeIngest,
      });
      await subsystem.bindingRouter.init();
      logger.info('[BindingSubsystem] BindingRouter initialized');

      return subsystem;
    } catch (err) {
      logger.error(
        '[BindingSubsystem] Failed to initialize binding subsystem — chat integrations ' +
          'will not be started, because without it messages have nowhere to route and ' +
          'no consent to check:',
        err
      );
      // Close whatever did open, then let the caller fail.
      if (subsystem) {
        await subsystem.shutdown().catch((closeErr: unknown) => {
          logger.warn('[BindingSubsystem] Cleanup after a failed init also failed:', closeErr);
        });
      }
      throw err;
    }
  }

  /** Get the BindingStore. */
  getBindingStore(): BindingStore {
    return this.bindingStore;
  }

  /** Get the AgentSessionStore. */
  getAgentSessionStore(): AgentSessionStore {
    return this.agentSessionStore;
  }

  /** Get the BindingRouter, or undefined if initialization did not reach that step. */
  getBindingRouter(): BindingRouter | undefined {
    return this.bindingRouter;
  }

  /**
   * Get the bridge lifecycle coordinator, or undefined when the rooms subsystem
   * is not wired. The cockpit's "Bridge to a channel" action (DOR-878) calls
   * {@link BridgeLifecycle.bridge}/`unbridge` through it.
   */
  getBridgeLifecycle(): BridgeLifecycle | undefined {
    return this.bridgeLifecycle;
  }

  /** Shut down the BindingRouter, AgentSessionStore, and BindingStore. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;
    this.bridgedAsks?.stop();
    this.bridgedAsks = undefined;
    if (this.bindingRouter) {
      await this.bindingRouter.shutdown();
    }
    await this.agentSessionStore.shutdown();
    await this.bindingStore.shutdown();
  }
}
