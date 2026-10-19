/**
 * The relay's adapter manager at startup: the chat integrations (Telegram,
 * Slack, webhooks) and the bindings that route their messages to agents
 * (DOR-2821, moved out of `index.ts` unchanged).
 *
 * Runs after Mesh, so the manager can place an agent on disk, and after the
 * runtimes, which it carries. A failure here is not fatal: the relay and Mesh
 * keep running, and the integrations stay off.
 *
 * @module startup/relay-adapters
 */
import path from 'node:path';
import type { AdapterRegistry, AgentRuntimeLike, RelayCore } from '@dorkos/relay';
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { logger, logError } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { AdapterManager, type AdapterManagerDeps } from '../services/relay/adapter-manager.js';
import { makeChatNoticeTargetResolver } from '../services/relay/binding-subsystem.js';
import {
  createInitiateConsentGate,
  createAgentSubjectResolver,
} from '../services/relay/initiate-consent.js';
import type { TraceStore } from '../services/relay/trace-store.js';
import { UnclaimedChatStore } from '../services/relay/unclaimed-chat-store.js';
import type { createRoomSubsystem } from '../services/rooms/index.js';
import { createRelayRefusedAskEmitter } from '../services/tasks/run-activity.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { RegisteredRuntimes } from './runtimes.js';
import { currentServerRole } from '../lib/server-role.js';
import { isPersonalComputer } from '../services/core/server-role/role-checks.js';

/** The rooms the bridge writes through, as `createRoomSubsystem` built them. */
type Rooms = ReturnType<typeof createRoomSubsystem>;

/** What starting the adapter manager needs from the startup that came before it. */
export interface RelayAdaptersStartupDeps {
  /** Whether relay is on for this boot. */
  relayEnabled: boolean;
  /** The relay, when it started. */
  relayCore: RelayCore | undefined;
  /** The adapter registry, when relay started. */
  adapterRegistry: AdapterRegistry | undefined;
  /** The relay trace store, when relay started. */
  traceStore: TraceStore | undefined;
  /** The runtime relay messages reach agents through. */
  relayAgentRuntime: RegisteredRuntimes['relayAgentRuntime'];
  /** The Claude Code runtime, for its transcript probe and its relay context. */
  claudeRuntime: RegisteredRuntimes['claudeRuntime'];
  /** The resolved DorkOS data directory. */
  dorkHome: string;
  /** The consolidated database. */
  db: Db;
  /** The task store, when Tasks is on. */
  taskStore: TaskStore | undefined;
  /** The activity feed. */
  activityService: ActivityService;
  /** The agent registry, when Mesh started. */
  meshCore: MeshCore | undefined;
  /** The room service. */
  roomService: Rooms['service'];
  /** The room store. */
  roomStore: Rooms['store'];
  /** The room author records. */
  roomAuthors: Rooms['authors'];
  /** The chat-to-room bridges. */
  roomBridges: Rooms['bridges'];
  /** The operator's author id in rooms. */
  resolveOperatorAuthorId: AdapterManagerDeps['operatorAuthorId'];
  /** The operator's display name in rooms. */
  resolveOperatorDisplayName: AdapterManagerDeps['operatorDisplayName'];
}

/**
 * Start the adapter manager, when relay is on and a runtime is bound for it.
 *
 * @param deps - See {@link RelayAdaptersStartupDeps}.
 * @returns The adapter manager, or `undefined` when relay is off or it failed to start.
 */
export async function startRelayAdapters(
  deps: RelayAdaptersStartupDeps
): Promise<AdapterManager | undefined> {
  const {
    relayEnabled,
    relayCore,
    adapterRegistry,
    traceStore,
    relayAgentRuntime,
    claudeRuntime,
    dorkHome,
    db,
    taskStore,
    activityService,
    meshCore,
    roomService,
    roomStore,
    roomAuthors,
    roomBridges,
    resolveOperatorAuthorId,
    resolveOperatorDisplayName,
  } = deps;
  let adapterManager: AdapterManager | undefined;
  // The relay carries EVERY registered runtime (DOR-1614), keyed by each
  // runtime's own `type` — never through the deprecated single-`agentManager`
  // field, whose compat wrap keys everything under `'claude-code'` (a lie in
  // test mode, and the reason binding routing was silently dead there). An
  // agent that runs on Codex or OpenCode answers a Telegram or Slack message on
  // the runtime its manifest names, the same one it answers a room on.
  //
  // `relayAgentRuntime`'s entry is written LAST so it wins ITS OWN key, and
  // that key alone. Two things make the ordering matter rather than be tidy:
  // `listRuntimes()` hands back trace-WRAPPED runtimes, and on the production
  // path this key is `claude-code` and the object is `claudeRuntime` — the very
  // instance `setRelayBindingContext` configures further down. The relay and
  // that wiring have to hold the same object, and last-write is what makes them.
  //
  // Under `DORKOS_TEST_RUNTIME` the key is `test-mode` instead, and
  // `setRelayBindingContext` is never called (there is no ClaudeCodeRuntime to
  // call it on). `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS` then registers a SECOND,
  // separate TestModeRuntime under `claude-code` (DOR-952) which
  // `relayAgentRuntime` is not — so do not read the rule as "relayAgentRuntime
  // is whatever answers `claude-code`". Nothing configures that alias and
  // nothing in test mode needs it configured; it exists so a seeded manifest
  // naming a real runtime enum resolves.
  if (relayEnabled && relayCore && adapterRegistry && traceStore && relayAgentRuntime) {
    try {
      const adapterConfigPath = path.join(dorkHome, 'relay', 'adapters.json');
      adapterManager = new AdapterManager(adapterRegistry, adapterConfigPath, {
        agentRuntimes: new Map<string, AgentRuntimeLike>([
          ...runtimeRegistry.listRuntimes().map((r): [string, AgentRuntimeLike] => [r.type, r]),
          // **The relay's default runtime, keyed by its own type but resolved
          // back through the REGISTRY.** `relayAgentRuntime` is the raw object
          // this function constructed; the registry holds the WRAPPED one
          // (tracing, and the DOR-1654 sign-in watch). This entry is appended
          // last and so wins on key collision, which means spelling the VALUE
          // `relayAgentRuntime` put the raw runtime in the map — and from there
          // into `deps.agentManager`, since `adapter-factory.ts`'s
          // `defaultRuntimeFor` reads this very map, and back over the map again
          // in `ClaudeCodeAdapter`'s constructor. Every relay turn on claude-code
          // then ran unwatched, so a Telegram-bridged agent on an expired
          // sign-in told nobody: the exact gap DOR-1654 exists to close.
          //
          // Resolved by TYPE, not by identity, so this entry and `agentManager`
          // are the SAME proxy instance — `register()` builds the wrapper once
          // and stores it, so repeated `get()` calls return one reference and
          // `ClaudeCodeAdapter`'s `r !== this.deps.agentManager` dedupe still
          // holds. Both paths that assign `relayAgentRuntime` register it first,
          // so this lookup cannot miss; if it ever did, throwing inside this
          // `try` costs the relay and says so, which beats seeding an unwatched
          // runtime in silence.
          //
          // `setRelayBindingContext` below deliberately keeps the RAW
          // `claudeRuntime`, and that is not an oversight: it calls a
          // ClaudeCodeRuntime-only method that is not part of `AgentRuntime`.
          // Two consumers, two objects, on purpose.
          [relayAgentRuntime.type, runtimeRegistry.get(relayAgentRuntime.type)],
        ]),
        traceStore,
        taskStore: taskStore,
        // A scheduled run that took the relay path is the ordinary case once an
        // adapter is connected, and until DOR-1580 it was the case where
        // "could not use that tool, nobody was there to approve it" reached the
        // run's summary and no further. Built here because this is the only
        // place that holds the whole `TaskStore` and the activity feed at once.
        ...(taskStore && {
          onRefusedAsk: createRelayRefusedAskEmitter({ taskStore, activityService }),
        }),
        relayCore,
        meshCore, // meshCore is now available
        eventRecorder: traceStore,
        traceEraser: traceStore,
        activityService,
        // The claim feed for unbound inbound chats (connection-scoping spec
        // §Part 3). Constructed here (rather than up front with the connector
        // stores) because it belongs to the relay/binding domain, not
        // connectors — it just happens to share the same `db`.
        unclaimedChats: new UnclaimedChatStore(db),
        // The rooms seams the inbound chat bridge writes through
        // (chats-as-channels §5). Threaded to the binding subsystem, which
        // builds the bridge where `bindingStore` and `chatNotice` already exist.
        roomService,
        roomBridges,
        // Session adoption at bridge time (chats-as-channels §7.3) probes the
        // DURABLE claude-code transcript on disk. Backed by the claude-code
        // runtime's own `TranscriptReader` so the runtime SDK stays confined to
        // its adapter dir; the reader is captured once (it is stable) and the
        // probe answers `canProbe` only for claude-code, so codex/opencode
        // sessions take the fresh-start path. Absent in test mode (no claude
        // runtime), where every bridge starts fresh.
        transcriptProbe: (() => {
          const reader = claudeRuntime?.getTranscriptReader();
          return reader
            ? {
                canProbe: (runtimeType: string) => runtimeType === 'claude-code',
                hasTranscript: (vaultRoot: string, sessionId: string) =>
                  reader.hasTranscript(vaultRoot, sessionId),
              }
            : undefined;
        })(),
        operatorAuthorId: resolveOperatorAuthorId,
        operatorDisplayName: resolveOperatorDisplayName,
        // The extra rooms reads outbound delivery needs (chats-as-channels §6):
        // read an entry by id, resolve an author, and register the inline
        // delivery hook on the room service.
        roomStore,
        roomAuthors,
        // The three seams the bridged Approve/Deny card needs beyond outbound
        // delivery's set (spec `ask-entitlement` §5): which room a session
        // answers for, who is on the other end of the chat, and — supplied by
        // the manager itself — that adapter's approver allowlist.
        roomSessionBindings: roomStore.sessionLedger,
        roomMembers: roomStore,
        registerEntryCommitListener: (listener) => roomService.setEntryCommitListener(listener),
        // The bridge's presence forwarder (§6.8): a room's live `progress`
        // signal becomes a relay signal on the bridged chat's subject, reusing
        // `RelayCore.signal` — the same ephemeral emit the Telegram adapter's
        // signal subscription already listens for — rather than the
        // publish/consent pipeline `relayCore.publish` runs for messages.
        relaySignal: (subject, signal) => relayCore.signal(subject, signal),
        registerSignalListener: (listener) => roomService.setSignalListener(listener),
        // Build a chat's outbound subject from its bridge row (§6.4). The
        // platform segment lives on the adapter's own subject prefix, not the
        // bridge row, so it is resolved from the adapter registry here — keeping
        // the delivery engine platform-agnostic. The prefix is instance-scoped
        // in production (`relay.human.telegram.<id>`); the fallback inserts the
        // adapter id when it is not, so both shapes round-trip through
        // `parseHumanSubject` to the same binding the consent gate resolves.
        resolveBridgeSubject: (bridge) => {
          const adapter = adapterRegistry?.get(bridge.adapterId);
          if (!adapter) return null;
          const prefixes = Array.isArray(adapter.subjectPrefix)
            ? adapter.subjectPrefix
            : [adapter.subjectPrefix];
          const prefix = prefixes[0];
          if (!prefix) return null;
          const base = prefix.endsWith(`.${bridge.adapterId}`)
            ? prefix
            : `${prefix}.${bridge.adapterId}`;
          const groupSegment = bridge.platformChatType === 'private' ? '' : '.group';
          return `${base}${groupSegment}.${bridge.chatId}`;
        },
      });
      await adapterManager.initialize();
      relayCore.setAdapterContextBuilder(adapterManager.buildContext.bind(adapterManager));

      // Provide relay binding context to runtime for <relay_connections> system prompt block
      const bindingRouter = adapterManager.getBindingRouter();
      const bindingStore = adapterManager.getBindingStore();
      if (claudeRuntime && bindingRouter && bindingStore) {
        claudeRuntime.setRelayBindingContext(bindingRouter, bindingStore, adapterManager);
      }

      // Enforce the DOR-239 "agent may start conversations" consent at the relay
      // delivery layer (DOR-277). This is the authoritative gate: every
      // agent-initiated send to a bound human channel — A2A, an external MCP
      // publish, or any other publish path — is denied unless the binding is enabled, consents,
      // and belongs to the sending agent.
      //
      // `initialize()` has already SCHEDULED the adapter starts by the time it
      // resolves, so this line is not protected by ordering. What protects it
      // is that the relay denies every send to a bound human channel until a
      // gate is installed: an adapter that connects a moment early cannot
      // deliver anything ungated, and never reaching this line silences chat
      // integrations rather than opening them.
      if (bindingStore) {
        relayCore.setInitiateConsentGate(
          createInitiateConsentGate({
            bindingStore,
            resolveAgentSubject: createAgentSubjectResolver(meshCore),
          })
        );
        // Same reasoning, same moment: the relay's chat-failure notice speaks on
        // a subject that came off a failed envelope's `replyTo`, which the
        // sender chose. Without this lookup it resolves nothing and
        // stays silent, so a missing wire closes the channel rather than opening
        // one into a chat nobody bound (DOR-789).
        relayCore.setChatNoticeTargetResolver(makeChatNoticeTargetResolver(bindingStore));
      }

      logger.info('[Relay] AdapterManager initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error('[Relay] Failed to initialize AdapterManager', errInfo);
      // Non-fatal: RelayCore and MeshCore remain operational.
      // Adapters (including ClaudeCodeAdapter) will be unavailable.
      adapterManager = undefined;
    }
  } else if (relayEnabled && relayCore && adapterRegistry && traceStore && !isPersonalComputer()) {
    // A hub runs no agents, so nothing on it can answer a chat app. Its
    // connections reach agents on the computers it starts instead. An agent
    // computer holds no connection's secrets at all (DOR-2940).
    logger.info(`[Relay] ${currentServerRole()}: chat app connections do not start on this server`);
  } else if (relayEnabled && relayCore && adapterRegistry && traceStore) {
    // Reachable only if a future branch registers runtimes without assigning
    // `relayAgentRuntime`. Silence here would look exactly like a relay that
    // works: adapters simply never start, and chat platforms go quiet.
    logger.error(
      '[Relay] No agent runtime bound for the relay — adapters will not start. ' +
        'Every runtime-registration branch in start() must assign relayAgentRuntime.'
    );
  }
  return adapterManager;
}
