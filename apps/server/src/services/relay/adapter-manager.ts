/**
 * Server-side adapter lifecycle manager for the Relay message bus.
 *
 * Config I/O and validation are in adapter-config.ts.
 * Adapter instantiation and connection testing are in adapter-factory.ts.
 * Binding subsystem (BindingStore, AgentSessionStore, BindingRouter) is in binding-subsystem.ts.
 * Error class is in adapter-error.ts.
 *
 * @module services/relay/adapter-manager
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import type {
  AdapterRegistry,
  RelayAdapter,
  AdapterConfig,
  AdapterContext,
} from '@dorkos/relay';
import {
  TELEGRAM_MANIFEST,
  WEBHOOK_MANIFEST,
  SLACK_MANIFEST,
  CLAUDE_CODE_MANIFEST,
} from '@dorkos/relay';
import type {
  ClaudeCodeAgentRuntimeLike,
  TraceStoreLike,
  PulseStoreLike,
} from '@dorkos/relay';
import type { AdapterManifest, CatalogEntry } from '@dorkos/shared/relay-schemas';
import type { AdapterStatus } from '@dorkos/relay';
import { logger } from '../../lib/logger.js';
import { AdapterError } from './adapter-error.js';
import {
  loadAdapterConfig,
  saveAdapterConfig,
  ensureDefaultAdapterConfig,
  watchAdapterConfig,
  maskSensitiveFields,
  mergeWithPasswordPreservation,
} from './adapter-config.js';
import { createAdapter, defaultAdapterStatus, testAdapterConnection } from './adapter-factory.js';
import { BindingSubsystem } from './binding-subsystem.js';
import type { RelayCoreLike } from './binding-router.js';

// Re-export for consumers that import AdapterError from this module
export { AdapterError } from './adapter-error.js';

/** Minimal MeshCore interface needed by AdapterManager for CWD resolution. */
export interface AdapterMeshCoreLike {
  getProjectPath(agentId: string): string | undefined;
}

/** Interface for recording adapter lifecycle events. */
export interface AdapterEventRecorder {
  insertAdapterEvent(adapterId: string, eventType: string, message: string): void;
}

/** Dependencies for constructing runtime adapters. */
export interface AdapterManagerDeps {
  agentManager: ClaudeCodeAgentRuntimeLike;
  traceStore: TraceStoreLike;
  pulseStore?: PulseStoreLike;
  /** Optional RelayCore for binding subsystem initialization */
  relayCore?: RelayCoreLike;
  /** Optional MeshCore for enriching AdapterContext with agent CWD resolution */
  meshCore?: AdapterMeshCoreLike;
  /** Optional recorder for adapter lifecycle events */
  eventRecorder?: AdapterEventRecorder;
}

/** Server-side adapter lifecycle manager. */
export class AdapterManager {
  private readonly registry: AdapterRegistry;
  private configWatcher: FSWatcher | null = null;
  private readonly configPath: string;
  private configs: AdapterConfig[] = [];
  private readonly deps: AdapterManagerDeps;
  private manifests = new Map<string, AdapterManifest>();
  private bindingSubsystem?: BindingSubsystem;

  constructor(
    registry: AdapterRegistry,
    configPath: string,
    deps: AdapterManagerDeps,
  ) {
    this.registry = registry;
    this.configPath = configPath;
    this.deps = deps;
  }

  /** Load config, start enabled adapters, begin watching for changes. */
  async initialize(): Promise<void> {
    this.populateBuiltinManifests();
    await this.enrichManifestsWithDocs();
    await ensureDefaultAdapterConfig(this.configPath);
    this.configs = await loadAdapterConfig(this.configPath);
    await this.startEnabledAdapters();
    this.configWatcher = watchAdapterConfig(this.configPath, () => {
      this.reload().catch((err) => {
        logger.warn('[AdapterManager] Hot-reload failed:', err);
      });
    });
    await this.initBindingSubsystem();
  }

  /** Initialize the binding subsystem. Non-fatal on failure — logs and continues. */
  private async initBindingSubsystem(): Promise<void> {
    if (!this.deps.relayCore || !this.deps.meshCore) {
      logger.info('[AdapterManager] relayCore or meshCore not provided, skipping binding subsystem');
      return;
    }

    this.bindingSubsystem = await BindingSubsystem.init({
      relayCore: this.deps.relayCore,
      meshCore: this.deps.meshCore,
      agentManager: this.deps.agentManager,
      configPath: this.configPath,
      resolveAdapterInstanceId: (platformType: string) => {
        const match = this.configs.find((c) => c.type === platformType && c.enabled);
        return match?.id;
      },
    });
  }

  /** Reload config from disk and reconcile adapter state. */
  async reload(): Promise<void> {
    const oldConfigIds = new Set(this.configs.map((c) => c.id));
    this.configs = await loadAdapterConfig(this.configPath);

    // Stop adapters that are no longer in config or are now disabled
    for (const id of oldConfigIds) {
      const newConfig = this.configs.find((c) => c.id === id);
      if (!newConfig || !newConfig.enabled) {
        try {
          await this.registry.unregister(id);
          this.deps.eventRecorder?.insertAdapterEvent(
            id,
            'adapter.disconnected',
            'Disconnected from relay',
          );
        } catch (err) {
          logger.warn(`[AdapterManager] Failed to unregister adapter '${id}':`, err);
        }
      }
    }

    // Start/update enabled adapters
    await this.startEnabledAdapters();
  }

  /** Enable a specific adapter by ID and persist the change to disk. */
  async enable(id: string): Promise<void> {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);

    config.enabled = true;
    await saveAdapterConfig(this.configPath, this.configs);

    const adapter = await this.buildAdapter(config);
    if (adapter) {
      try {
        await this.registry.register(adapter);
        this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.connected', 'Connected to relay');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.error', message);
        throw err;
      }
    }
  }

  /** Disable a specific adapter by ID and persist the change to disk. */
  async disable(id: string): Promise<void> {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);

    config.enabled = false;
    await saveAdapterConfig(this.configPath, this.configs);
    await this.registry.unregister(id);
    this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.disconnected', 'Disconnected from relay');
  }

  /**
   * List all adapter configs paired with their current runtime status.
   */
  listAdapters(): Array<{ config: AdapterConfig; status: AdapterStatus }> {
    return this.configs.map((config) => this.buildAdapterView(config));
  }

  /** Get a single adapter's config and status. Sensitive fields are masked. */
  getAdapter(id: string): { config: AdapterConfig; status: AdapterStatus } | undefined {
    const config = this.configs.find((c) => c.id === id);
    if (!config) return undefined;
    return this.buildAdapterView(config);
  }

  /** Build a masked config + status snapshot for an adapter. */
  private buildAdapterView(config: AdapterConfig): { config: AdapterConfig; status: AdapterStatus } {
    const adapter = this.registry.get(config.id);
    const manifest = this.manifests.get(config.type);
    const status = {
      id: config.id,
      type: config.type,
      displayName: manifest?.displayName ?? config.type,
      ...(adapter?.getStatus() ?? defaultAdapterStatus()),
    };
    const maskedConfig = {
      ...config,
      config: maskSensitiveFields(
        config.config as Record<string, unknown>,
        manifest,
      ),
    };
    return { config: maskedConfig, status };
  }

  /** Get the underlying AdapterRegistry. */
  getRegistry(): AdapterRegistry {
    return this.registry;
  }

  /** Get the BindingStore, or undefined if binding subsystem was not initialized. */
  getBindingStore(): import('./binding-store.js').BindingStore | undefined {
    return this.bindingSubsystem?.getBindingStore();
  }

  /** Get the AgentSessionStore, or undefined if binding subsystem was not initialized. */
  getAgentSessionStore(): import('./agent-session-store.js').AgentSessionStore | undefined {
    return this.bindingSubsystem?.getAgentSessionStore();
  }

  /** Get the BindingRouter, or undefined if binding subsystem was not initialized. */
  getBindingRouter(): import('./binding-router.js').BindingRouter | undefined {
    return this.bindingSubsystem?.getBindingRouter();
  }

  /** Enrich AdapterContext with Mesh agent info if meshCore is available. */
  buildContext(subject: string): AdapterContext | undefined {
    if (!this.deps.meshCore) return undefined;
    if (!subject.startsWith('relay.agent.')) return undefined;

    const agentId = subject.split('.')[2]; // relay.agent.{agentId}
    if (!agentId) return undefined;

    const projectPath = this.deps.meshCore.getProjectPath(agentId);
    if (!projectPath) return undefined;

    return {
      agent: {
        directory: projectPath,
        runtime: 'claude-code',
      },
    };
  }

  /** Test connectivity for an adapter type and config without registering it. */
  async testConnection(
    type: string,
    config: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
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

    const adapter = await this.buildAdapter(tempConfig);
    if (!adapter) {
      return { ok: false, error: 'Failed to create adapter instance' };
    }

    return testAdapterConnection(adapter);
  }

  /** Add a new adapter instance, persist config, and start it if enabled. */
  async addAdapter(
    type: string,
    id: string,
    config: Record<string, unknown>,
    enabled = true,
    label?: string,
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
      ...(label ? { label } : {}),
      config,
    } as AdapterConfig;
    this.configs.push(adapterConfig);
    await saveAdapterConfig(this.configPath, this.configs);

    if (enabled) {
      const adapter = await this.buildAdapter(adapterConfig);
      if (adapter) {
        await this.registry.register(adapter);
      }
    }
  }

  /**
   * Update the user-facing label for an adapter instance.
   *
   * @param id - Adapter instance ID
   * @param label - New label value, or empty string to clear the label
   */
  async updateAdapterLabel(id: string, label: string): Promise<void> {
    const existing = this.configs.find((c) => c.id === id);
    if (!existing) {
      throw new AdapterError(`Adapter '${id}' not found`, 'NOT_FOUND');
    }

    if (label) {
      existing.label = label;
    } else {
      delete existing.label;
    }
    await saveAdapterConfig(this.configPath, this.configs);
  }

  /** Remove an adapter instance, stop it if running, and persist the change. */
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
      /* not running -- ignore */
    }

    this.configs.splice(index, 1);
    await saveAdapterConfig(this.configPath, this.configs);

    // Auto-delete bindings that belonged to the removed adapter
    const bindingStore = this.bindingSubsystem?.getBindingStore();
    if (bindingStore) {
      const orphanBindings = bindingStore.getAll().filter((b: { adapterId: string; id: string }) => b.adapterId === id);
      for (const binding of orphanBindings) {
        await bindingStore.delete(binding.id);
      }
      if (orphanBindings.length > 0) {
        logger.info(
          '[AdapterManager] Cleaned %d orphan binding(s) for removed adapter %s',
          orphanBindings.length,
          id,
        );
      }
    }
  }

  /** Update an adapter's config with password field preservation. */
  async updateConfig(id: string, newConfig: Record<string, unknown>): Promise<void> {
    const existing = this.configs.find((c) => c.id === id);
    if (!existing) {
      throw new AdapterError(`Adapter '${id}' not found`, 'NOT_FOUND');
    }

    const manifest = this.manifests.get(existing.type);
    const mergedConfig = mergeWithPasswordPreservation(
      existing.config as Record<string, unknown>,
      newConfig,
      manifest,
    );

    existing.config = mergedConfig;

    // Promote label from config to top-level if present (client embeds it in config)
    if (typeof mergedConfig.label === 'string' && mergedConfig.label) {
      existing.label = mergedConfig.label;
    }
    await saveAdapterConfig(this.configPath, this.configs);

    // Restart adapter if running
    if (existing.enabled && this.registry.get(id)) {
      try {
        await this.registry.unregister(id);
      } catch {
        /* ignore */
      }
      const adapter = await this.buildAdapter(existing);
      if (adapter) await this.registry.register(adapter);
    }
  }

  /** Stop all adapters and the config file watcher. */
  async shutdown(): Promise<void> {
    if (this.bindingSubsystem) {
      await this.bindingSubsystem.shutdown();
      this.bindingSubsystem = undefined;
    }
    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = null;
    }
    await this.registry.shutdown();
  }

  /** Start all enabled adapters that are not already running. */
  private async startEnabledAdapters(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) continue;
      if (this.registry.get(config.id)) continue; // Already running

      const adapter = await this.buildAdapter(config);
      if (adapter) {
        try {
          await this.registry.register(adapter);
          this.deps.eventRecorder?.insertAdapterEvent(
            config.id,
            'adapter.connected',
            'Connected to relay',
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.eventRecorder?.insertAdapterEvent(config.id, 'adapter.error', message);
          logger.warn(`[AdapterManager] Failed to start adapter '${config.id}':`, err);
        }
      }
    }
  }

  /** Delegate adapter instantiation to the factory module. */
  private async buildAdapter(config: AdapterConfig): Promise<RelayAdapter | null> {
    return createAdapter(
      config,
      { ...this.deps, agentSessionStore: this.bindingSubsystem?.getAgentSessionStore() },
      this.configPath,
      (type, manifest) => this.registerPluginManifest(type, manifest),
    );
  }

  /** Return the full adapter catalog with manifests and configured instances. */
  getCatalog(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const [type, manifest] of this.manifests) {
      const instances = this.configs
        .filter((c) => c.type === type)
        .map((c) => ({
          id: c.id,
          enabled: c.enabled,
          ...(c.label ? { label: c.label } : {}),
          status: {
            id: c.id,
            type: c.type,
            displayName: manifest.displayName,
            ...(this.registry.get(c.id)?.getStatus() ?? defaultAdapterStatus()),
          },
          config: maskSensitiveFields((c.config ?? {}) as Record<string, unknown>, manifest),
        }));
      entries.push({ manifest, instances });
    }
    return entries;
  }

  /** Get a manifest by adapter type. */
  getManifest(type: string): AdapterManifest | undefined {
    return this.manifests.get(type);
  }

  /** Register a plugin-discovered manifest for a given adapter type. */
  registerPluginManifest(type: string, manifest: AdapterManifest): void {
    this.manifests.set(type, manifest);
  }

  /** Populate the manifests map with built-in adapter manifests. */
  private populateBuiltinManifests(): void {
    this.manifests.set('telegram', TELEGRAM_MANIFEST);
    this.manifests.set('webhook', WEBHOOK_MANIFEST);
    this.manifests.set('slack', SLACK_MANIFEST);
    this.manifests.set('claude-code', CLAUDE_CODE_MANIFEST);
  }

  /**
   * Enrich built-in adapter manifests with documentation from disk.
   *
   * Reads `docs/setup.md` from each adapter's dist directory and sets
   * the content as `setupGuide` on the manifest. Adapters without docs
   * are silently skipped. Plugin adapters that already have inline
   * setupGuide are also skipped.
   */
  private async enrichManifestsWithDocs(): Promise<void> {
    for (const [type, manifest] of this.manifests) {
      if (manifest.setupGuide) continue; // Already has inline guide (plugin adapters)
      try {
        const docsPath = this.resolveAdapterDocsPath(type);
        const setupGuide = await readFile(
          join(docsPath, 'setup.md'),
          'utf-8',
        );
        this.manifests.set(type, { ...manifest, setupGuide });
      } catch {
        // No docs/setup.md — that's fine, setupGuide stays undefined
      }
    }
  }

  /**
   * Resolve the docs directory path for a built-in adapter type.
   *
   * Uses createRequire to find the relay package's dist/index.js,
   * then walks up to the package root to construct the path to
   * `dist/adapters/<type>/docs/`.
   */
  private resolveAdapterDocsPath(adapterType: string): string {
    const require = createRequire(import.meta.url);
    const relayEntry = require.resolve('@dorkos/relay');
    // relayEntry points to dist/index.js; go up to package root
    const distDir = dirname(relayEntry);
    return join(distDir, 'adapters', adapterType, 'docs');
  }
}
