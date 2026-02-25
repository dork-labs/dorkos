/**
 * Server-side adapter lifecycle manager for the Relay message bus.
 *
 * Loads adapter configurations from disk (`~/.dork/relay/adapters.json`),
 * instantiates the appropriate adapter implementation for each entry, and
 * watches the config file for hot-reload via chokidar.
 *
 * @module services/relay/adapter-manager
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AdapterRegistry, RelayAdapter, AdapterConfig, TelegramAdapterConfig, WebhookAdapterConfig } from '@dorkos/relay';
import { TelegramAdapter } from '@dorkos/relay';
import { WebhookAdapter } from '@dorkos/relay';
import { AdaptersConfigFileSchema } from '@dorkos/shared/relay-schemas';
import type { AdapterStatus } from '@dorkos/relay';
import { logger } from '../../lib/logger.js';

/** Chokidar stability threshold before triggering hot-reload (ms). */
const CONFIG_STABILITY_THRESHOLD_MS = 150;

/** Chokidar poll interval for write-finish detection (ms). */
const CONFIG_POLL_INTERVAL_MS = 50;

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

  /**
   * @param registry - The adapter registry managing adapter lifecycle
   * @param configPath - Absolute path to the adapters config JSON file
   */
  constructor(
    registry: AdapterRegistry,
    configPath: string,
  ) {
    this.registry = registry;
    this.configPath = configPath;
  }

  /**
   * Load config from disk, start all enabled adapters, and begin watching for changes.
   *
   * Should be called once during server startup.
   */
  async initialize(): Promise<void> {
    await this.loadConfig();
    await this.startEnabledAdapters();
    this.startConfigWatcher();
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

    const adapter = this.createAdapter(config);
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
      const status: AdapterStatus = adapter?.getStatus() ?? {
        state: 'disconnected',
        messageCount: { inbound: 0, outbound: 0 },
        errorCount: 0,
      };
      return { config, status };
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
    const status: AdapterStatus = adapter?.getStatus() ?? {
      state: 'disconnected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    };
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
   * Stop all adapters and the config file watcher.
   *
   * Should be called during server shutdown, before RelayCore shutdown.
   */
  async shutdown(): Promise<void> {
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
    await writeFile(
      this.configPath,
      JSON.stringify({ adapters: this.configs }, null, 2),
      'utf-8',
    );
  }

  /**
   * Start all enabled adapters that are not already running.
   *
   * Uses `Promise.allSettled` internally via the registry's `register` method.
   * Individual adapter startup failures are logged but do not prevent other
   * adapters from starting.
   */
  private async startEnabledAdapters(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) continue;
      if (this.registry.get(config.id)) continue; // Already running

      const adapter = this.createAdapter(config);
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
   * @param config - The adapter configuration entry
   * @returns The adapter instance, or null for unknown types
   */
  private createAdapter(config: AdapterConfig): RelayAdapter | null {
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
      default:
        logger.warn(`[AdapterManager] Unknown adapter type: ${(config as AdapterConfig).type}`);
        return null;
    }
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
