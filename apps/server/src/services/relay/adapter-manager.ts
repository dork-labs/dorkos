/**
 * Server-side adapter lifecycle manager for the Relay message bus.
 *
 * Loads adapter configurations from disk (`~/.dork/relay/adapters.json`),
 * instantiates the appropriate adapter implementation for each entry, and
 * watches the config file for hot-reload via chokidar.
 *
 * Supports built-in adapters (telegram, webhook, claude-code), npm plugin
 * packages, and local file plugins. Generates default config with claude-code
 * adapter when none exists. Optionally enriches AdapterContext with Mesh
 * agent info when meshCore is provided.
 *
 * @module services/relay/adapter-manager
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join as pathJoin } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  AdapterRegistry,
  RelayAdapter,
  AdapterConfig,
  TelegramAdapterConfig,
  WebhookAdapterConfig,
  AdapterContext,
} from '@dorkos/relay';
import {
  TelegramAdapter,
  WebhookAdapter,
  ClaudeCodeAdapter,
  loadAdapters,
  TELEGRAM_MANIFEST,
  WEBHOOK_MANIFEST,
  CLAUDE_CODE_MANIFEST,
} from '@dorkos/relay';
import type {
  ClaudeCodeAgentManagerLike,
  TraceStoreLike,
  PulseStoreLike,
} from '@dorkos/relay';
import { AdaptersConfigFileSchema } from '@dorkos/shared/relay-schemas';
import type { AdapterManifest, CatalogEntry } from '@dorkos/shared/relay-schemas';
import type { AdapterStatus } from '@dorkos/relay';
import { logger } from '../../lib/logger.js';
import { BindingStore } from './binding-store.js';
import { BindingRouter, type RelayCoreLike, type AgentSessionCreator } from './binding-router.js';

/**
 * Error class for adapter CRUD operations.
 *
 * Includes a machine-readable `code` for programmatic error handling.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'DUPLICATE_ID'
      | 'NOT_FOUND'
      | 'UNKNOWN_TYPE'
      | 'MULTI_INSTANCE_DENIED'
      | 'REMOVE_BUILTIN_DENIED',
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Timeout for connection test attempts (ms). */
const CONNECTION_TEST_TIMEOUT_MS = 15_000;

/** Chokidar stability threshold before triggering hot-reload (ms). */
const CONFIG_STABILITY_THRESHOLD_MS = 150;

/** Chokidar poll interval for write-finish detection (ms). */
const CONFIG_POLL_INTERVAL_MS = 50;

/** Default status for adapters that are not currently running. */
function defaultAdapterStatus(): AdapterStatus {
  return {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };
}

/** Dependencies for constructing runtime adapters. */
export interface AdapterManagerDeps {
  agentManager: ClaudeCodeAgentManagerLike;
  traceStore: TraceStoreLike;
  pulseStore?: PulseStoreLike;
  /** Optional RelayCore for binding subsystem initialization */
  relayCore?: RelayCoreLike;
  /** Optional MeshCore for enriching AdapterContext with agent info */
  meshCore?: {
    getAgent(id: string): { manifest: Record<string, unknown> } | undefined;
  };
}

/**
 * Server-side adapter lifecycle manager.
 *
 * Reads adapter config from a JSON file, instantiates adapters via
 * {@link AdapterRegistry}, and watches for config file changes to
 * perform hot-reload reconciliation.
 */
export class AdapterManager {
  private readonly registry: AdapterRegistry;
  private configWatcher: FSWatcher | null = null;
  private readonly configPath: string;
  private configs: AdapterConfig[] = [];
  private readonly deps: AdapterManagerDeps;
  private manifests = new Map<string, AdapterManifest>();
  private bindingStore?: BindingStore;
  private bindingRouter?: BindingRouter;

  /**
   * @param registry - The adapter registry managing adapter lifecycle
   * @param configPath - Absolute path to the adapters config JSON file
   * @param deps - Dependencies for constructing runtime adapters
   */
  constructor(
    registry: AdapterRegistry,
    configPath: string,
    deps: AdapterManagerDeps,
  ) {
    this.registry = registry;
    this.configPath = configPath;
    this.deps = deps;
  }

  /**
   * Load config from disk, start all enabled adapters, and begin watching for changes.
   *
   * Generates a default adapters.json with claude-code enabled when no config exists.
   * Should be called once during server startup.
   */
  async initialize(): Promise<void> {
    this.populateBuiltinManifests();
    await this.ensureDefaultConfig();
    await this.loadConfig();
    await this.startEnabledAdapters();
    this.startConfigWatcher();
    await this.initBindingSubsystem();
  }

  /**
   * Initialize the binding store and router subsystem.
   *
   * Creates a BindingStore and BindingRouter inside the relay data directory
   * (derived from the adapter config path). Non-fatal: failures are logged
   * but do not block adapter startup.
   */
  private async initBindingSubsystem(): Promise<void> {
    if (!this.deps.relayCore) {
      logger.info('[AdapterManager] relayCore not provided, skipping binding subsystem');
      return;
    }

    const relayDir = dirname(this.configPath);
    try {
      this.bindingStore = new BindingStore(relayDir);
      await this.bindingStore.init();
      logger.info('[AdapterManager] BindingStore initialized');

      // Adapt ClaudeCodeAgentManagerLike to AgentSessionCreator interface.
      // ensureSession registers a session entry; the returned id is used by
      // BindingRouter for relay.agent.{sessionId} republishing.
      const agentManager = this.deps.agentManager;
      const sessionCreator: AgentSessionCreator = {
        async createSession(cwd: string) {
          const id = crypto.randomUUID();
          agentManager.ensureSession(id, { permissionMode: 'auto', cwd });
          return { id };
        },
      };

      this.bindingRouter = new BindingRouter({
        bindingStore: this.bindingStore,
        relayCore: this.deps.relayCore,
        agentManager: sessionCreator,
        relayDir,
        // Resolve platform type (e.g., 'telegram') → adapter instance ID
        // by matching against configured adapter types in the registry.
        resolveAdapterInstanceId: (platformType: string) => {
          const match = this.configs.find((c) => c.type === platformType && c.enabled);
          return match?.id;
        },
      });
      await this.bindingRouter.init();
      logger.info('[AdapterManager] BindingRouter initialized');
    } catch (err) {
      logger.warn('[AdapterManager] Failed to initialize binding subsystem:', err);
      // Non-fatal: adapters still work, just no binding-based routing
    }
  }

  /**
   * Reload config from disk and reconcile adapter state.
   *
   * Stops adapters that were removed or disabled, starts newly enabled adapters.
   */
  async reload(): Promise<void> {
    const oldConfigIds = new Set(this.configs.map((c) => c.id));
    await this.loadConfig();

    // Stop adapters that are no longer in config or are now disabled
    for (const id of oldConfigIds) {
      const newConfig = this.configs.find((c) => c.id === id);
      if (!newConfig || !newConfig.enabled) {
        try {
          await this.registry.unregister(id);
        } catch (err) {
          logger.warn(`[AdapterManager] Failed to unregister adapter '${id}':`, err);
        }
      }
    }

    // Start/update enabled adapters
    await this.startEnabledAdapters();
  }

  /**
   * Enable a specific adapter by ID and persist the change to disk.
   *
   * @param id - The adapter ID to enable
   * @throws If the adapter ID is not found in the config
   */
  async enable(id: string): Promise<void> {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);

    config.enabled = true;
    await this.saveConfig();

    const adapter = await this.createAdapter(config);
    if (adapter) {
      await this.registry.register(adapter);
    }
  }

  /**
   * Disable a specific adapter by ID and persist the change to disk.
   *
   * @param id - The adapter ID to disable
   * @throws If the adapter ID is not found in the config
   */
  async disable(id: string): Promise<void> {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);

    config.enabled = false;
    await this.saveConfig();
    await this.registry.unregister(id);
  }

  /**
   * List all adapter configs paired with their current runtime status.
   */
  listAdapters(): Array<{ config: AdapterConfig; status: AdapterStatus }> {
    return this.configs.map((config) => {
      const adapter = this.registry.get(config.id);
      const status: AdapterStatus = adapter?.getStatus() ?? defaultAdapterStatus();
      const manifest = this.manifests.get(config.type);
      const maskedConfig = {
        ...config,
        config: this.maskSensitiveFields(
          config.config as Record<string, unknown>,
          manifest,
        ),
      };
      return { config: maskedConfig, status };
    });
  }

  /**
   * Get a single adapter's config and status.
   *
   * @param id - The adapter ID to look up
   * @returns The config and status, or undefined if not found
   */
  getAdapter(id: string): { config: AdapterConfig; status: AdapterStatus } | undefined {
    const config = this.configs.find((c) => c.id === id);
    if (!config) return undefined;

    const adapter = this.registry.get(id);
    const status: AdapterStatus = adapter?.getStatus() ?? defaultAdapterStatus();
    return { config, status };
  }

  /**
   * Get the underlying AdapterRegistry.
   *
   * Used by webhook routes to call `handleInbound` on specific adapters.
   */
  getRegistry(): AdapterRegistry {
    return this.registry;
  }

  /**
   * Get the BindingStore for adapter-agent binding management.
   *
   * Returns undefined if the binding subsystem was not initialized
   * (e.g., relayCore not provided or initialization failed).
   */
  getBindingStore(): BindingStore | undefined {
    return this.bindingStore;
  }

  /**
   * Get the BindingRouter for session lifecycle management.
   *
   * Returns undefined if the binding subsystem was not initialized.
   */
  getBindingRouter(): BindingRouter | undefined {
    return this.bindingRouter;
  }

  /**
   * Enrich AdapterContext with Mesh agent info if meshCore is available.
   *
   * Extracts the agent ID from the subject (e.g., relay.agent.{agentId})
   * and looks up the agent manifest in the Mesh registry.
   *
   * @param subject - The relay subject to extract agent ID from
   * @returns Enriched AdapterContext, or undefined if no mesh info available
   */
  buildContext(subject: string): AdapterContext | undefined {
    if (!this.deps.meshCore) return undefined;
    if (!subject.startsWith('relay.agent.')) return undefined;

    const segments = subject.split('.');
    const sessionId = segments[2]; // relay.agent.{sessionId}
    if (!sessionId) return undefined;

    const agentInfo = this.deps.meshCore.getAgent(sessionId);
    if (!agentInfo) return undefined;

    const manifest = agentInfo.manifest;
    return {
      agent: {
        directory: (manifest.directory as string) ?? process.cwd(),
        runtime: (manifest.runtime as string) ?? 'claude-code',
        manifest,
      },
    };
  }

  /**
   * Test connectivity for an adapter type and config without registering it.
   *
   * Prefers the adapter's own `testConnection()` method when available, which
   * validates credentials without starting long-running processes (e.g.,
   * Telegram polling loops). Falls back to a start/stop cycle for adapters
   * that don't implement the lightweight test path.
   *
   * @param type - The adapter type (e.g., 'telegram', 'webhook')
   * @param config - The adapter-specific configuration to test
   * @returns Result indicating success or failure with an error message
   */
  async testConnection(
    type: string,
    config: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const manifest = this.manifests.get(type);
    if (!manifest) {
      return { ok: false, error: `Unknown adapter type: ${type}` };
    }

    const tempConfig = {
      id: `__test_${type}_${Date.now()}`,
      type,
      enabled: true,
      builtin: manifest.builtin,
      config,
    } as AdapterConfig;

    let adapter: RelayAdapter | null = null;
    try {
      adapter = await this.createAdapter(tempConfig);
      if (!adapter) {
        return { ok: false, error: 'Failed to create adapter instance' };
      }

      // Prefer lightweight testConnection() — avoids starting polling loops,
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
      if (adapter) {
        try {
          await adapter.stop();
        } catch {
          /* swallow stop errors */
        }
      }
    }
  }

  /**
   * Add a new adapter instance, persist config, and start it if enabled.
   *
   * @param type - The adapter type (must match a known manifest)
   * @param id - Unique adapter ID
   * @param config - Adapter-specific configuration
   * @param enabled - Whether to start the adapter immediately (default true)
   * @throws {AdapterError} DUPLICATE_ID, UNKNOWN_TYPE, or MULTI_INSTANCE_DENIED
   */
  async addAdapter(
    type: string,
    id: string,
    config: Record<string, unknown>,
    enabled = true,
  ): Promise<void> {
    if (this.configs.some((c) => c.id === id)) {
      throw new AdapterError(`Adapter with ID '${id}' already exists`, 'DUPLICATE_ID');
    }

    const manifest = this.manifests.get(type);
    if (!manifest) {
      throw new AdapterError(`Unknown adapter type: ${type}`, 'UNKNOWN_TYPE');
    }

    if (!manifest.multiInstance) {
      const existing = this.configs.find((c) => c.type === type);
      if (existing) {
        throw new AdapterError(
          `Adapter type '${type}' does not support multiple instances. Existing: '${existing.id}'`,
          'MULTI_INSTANCE_DENIED',
        );
      }
    }

    const adapterConfig = {
      id,
      type,
      enabled,
      builtin: manifest.builtin,
      config,
    } as AdapterConfig;
    this.configs.push(adapterConfig);
    await this.saveConfig();

    if (enabled) {
      const adapter = await this.createAdapter(adapterConfig);
      if (adapter) {
        await this.registry.register(adapter);
      }
    }
  }

  /**
   * Remove an adapter instance, stop it if running, and persist the change.
   *
   * After removal, checks for orphaned bindings (bindings referencing adapters
   * that no longer exist) and logs a warning if any are found.
   *
   * @param id - The adapter ID to remove
   * @throws {AdapterError} NOT_FOUND or REMOVE_BUILTIN_DENIED
   */
  async removeAdapter(id: string): Promise<void> {
    const index = this.configs.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new AdapterError(`Adapter '${id}' not found`, 'NOT_FOUND');
    }

    const config = this.configs[index];

    if (config.type === 'claude-code' && config.builtin) {
      throw new AdapterError(
        'Cannot remove the built-in claude-code adapter',
        'REMOVE_BUILTIN_DENIED',
      );
    }

    try {
      await this.registry.unregister(id);
    } catch {
      /* not running — ignore */
    }

    this.configs.splice(index, 1);
    await this.saveConfig();

    // Check for orphaned bindings after adapter removal
    if (this.bindingStore) {
      const knownAdapterIds = this.configs.map((c) => c.id);
      const orphaned = this.bindingStore.getOrphaned(knownAdapterIds);
      if (orphaned.length > 0) {
        logger.warn(
          `[AdapterManager] ${orphaned.length} orphaned binding(s) detected after removing adapter '${id}'. ` +
          `Binding IDs: ${orphaned.map((b) => b.id).join(', ')}. ` +
          `Delete them via DELETE /api/relay/bindings/:id to clean up.`,
        );
      }
    }
  }

  /**
   * Update an adapter's config with password field preservation.
   *
   * When a password field's incoming value is empty, `'***'`, or undefined,
   * the existing value is preserved. Restarts the adapter if it is currently running.
   *
   * @param id - The adapter ID to update
   * @param newConfig - Partial config to merge
   * @throws {AdapterError} NOT_FOUND
   */
  async updateConfig(id: string, newConfig: Record<string, unknown>): Promise<void> {
    const existing = this.configs.find((c) => c.id === id);
    if (!existing) {
      throw new AdapterError(`Adapter '${id}' not found`, 'NOT_FOUND');
    }

    const manifest = this.manifests.get(existing.type);
    const mergedConfig = this.mergeWithPasswordPreservation(
      existing.config as Record<string, unknown>,
      newConfig,
      manifest,
    );

    existing.config = mergedConfig;
    await this.saveConfig();

    // Restart adapter if running
    if (existing.enabled && this.registry.get(id)) {
      try {
        await this.registry.unregister(id);
      } catch {
        /* ignore */
      }
      const adapter = await this.createAdapter(existing);
      if (adapter) await this.registry.register(adapter);
    }
  }

  /**
   * Stop all adapters and the config file watcher.
   *
   * Should be called during server shutdown, before RelayCore shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.bindingRouter) {
      await this.bindingRouter.shutdown();
      this.bindingRouter = undefined;
    }
    if (this.bindingStore) {
      await this.bindingStore.shutdown();
      this.bindingStore = undefined;
    }
    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = null;
    }
    await this.registry.shutdown();
  }

  /**
   * Read and parse the adapter config file.
   *
   * Handles missing file (empty adapter list) and malformed JSON (logs
   * warning and falls back to empty list). Never throws.
   */
  private async loadConfig(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf-8');
      const parsed = AdaptersConfigFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.configs = parsed.data.adapters;
      } else {
        logger.warn(
          '[AdapterManager] Malformed config, skipping invalid entries:',
          parsed.error.flatten(),
        );
        this.configs = [];
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No config file = no adapters (not an error)
        this.configs = [];
      } else {
        logger.warn('[AdapterManager] Failed to read config:', err);
        this.configs = [];
      }
    }
  }

  /**
   * Persist the current adapter configs to disk.
   *
   * Creates the parent directory if it does not exist.
   */
  private async saveConfig(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmpPath = `${this.configPath}.tmp`;
    await writeFile(
      tmpPath,
      JSON.stringify({ adapters: this.configs }, null, 2),
      'utf-8',
    );
    await rename(tmpPath, this.configPath);
  }

  /**
   * Generate a default adapters.json with claude-code enabled when no config exists.
   *
   * Called during initialize() if no config file exists and Relay is enabled.
   * Never throws — failures are logged as warnings.
   */
  private async ensureDefaultConfig(): Promise<void> {
    try {
      await readFile(this.configPath, 'utf-8');
      // Config exists — nothing to do
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const defaultConfig = {
          adapters: [
            {
              id: 'claude-code',
              type: 'claude-code',
              builtin: true,
              enabled: true,
              config: {
                maxConcurrent: 3,
                defaultTimeoutMs: 300_000,
              },
            },
          ],
        };
        try {
          await mkdir(dirname(this.configPath), { recursive: true });
          await writeFile(
            this.configPath,
            JSON.stringify(defaultConfig, null, 2),
            'utf-8',
          );
          logger.info('[AdapterManager] Generated default adapters.json with claude-code adapter');
        } catch (writeErr) {
          logger.warn('[AdapterManager] Failed to write default config:', writeErr);
        }
      }
    }
  }

  /**
   * Start all enabled adapters that are not already running.
   *
   * Individual adapter startup failures are logged but do not prevent
   * other adapters from starting.
   */
  private async startEnabledAdapters(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) continue;
      if (this.registry.get(config.id)) continue; // Already running

      const adapter = await this.createAdapter(config);
      if (adapter) {
        try {
          await this.registry.register(adapter);
        } catch (err) {
          logger.warn(`[AdapterManager] Failed to start adapter '${config.id}':`, err);
        }
      }
    }
  }

  /**
   * Create an adapter instance from its config.
   *
   * Async to support plugin loading via dynamic import.
   *
   * @param config - The adapter configuration entry
   * @returns The adapter instance, or null for unknown/unloadable types
   */
  private async createAdapter(config: AdapterConfig): Promise<RelayAdapter | null> {
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
            agentManager: this.deps.agentManager,
            traceStore: this.deps.traceStore,
            pulseStore: this.deps.pulseStore,
          },
        );
      case 'plugin':
        return this.loadPlugin(config);
      default:
        logger.warn(`[AdapterManager] Unknown adapter type: ${(config as AdapterConfig).type}`);
        return null;
    }
  }

  /**
   * Load a plugin adapter via dynamic import.
   *
   * @param config - The adapter config with plugin source info
   * @returns The loaded adapter instance, or null on failure
   */
  private async loadPlugin(config: AdapterConfig): Promise<RelayAdapter | null> {
    if (!config.plugin) {
      logger.warn(`[AdapterManager] Plugin adapter '${config.id}' missing plugin source config`);
      return null;
    }

    const builtinMap = new Map<string, (c: Record<string, unknown>) => RelayAdapter>();
    const configDir = dirname(this.configPath);
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
    if (result.manifest) {
      this.registerPluginManifest(config.type, result.manifest);
    }

    return result.adapter;
  }

  /**
   * Return the full adapter catalog with manifests and configured instances.
   *
   * Each entry pairs a manifest with all configured instances of that type,
   * including their enabled state and runtime status.
   */
  getCatalog(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const [type, manifest] of this.manifests) {
      const instances = this.configs
        .filter((c) => c.type === type)
        .map((c) => {
          const adapter = this.registry.get(c.id);
          const baseStatus = adapter?.getStatus() ?? {
            state: 'disconnected' as const,
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          };
          return {
            id: c.id,
            enabled: c.enabled,
            status: {
              id: c.id,
              type: c.type,
              displayName: manifest.displayName,
              ...baseStatus,
            },
            config: this.maskSensitiveFields(
              (c.config ?? {}) as Record<string, unknown>,
              manifest,
            ),
          };
        });
      entries.push({ manifest, instances });
    }
    return entries;
  }

  /**
   * Get a manifest by adapter type.
   *
   * @param type - The adapter type to look up
   */
  getManifest(type: string): AdapterManifest | undefined {
    return this.manifests.get(type);
  }

  /**
   * Register a plugin-discovered manifest for a given adapter type.
   *
   * @param type - The adapter type key
   * @param manifest - The manifest to register
   */
  registerPluginManifest(type: string, manifest: AdapterManifest): void {
    this.manifests.set(type, manifest);
  }

  /** Populate the manifests map with built-in adapter manifests. */
  private populateBuiltinManifests(): void {
    this.manifests.set('telegram', TELEGRAM_MANIFEST);
    this.manifests.set('webhook', WEBHOOK_MANIFEST);
    this.manifests.set('claude-code', CLAUDE_CODE_MANIFEST);
  }

  /**
   * Mask password-type fields in an adapter config using the manifest definition.
   *
   * Supports dot-notation keys (e.g., `inbound.secret`) by traversing nested objects.
   *
   * @param config - The raw config object
   * @param manifest - The adapter manifest with field definitions
   * @returns A deep copy of config with password fields replaced by `'***'`
   */
  private maskSensitiveFields(
    config: Record<string, unknown>,
    manifest?: AdapterManifest,
  ): Record<string, unknown> {
    if (!manifest) return config;
    const masked = structuredClone(config) as Record<string, unknown>;
    for (const field of manifest.configFields) {
      if (field.type !== 'password') continue;
      const parts = field.key.split('.');
      let current: Record<string, unknown> = masked;
      let found = true;
      for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] && typeof current[parts[i]] === 'object') {
          current = current[parts[i]] as Record<string, unknown>;
        } else {
          found = false;
          break;
        }
      }
      const lastKey = parts.at(-1)!;
      if (found && lastKey in current) {
        current[lastKey] = '***';
      }
    }
    return masked;
  }

  /**
   * Merge incoming config with existing, preserving password fields when masked or empty.
   *
   * @param existing - The current config values
   * @param incoming - The new config values to merge
   * @param manifest - The adapter manifest with field definitions
   * @returns Merged config with password fields preserved when appropriate
   */
  private mergeWithPasswordPreservation(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
    manifest?: AdapterManifest,
  ): Record<string, unknown> {
    const result = { ...existing, ...incoming };
    if (!manifest) return result;

    for (const field of manifest.configFields) {
      if (field.type !== 'password') continue;
      const parts = field.key.split('.');
      const incomingValue = this.getNestedValue(incoming, parts);
      if (incomingValue === '' || incomingValue === '***' || incomingValue === undefined) {
        const existingValue = this.getNestedValue(existing, parts);
        if (existingValue !== undefined) {
          this.setNestedValue(result, parts, existingValue);
        }
      }
    }
    return result;
  }

  /** Traverse a nested object using dot-notation key parts. */
  private getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
    let current: unknown = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /** Set a value in a nested object using dot-notation key parts, creating intermediates. */
  private setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts.at(-1)!] = value;
  }

  /**
   * Start watching the config file for changes to trigger hot-reload.
   *
   * Uses chokidar with awaitWriteFinish to debounce rapid writes.
   * The same pattern is used by {@link SessionBroadcaster} for JSONL files.
   */
  private startConfigWatcher(): void {
    this.configWatcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: CONFIG_STABILITY_THRESHOLD_MS,
        pollInterval: CONFIG_POLL_INTERVAL_MS,
      },
    });

    this.configWatcher.on('change', () => {
      this.reload().catch((err) => {
        logger.warn('[AdapterManager] Hot-reload failed:', err);
      });
    });
  }
}
