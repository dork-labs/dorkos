/**
 * Binding subsystem initialization for the Relay adapter manager.
 *
 * Owns BindingStore, AgentSessionStore, and BindingRouter lifecycle.
 * Created by AdapterManager after adapters have started. Non-fatal on
 * failure — adapters continue working without binding-based routing.
 *
 * @module services/relay/binding-subsystem
 */
import { dirname } from 'node:path';
import type { ClaudeCodeAgentRuntimeLike } from '@dorkos/relay';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { logger } from '../../lib/logger.js';
import { BindingStore } from './binding-store.js';
import { AgentSessionStore } from './agent-session-store.js';
import { BindingRouter, type RelayCoreLike, type AgentSessionCreator } from './binding-router.js';
import type { AdapterMeshCoreLike } from './adapter-manager.js';

/** Dependencies required to initialize the binding subsystem. */
export interface BindingSubsystemDeps {
  /** Relay publish/subscribe core. */
  relayCore: RelayCoreLike;
  /** MeshCore for resolving agent project paths. */
  meshCore: AdapterMeshCoreLike;
  /** Agent manager for creating new sessions. */
  agentManager: ClaudeCodeAgentRuntimeLike;
  /** Absolute path to the adapter config file (used to derive relayDir). */
  configPath: string;
  /**
   * Callback to resolve an enabled adapter instance ID by platform type.
   * Used by BindingRouter to determine which adapter instance to target.
   */
  resolveAdapterInstanceId: (platformType: string) => string | undefined;
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
   * Non-fatal — if initialization fails, returns undefined and logs a warning.
   * AdapterManager continues running without binding-based routing.
   *
   * @param deps - Required dependencies for subsystem initialization
   * @returns Initialized subsystem, or undefined on failure
   */
  static async init(deps: BindingSubsystemDeps): Promise<BindingSubsystem | undefined> {
    const relayDir = dirname(deps.configPath);
    try {
      const bindingStore = new BindingStore(relayDir);
      await bindingStore.init();
      logger.info('[BindingSubsystem] BindingStore initialized');

      const agentSessionStore = new AgentSessionStore(relayDir);
      await agentSessionStore.init();
      logger.info('[BindingSubsystem] AgentSessionStore initialized');

      const subsystem = new BindingSubsystem(bindingStore, agentSessionStore);

      const agentManager = deps.agentManager;
      const sessionCreator: AgentSessionCreator = {
        async createSession(cwd: string, permissionMode?: PermissionMode) {
          const id = crypto.randomUUID();
          agentManager.ensureSession(id, { permissionMode: permissionMode ?? 'acceptEdits', cwd });
          return { id };
        },
      };

      subsystem.bindingRouter = new BindingRouter({
        bindingStore,
        relayCore: deps.relayCore,
        agentManager: sessionCreator,
        meshCore: deps.meshCore,
        relayDir,
        resolveAdapterInstanceId: deps.resolveAdapterInstanceId,
      });
      await subsystem.bindingRouter.init();
      logger.info('[BindingSubsystem] BindingRouter initialized');

      return subsystem;
    } catch (err) {
      logger.warn('[BindingSubsystem] Failed to initialize binding subsystem:', err);
      // Non-fatal: adapters still work, just no binding-based routing
      return undefined;
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
