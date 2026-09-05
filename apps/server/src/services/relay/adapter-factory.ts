/**
 * Adapter instance creation and plugin loading.
 *
 * Extracted from adapter-manager.ts to keep file sizes manageable.
 * Provides factory functions for creating adapter instances from config.
 *
 * @module services/relay/adapter-factory
 */
import { dirname } from 'node:path';
import type {
  RelayAdapter,
  AdapterConfig,
  TelegramAdapterConfig,
  WebhookAdapterConfig,
  SlackAdapterConfig,
  AdapterStatus,
} from '@dorkos/relay';
import {
  TelegramAdapter,
  WebhookAdapter,
  SlackAdapter,
  ClaudeCodeAdapter,
  loadAdapters,
} from '@dorkos/relay';
import type {
  AgentRuntimeLike,
  ApprovalAuthorizer,
  InboundTurnBudgets,
  TraceStoreLike,
  TasksStoreLike,
  AgentSessionStoreLike,
} from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { logger, createTaggedLogger } from '../../lib/logger.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { resolveTurnRuntimeType } from '../runtimes/shared/resolve-agent-runtime-type.js';
import { AdapterError } from './adapter-error.js';
import { createTurnExecutionSettingsResolver } from './turn-execution-settings.js';

/** Dependencies for constructing runtime adapters. */
export interface AdapterFactoryDeps {
  /**
   * Runtime-type → agent-runtime map. The factory picks the correct
   * runtime when constructing a runtime-specific adapter (e.g., the
   * ClaudeCodeAdapter receives its default entry). Throws {@link AdapterError}
   * `NO_AGENT_RUNTIMES` when the map is empty.
   */
  agentRuntimes: Map<string, AgentRuntimeLike>;
  traceStore: TraceStoreLike;
  taskStore?: TasksStoreLike;
  /** Optional persistent store for agent key → SDK session UUID mappings. */
  agentSessionStore?: AgentSessionStoreLike;
  /**
   * Whether a click on a chat platform may authorize one session's tool call
   * (spec `ask-entitlement` §5.3). Required so a caller cannot forget it — the
   * same posture-as-data argument `UpgradeRoute.credential` makes.
   */
  approvalAuthorizer: ApprovalAuthorizer;
  /**
   * Where a running agent turn records the envelope it is answering, so that
   * turn's own `relay_send*` calls continue that budget (DOR-791). This is
   * `RelayCore.inboundBudgets` — the SAME instance the in-session tool surface
   * reads back from; a second one would thread nothing and fail silently.
   */
  inboundBudgets?: InboundTurnBudgets;
}

/**
 * The runtime the built-in adapter falls back to for a message that NAMES none.
 *
 * A legacy three-token `relay.agent.<sessionId>` subject and a task dispatch
 * with no `runtime` field both arrive without one, and something has to run
 * them. Three tiers, narrowing to the honest answer:
 *
 * 1. `claude-code` — the adapter config entry's own id and the runtime it was
 *    born driving, so on any ordinary install this is it.
 * 2. The registry's default type — the answer on a build where claude-code is
 *    not registered at all. A test-mode server is exactly that, and the old
 *    hardcoded lookup left its built-in adapter refusing to start: the map is
 *    keyed `test-mode` there and nothing ever asked for it, so the relay came
 *    up silent with one warn line.
 * 3. The map's first entry — last resort, so a degraded build with some other
 *    single runtime still answers rather than going quiet.
 *
 * @param agentRuntimes - Runtime-type → runtime map held by the AdapterManager.
 * @param adapterId - The adapter being built, for the error message.
 * @throws {AdapterError} `NO_AGENT_RUNTIMES` when the map holds no runtimes at
 *   all. Its own code rather than a runtime-not-registered error: an empty map
 *   names no runtime and involves no session, and reporting it as "runtime
 *   'claude-code' missing for session '<adapterId>'" — which it used to — sent
 *   whoever read the log looking for a session that never existed.
 */
function defaultRuntimeFor(
  agentRuntimes: Map<string, AgentRuntimeLike>,
  adapterId: string
): AgentRuntimeLike {
  const runtime =
    agentRuntimes.get('claude-code') ??
    agentRuntimes.get(runtimeRegistry.getDefaultType()) ??
    agentRuntimes.values().next().value;
  if (!runtime) {
    throw new AdapterError(
      `Cannot build the built-in adapter '${adapterId}': this server registered no agent ` +
        `runtimes at all. The composition root must pass 'agentRuntimes' to AdapterManager.`,
      'NO_AGENT_RUNTIMES'
    );
  }
  return runtime;
}

/** Default status for adapters that are not currently running. */
export function defaultAdapterStatus(): AdapterStatus {
  return {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };
}

/**
 * Create an adapter instance from its config.
 *
 * Handles built-in types (telegram, webhook, claude-code) directly,
 * delegates plugin types to {@link loadPluginAdapter}.
 *
 * @param config - The adapter configuration entry
 * @param deps - Dependencies for constructing runtime adapters
 * @param configPath - Absolute path to adapters.json (for plugin resolution)
 * @param onPluginManifest - Callback to register a plugin-discovered manifest
 * @returns The adapter instance, or null for unknown/unloadable types
 */
export async function createAdapter(
  config: AdapterConfig,
  deps: AdapterFactoryDeps,
  configPath: string,
  onPluginManifest?: (type: string, manifest: AdapterManifest) => void
): Promise<RelayAdapter | null> {
  switch (config.type) {
    case 'telegram': {
      const adapter = new TelegramAdapter(config.id, config.config as TelegramAdapterConfig);
      adapter.setLogger(createTaggedLogger(`telegram:${config.id}`));
      return adapter;
    }
    case 'webhook':
      return new WebhookAdapter(config.id, config.config as WebhookAdapterConfig);
    case 'slack': {
      const adapter = new SlackAdapter(config.id, config.config as SlackAdapterConfig);
      adapter.setLogger(createTaggedLogger(`slack:${config.id}`));
      return adapter;
    }
    case 'claude-code': {
      // What answers a message that names no runtime; the adapter drives the
      // rest of the map per message (DOR-1614).
      const agentManager = defaultRuntimeFor(deps.agentRuntimes, config.id);
      return new ClaudeCodeAdapter(config.id, config.config as Record<string, unknown>, {
        agentManager,
        agentRuntimes: deps.agentRuntimes,
        traceStore: deps.traceStore,
        taskStore: deps.taskStore,
        agentSessionStore: deps.agentSessionStore,
        // What the turn runs on. One resolver for every runtime: the adapter
        // resolves which runtime a message belongs to and asks about THAT one,
        // so the answer is per turn rather than per adapter (DOR-1614).
        resolveExecutionSettings: createTurnExecutionSettingsResolver(),
        // Who answers a message addressed to an AGENT rather than a session —
        // the shape an agent-to-agent `relay_send` arrives on. The same single
        // copy of the binding-then-manifest ladder rooms and the chat bindings
        // ask, so one agent DM'ing another cannot get a different program than
        // the same agent reached from Telegram would (DOR-1627), and a
        // conversation that already has an owner keeps it (DOR-1774).
        resolveTurnRuntimeType: ({ agentDirectory, sessionId }) =>
          resolveTurnRuntimeType({ sessionId, agentPath: agentDirectory }),
        // And where that owner gets written. The relay is the only thing that
        // can record it for this shape: a mesh endpoint creates no session, so
        // no session-creation path ever ran for it. First-write-wins inside the
        // registry, so a turn on a conversation somebody already bound changes
        // nothing (DOR-1774).
        bindSessionRuntime: async ({ sessionId, runtimeType, agentDirectory }) => {
          await runtimeRegistry.persistSessionRuntime(sessionId, runtimeType, agentDirectory);
        },
        // Every approval that arrives on the relay bus is checked here too,
        // before the runtime is touched (spec `ask-entitlement` §5.3).
        approvalAuthorizer: deps.approvalAuthorizer,
        inboundBudgets: deps.inboundBudgets,
        logger,
      });
    }
    case 'plugin':
      return loadPluginAdapter(config, configPath, onPluginManifest);
    default:
      logger.warn(`[AdapterFactory] Unknown adapter type: ${(config as AdapterConfig).type}`);
      return null;
  }
}

/** Timeout for connection test attempts (ms). */
const CONNECTION_TEST_TIMEOUT_MS = 15_000;

/**
 * Test connectivity for an adapter without registering it.
 *
 * Prefers the adapter's own `testConnection()` method when available.
 * Falls back to a start/stop cycle for adapters without it.
 *
 * @param adapter - The adapter instance to test
 * @returns Result indicating success or failure with an error message
 */
export async function testAdapterConnection(
  adapter: RelayAdapter
): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
  try {
    // Prefer lightweight testConnection() -- avoids starting polling loops,
    // webhook servers, or other long-running processes that can cause
    // conflicts (e.g., Telegram 409) when the real adapter starts later.
    if (adapter.testConnection) {
      let timer: NodeJS.Timeout;
      try {
        return await Promise.race([
          adapter.testConnection(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Connection test timed out')),
              CONNECTION_TEST_TIMEOUT_MS
            );
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
    }

    // Fallback: start/stop cycle for adapters without testConnection()
    const noopRelay = {
      publish: async () => ({ messageId: '', deliveredTo: 0 }),
      onSignal: () => () => {},
      subscribe: () => () => {},
    };

    let fallbackTimer: NodeJS.Timeout;
    try {
      await Promise.race([
        adapter.start(noopRelay),
        new Promise<never>((_, reject) => {
          fallbackTimer = setTimeout(
            () => reject(new Error('Connection test timed out')),
            CONNECTION_TEST_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      clearTimeout(fallbackTimer!);
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    try {
      await adapter.stop();
    } catch {
      /* swallow stop errors */
    }
  }
}

/**
 * Load a plugin adapter via dynamic import.
 *
 * @param config - The adapter config with plugin source info
 * @param configPath - Absolute path to adapters.json (for relative plugin resolution)
 * @param onPluginManifest - Callback to register a plugin-discovered manifest
 * @returns The loaded adapter instance, or null on failure
 */
async function loadPluginAdapter(
  config: AdapterConfig,
  configPath: string,
  onPluginManifest?: (type: string, manifest: AdapterManifest) => void
): Promise<RelayAdapter | null> {
  if (!config.plugin) {
    logger.warn(`[AdapterFactory] Plugin adapter '${config.id}' missing plugin source config`);
    return null;
  }

  const builtinMap = new Map<string, (id: string, c: Record<string, unknown>) => RelayAdapter>();
  const configDir = dirname(configPath);
  const results = await loadAdapters(
    [
      {
        id: config.id,
        type: config.type,
        enabled: config.enabled,
        plugin: config.plugin,
        config: config.config as Record<string, unknown>,
      },
    ],
    builtinMap,
    configDir
  );

  const result = results[0];
  if (!result) return null;

  // Register plugin manifest if discovered
  if (result.manifest && onPluginManifest) {
    onPluginManifest(config.type, result.manifest);
  }

  return result.adapter;
}
