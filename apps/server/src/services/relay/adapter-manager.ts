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
import type { AdapterRegistry, RelayAdapter, AdapterConfig, AdapterContext } from '@dorkos/relay';
import {
  TELEGRAM_MANIFEST,
  WEBHOOK_MANIFEST,
  SLACK_MANIFEST,
  CLAUDE_CODE_MANIFEST,
  extractSessionIdFromSubject,
} from '@dorkos/relay';
import type { AgentRuntimeLike, TraceStoreLike, TasksStoreLike } from '@dorkos/relay';
import type { AdapterManifest, CatalogEntry } from '@dorkos/shared/relay-schemas';
import type { AdapterStatus } from '@dorkos/relay';
import { runtimeRegistry } from '../core/runtime-registry.js';
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

/**
 * Error thrown when no adapter is registered for a session's runtime type.
 *
 * Carries both the missing runtime type and the offending session id so
 * callers can log or surface a diagnostic. This is thrown instead of
 * silently falling back to the default runtime — masking such mismatches
 * would hide routing bugs (e.g., a `codex` session on a server that never
 * registered the Codex runtime).
 */
export class AdapterNotRegisteredError extends Error {
  readonly runtimeType: string;
  readonly sessionId: string;
  constructor(runtimeType: string, sessionId: string) {
    super(
      `No agent runtime registered for runtime type '${runtimeType}' (session '${sessionId}'). ` +
        `Register the runtime with AdapterManager via the 'agentRuntimes' map.`
    );
    this.name = 'AdapterNotRegisteredError';
    this.runtimeType = runtimeType;
    this.sessionId = sessionId;
  }
}

/** Minimal MeshCore interface needed by AdapterManager for CWD resolution. */
export interface AdapterMeshCoreLike {
  getProjectPath(agentId: string): string | undefined;
}

/** Interface for recording adapter lifecycle events. */
export interface AdapterEventRecorder {
  insertAdapterEvent(adapterId: string, eventType: string, message: string): void;
}

/** Minimal ActivityService interface for fire-and-forget event emission. */
export interface ActivityEmitter {
  emit(event: {
    actorType: 'user' | 'agent' | 'system' | 'tasks';
    actorLabel: string;
    category: 'relay';
    eventType: string;
    resourceType?: string | null;
    resourceId?: string | null;
    resourceLabel?: string | null;
    summary: string;
    linkPath?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void>;
}

/** Dependencies for constructing runtime adapters. */
export interface AdapterManagerDeps {
  /**
   * Map from runtime type (e.g., `'claude-code'`, `'test-mode'`) to a runtime
   * instance satisfying the minimal `AgentRuntimeLike` contract.
   *
   * The manager looks up the appropriate runtime for a given session via
   * `runtimeRegistry.getSessionRuntimeType(sessionId)` and throws
   * `AdapterNotRegisteredError` when no runtime is registered for a
   * session's declared type (never silently falls back to a default).
   *
   * For backward compatibility, callers may pass a single `agentManager`
   * instead — it will be normalized into a single-entry map keyed by the
   * default runtime type (`'claude-code'`).
   */
  agentRuntimes?: Map<string, AgentRuntimeLike>;
  /**
   * @deprecated Provide `agentRuntimes` (a map) instead. When supplied, this
   * single runtime is registered as the default (`'claude-code'`) entry of
   * the internal map so existing callers continue to work while they migrate.
   */
  agentManager?: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  taskStore?: TasksStoreLike;
  /** Optional RelayCore for binding subsystem initialization */
  relayCore?: RelayCoreLike;
  /** Optional MeshCore for enriching AdapterContext with agent CWD resolution */
  meshCore?: AdapterMeshCoreLike;
  /** Optional recorder for adapter lifecycle events */
  eventRecorder?: AdapterEventRecorder;
  /** Optional activity service for feed instrumentation */
  activityService?: ActivityEmitter;
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
  /** Normalized runtime-type → agent-runtime map (always populated post-construction). */
  private readonly agentRuntimes: Map<string, AgentRuntimeLike>;

  constructor(registry: AdapterRegistry, configPath: string, deps: AdapterManagerDeps) {
    this.registry = registry;
    this.configPath = configPath;
    this.deps = deps;

    // Normalize agentRuntimes input:
    //   1. If an explicit map is supplied, use it.
    //   2. Else, if a legacy single `agentManager` is supplied, wrap it as
    //      the default `'claude-code'` entry for backward compatibility.
    //   3. Else, start with an empty map — register(...) can populate it later.
    this.agentRuntimes = new Map(deps.agentRuntimes ?? []);
    if (!deps.agentRuntimes && deps.agentManager) {
      this.agentRuntimes.set('claude-code', deps.agentManager);
    }
  }

  /**
   * Register an agent runtime for a given runtime type.
   *
   * Registrations after construction replace any prior entry for the same
   * type. Useful in tests and for composition roots that lazily wire
   * runtimes after the manager is built.
   */
  registerAgentRuntime(runtimeType: string, runtime: AgentRuntimeLike): void {
    this.agentRuntimes.set(runtimeType, runtime);
  }

  /**
   * Resolve the agent runtime that owns a session.
   *
   * Delegates the runtime-type lookup to `runtimeRegistry.getSessionRuntimeType`
   * (which treats missing rows as legacy `'claude-code'` sessions and
   * back-fills on first access), then picks the matching entry from
   * this manager's runtime map. Throws {@link AdapterNotRegisteredError}
   * if the stored runtime type is not registered — never silently falls
   * back to another runtime.
   *
   * @param sessionId - Session identifier to resolve.
   */
  async resolveAgentRuntime(sessionId: string): Promise<AgentRuntimeLike> {
    const runtimeType = await runtimeRegistry.getSessionRuntimeType(sessionId);
    const runtime = this.agentRuntimes.get(runtimeType);
    if (!runtime) throw new AdapterNotRegisteredError(runtimeType, sessionId);
    return runtime;
  }

  /** Return the currently registered runtime-type keys (diagnostic). */
  listRegisteredRuntimeTypes(): string[] {
    return Array.from(this.agentRuntimes.keys());
  }

  /** Load config, start enabled adapters, begin watching for changes. */
  async initialize(): Promise<void> {
    this.populateBuiltinManifests();
    await this.enrichManifestsWithDocs();
    await ensureDefaultAdapterConfig(this.configPath);
    this.configs = await loadAdapterConfig(this.configPath);

    // Correct builtin flag on user-created adapters.
    // Only the built-in claude-code adapter should have builtin: true.
    let needsSave = false;
    for (const config of this.configs) {
      if (config.builtin && config.type !== 'claude-code') {
        config.builtin = false;
        needsSave = true;
      }
    }
    if (needsSave) {
      await saveAdapterConfig(this.configPath, this.configs);
      logger.info('[AdapterManager] Corrected builtin flag on user-created adapter(s)');
    }

    await this.initBindingSubsystem();
    await this.startEnabledAdapters();
    this.configWatcher = watchAdapterConfig(this.configPath, () => {
      this.reload().catch((err) => {
        logger.warn('[AdapterManager] Hot-reload failed:', err);
      });
    });
  }

  /** Initialize the binding subsystem. Non-fatal on failure — logs and continues. */
  private async initBindingSubsystem(): Promise<void> {
    if (!this.deps.relayCore || !this.deps.meshCore) {
      logger.info(
        '[AdapterManager] relayCore or meshCore not provided, skipping binding subsystem'
      );
      return;
    }

    this.bindingSubsystem = await BindingSubsystem.init({
      relayCore: this.deps.relayCore,
      meshCore: this.deps.meshCore,
      agentRuntimes: this.agentRuntimes,
      configPath: this.configPath,
      eventRecorder: this.deps.eventRecorder,
    });
  }

  /** Reload config from disk and reconcile adapter state. */
  async reload(): Promise<void> {
    const oldConfigIds = new Set(this.configs.map((c) => c.id));
    // Capture names before reloading config (entries may be removed)
    const oldNames = new Map([...oldConfigIds].map((id) => [id, this.resolveAdapterName(id)]));
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
            'Disconnected from relay'
          );
          await this.emitAdapterLifecycle(id, 'disconnected', oldNames.get(id));
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
        await this.emitAdapterLifecycle(id, 'connected');
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
    this.deps.eventRecorder?.insertAdapterEvent(
      id,
      'adapter.disconnected',
      'Disconnected from relay'
    );
    await this.emitAdapterLifecycle(id, 'disconnected');
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
  private buildAdapterView(config: AdapterConfig): {
    config: AdapterConfig;
    status: AdapterStatus;
  } {
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
      config: maskSensitiveFields(config.config as Record<string, unknown>, manifest),
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

  /** Get the MeshCore dependency, or undefined if not provided. */
  getMeshCore(): AdapterMeshCoreLike | undefined {
    return this.deps.meshCore;
  }

  /**
   * Enrich AdapterContext with Mesh agent info if meshCore is available.
   *
   * Uses the shared {@link extractSessionIdFromSubject} helper so both the
   * legacy shape (`relay.agent.<sessionId>`) and the runtime-scoped shape
   * (`relay.agent.<runtimeType>.<sessionId>`) resolve to the same mesh agent
   * identifier. The identifier in this slot is historically overloaded — it
   * may be a sessionId (from the binding router) or a mesh agentId (from
   * direct relay sends); either way we hand it to MeshCore which returns
   * `undefined` for misses, so no further disambiguation is needed here.
   */
  buildContext(subject: string): AdapterContext | undefined {
    if (!this.deps.meshCore) return undefined;

    const agentId = extractSessionIdFromSubject(subject);
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
    config: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string; botUsername?: string }> {
    const manifest = this.manifests.get(type);
    if (!manifest) {
      return { ok: false, error: `Unknown adapter type: ${type}` };
    }

    const tempConfig = {
      id: `__test_${type}_${Date.now()}`,
      type,
      enabled: true,
      builtin: false,
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
    label?: string
  ): Promise<void> {
    logger.info('[AdapterManager] adding adapter', { type, id, enabled });

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
          'MULTI_INSTANCE_DENIED'
        );
      }
    }

    const adapterConfig = {
      id,
      type,
      enabled,
      builtin: false, // User-created instances are never builtin
      ...(label ? { label } : {}),
      config,
    } as AdapterConfig;
    this.configs.push(adapterConfig);
    await saveAdapterConfig(this.configPath, this.configs);
    logger.debug('[AdapterManager] config saved', { id });

    if (enabled) {
      const adapter = await this.buildAdapter(adapterConfig);
      if (adapter) {
        logger.info('[AdapterManager] starting adapter', { id });
        try {
          await this.registry.register(adapter);
          this.deps.eventRecorder?.insertAdapterEvent(
            id,
            'adapter.connected',
            'Connected to relay'
          );
          await this.emitAdapterLifecycle(id, 'connected');
          logger.info('[AdapterManager] adapter registered', { id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.error', message);
          logger.error('[AdapterManager] adapter start failed', { id, error: message });
          throw err;
        }
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
        'REMOVE_BUILTIN_DENIED'
      );
    }

    // Capture name before config removal for the disconnected event
    const adapterName = this.resolveAdapterName(id);

    try {
      await this.registry.unregister(id);
    } catch {
      /* not running -- ignore */
    }

    await this.emitAdapterLifecycle(id, 'disconnected', adapterName);
    this.configs.splice(index, 1);
    await saveAdapterConfig(this.configPath, this.configs);

    // Auto-delete bindings that belonged to the removed adapter
    const bindingStore = this.bindingSubsystem?.getBindingStore();
    if (bindingStore) {
      const orphanBindings = bindingStore
        .getAll()
        .filter((b: { adapterId: string; id: string }) => b.adapterId === id);
      for (const binding of orphanBindings) {
        await bindingStore.delete(binding.id);
      }
      if (orphanBindings.length > 0) {
        logger.info(
          '[AdapterManager] Cleaned %d orphan binding(s) for removed adapter %s',
          orphanBindings.length,
          id
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
      manifest
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
            'Connected to relay'
          );
          await this.emitAdapterLifecycle(config.id, 'connected');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.eventRecorder?.insertAdapterEvent(config.id, 'adapter.error', message);
          logger.warn(`[AdapterManager] Failed to start adapter '${config.id}':`, err);
        }
      }
    }
  }

  /**
   * Emit an adapter lifecycle activity event (connected or disconnected).
   *
   * Fire-and-forget — never throws. Uses the optional `nameOverride` when
   * the adapter config may already be removed (e.g. during reload).
   */
  private async emitAdapterLifecycle(
    id: string,
    state: 'connected' | 'disconnected',
    nameOverride?: string
  ): Promise<void> {
    const activity = this.deps.activityService;
    if (!activity) return;
    const name = nameOverride ?? this.resolveAdapterName(id);
    await activity.emit({
      actorType: 'system',
      actorLabel: 'System',
      category: 'relay',
      eventType: `relay.adapter_${state}`,
      resourceType: 'adapter',
      resourceId: id,
      resourceLabel: name,
      summary: `${name} adapter ${state}`,
      linkPath: '/',
    });
  }

  /** Delegate adapter instantiation to the factory module. */
  private async buildAdapter(config: AdapterConfig): Promise<RelayAdapter | null> {
    return createAdapter(
      config,
      {
        agentRuntimes: this.agentRuntimes,
        traceStore: this.deps.traceStore,
        taskStore: this.deps.taskStore,
        agentSessionStore: this.bindingSubsystem?.getAgentSessionStore(),
      },
      this.configPath,
      (type, manifest) => this.registerPluginManifest(type, manifest)
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

  /** Resolve a human-readable display name for an adapter by ID. */
  resolveAdapterName(id: string): string {
    const config = this.configs.find((c) => c.id === id);
    if (!config) return id;
    const manifest = this.manifests.get(config.type);
    return config.label ?? manifest?.displayName ?? config.type;
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
        const setupGuide = await readFile(join(docsPath, 'setup.md'), 'utf-8');
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
