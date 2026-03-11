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
  AdapterStatus,
} from '@dorkos/relay';
import {
  TelegramAdapter,
  WebhookAdapter,
  ClaudeCodeAdapter,
  loadAdapters,
} from '@dorkos/relay';
import type {
  ClaudeCodeAgentRuntimeLike,
  TraceStoreLike,
  PulseStoreLike,
  AgentSessionStoreLike,
} from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { logger } from '../../lib/logger.js';

/** Dependencies for constructing runtime adapters. */
export interface AdapterFactoryDeps {
  agentManager: ClaudeCodeAgentRuntimeLike;
  traceStore: TraceStoreLike;
  pulseStore?: PulseStoreLike;
  /** Optional persistent store for agent key → SDK session UUID mappings. */
  agentSessionStore?: AgentSessionStoreLike;
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
  onPluginManifest?: (type: string, manifest: AdapterManifest) => void,
): Promise<RelayAdapter | null> {
  switch (config.type) {
    case 'telegram':
      return new TelegramAdapter(
        config.id,
        config.config as TelegramAdapterConfig,
      );
    case 'webhook':
      return new WebhookAdapter(
        config.id,
        config.config as WebhookAdapterConfig,
      );
    case 'claude-code':
      return new ClaudeCodeAdapter(
        config.id,
        config.config as Record<string, unknown>,
        {
          agentManager: deps.agentManager,
          traceStore: deps.traceStore,
          pulseStore: deps.pulseStore,
          agentSessionStore: deps.agentSessionStore,
          logger,
        },
      );
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
  adapter: RelayAdapter,
): Promise<{ ok: boolean; error?: string }> {
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
              CONNECTION_TEST_TIMEOUT_MS,
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
    };

    let fallbackTimer: NodeJS.Timeout;
    try {
      await Promise.race([
        adapter.start(noopRelay),
        new Promise<never>((_, reject) => {
          fallbackTimer = setTimeout(
            () => reject(new Error('Connection test timed out')),
            CONNECTION_TEST_TIMEOUT_MS,
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
  onPluginManifest?: (type: string, manifest: AdapterManifest) => void,
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
    configDir,
  );

  const result = results[0];
  if (!result) return null;

  // Register plugin manifest if discovered
  if (result.manifest && onPluginManifest) {
    onPluginManifest(config.type, result.manifest);
  }

  return result.adapter;
}
