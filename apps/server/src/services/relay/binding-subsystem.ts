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
import type { RelayFlowEvent } from '@dorkos/shared/relay-schemas';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { logger } from '../../lib/logger.js';
import { BindingStore } from './binding-store.js';
import { AgentSessionStore } from './agent-session-store.js';
import { BindingRouter, type RelayCoreLike, type AgentSessionCreator } from './binding-router.js';
import type { AdapterMeshCoreLike } from './adapter-manager.js';
import type { UnclaimedChat, UnclaimedChatStore } from './unclaimed-chat-store.js';

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

      // New sessions created by the BindingRouter (e.g., first chat-platform
      // message from a user) need a runtime to be created against. Existing
      // sessions route to their owning runtime via session_metadata.
      const agentManager = resolveSessionCreatorRuntime(deps.agentRuntimes);
      const sessionCreator: AgentSessionCreator = {
        async createSession(cwd: string, permissionMode: PermissionMode) {
          const id = crypto.randomUUID();
          // No fallback: the binding decides the mode (DOR-604).
          agentManager.ensureSession(id, { permissionMode, cwd });
          return { id };
        },
      };

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
        // Wired here, and never optional in the server: a refusal the person
        // never hears about is indistinguishable from an agent thinking.
        chatNotice: createChatNoticeSender({
          publish: (subject, payload, options) => deps.relayCore.publish(subject, payload, options),
          resolveTarget: makeChatNoticeTargetResolver(bindingStore),
          logger,
        }),
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

  /** Shut down the BindingRouter, AgentSessionStore, and BindingStore. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;
    if (this.bindingRouter) {
      await this.bindingRouter.shutdown();
    }
    await this.agentSessionStore.shutdown();
    await this.bindingStore.shutdown();
  }
}
