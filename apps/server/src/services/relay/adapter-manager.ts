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
  parseAgentSubject,
  toIdList,
} from '@dorkos/relay';
import type { AgentRuntimeLike, TraceStoreLike, TasksStoreLike } from '@dorkos/relay';
import type { AdapterManifest, CatalogEntry } from '@dorkos/shared/relay-schemas';
import type { AdapterStatus } from '@dorkos/relay';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { askEntitlement } from '../session/asks/ask-entitlement.js';
import { logger } from '../../lib/logger.js';
import { AdapterError } from './adapter-error.js';
import {
  loadAdapterConfig,
  saveAdapterConfig,
  unparsedEntryId,
  ensureDefaultAdapterConfig,
  watchAdapterConfig,
  maskSensitiveFields,
  mergeWithPasswordPreservation,
  parseAdapterConfigForPersist,
} from './adapter-config.js';
import { createAdapter, defaultAdapterStatus, testAdapterConnection } from './adapter-factory.js';
import {
  broadcastAdaptersChanged,
  broadcastBindingsChanged,
  broadcastRelayFlow,
  broadcastUnclaimedChat,
  broadcastUnclaimedChatBurst,
} from './relay-sse-events.js';
import { BindingSubsystem, type BindingSubsystemDeps } from './binding-subsystem.js';
import { reportsVisibility, type BridgeVisibility } from './chat-bridge/index.js';
import type { UnclaimedChatStore } from './unclaimed-chat-store.js';
import type { RelayCoreLike } from './binding-router.js';
import {
  materializeAdapterSecrets,
  persistAdapterConfigs,
  resolveAdapterSecrets,
  deleteAdapterSecrets,
  type MaterializeSecretsContext,
} from './adapter-secrets.js';
import {
  credentialProvider as defaultCredentialProvider,
  credentialStore as defaultCredentialStore,
  type CredentialProvider,
  type CredentialStore,
} from '../core/credential-provider.js';

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
   * instead — it will be normalized into a single-entry map keyed by that
   * runtime's own `type`.
   */
  agentRuntimes?: Map<string, AgentRuntimeLike>;
  /**
   * @deprecated Provide `agentRuntimes` (a map) instead. When supplied, this
   * single runtime is registered under its own `type` (falling back to
   * `'claude-code'` for doubles that declare none) so existing callers
   * continue to work while they migrate.
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
  /**
   * Encrypted store that backs `file:` credential references for adapter
   * secrets (DOR-280). Defaults to the process-wide {@link credentialStore}
   * singleton; injectable for tests.
   */
  credentialStore?: CredentialStore;
  /**
   * Read port that resolves a credential reference to its secret at adapter
   * construction (DOR-280). Defaults to the process-wide
   * {@link credentialProvider} singleton; injectable for tests.
   */
  credentialProvider?: CredentialProvider;
  /**
   * The durable claim feed for unbound inbound chats (connection-scoping
   * spec `specs/connection-scoping/` §Part 3). Optional so callers that don't
   * exercise the unbound-inbound path (most tests) can omit it.
   */
  unclaimedChats?: UnclaimedChatStore;
  /**
   * The rooms service, its bridge store, and the operator-author resolver —
   * threaded straight to {@link BindingSubsystem} for the inbound chat bridge
   * (chats-as-channels §5). Optional so a manager built without a rooms
   * subsystem still runs; a bridged binding then simply cannot be routed.
   */
  roomService?: BindingSubsystemDeps['roomService'];
  /** The bridge identity store the rooms service writes through (chats-as-channels §3.1). */
  roomBridges?: BindingSubsystemDeps['roomBridges'];
  /** The per-runtime transcript probe for session adoption at bridge time (§7.3). */
  transcriptProbe?: BindingSubsystemDeps['transcriptProbe'];
  /** The install owner's author id, read per call (chats-as-channels §3.5, §10.9). */
  operatorAuthorId?: BindingSubsystemDeps['operatorAuthorId'];
  /** The real operator-name prefix for a bridged group post, read per call (§6.7, DOR-899). */
  operatorDisplayName?: BindingSubsystemDeps['operatorDisplayName'];
  /** The room store, for outbound delivery's entry reads (chats-as-channels §6). */
  roomStore?: BindingSubsystemDeps['roomStore'];
  /** The author registry, for the delivering-author check and name prefix (§6.6, §6.7). */
  roomAuthors?: BindingSubsystemDeps['roomAuthors'];
  /** Which room a session answers for, for the bridged Ask card (`ask-entitlement` §5.2). */
  roomSessionBindings?: BindingSubsystemDeps['roomSessionBindings'];
  /** A room's membership rows, for that card's audience check (`ask-entitlement` §5.1). */
  roomMembers?: BindingSubsystemDeps['roomMembers'];
  /** Build a chat's outbound subject from its bridge row (§6.4). */
  resolveBridgeSubject?: BindingSubsystemDeps['resolveBridgeSubject'];
  /** Register the outbound bridge's inline-delivery hook on the room service (§6.1). */
  registerEntryCommitListener?: BindingSubsystemDeps['registerEntryCommitListener'];
  /** Emit an ephemeral relay signal, for the bridge's presence forwarder (§6.8). */
  relaySignal?: BindingSubsystemDeps['relaySignal'];
  /** Register the bridge's presence forwarder on the room service (§6.8). */
  registerSignalListener?: BindingSubsystemDeps['registerSignalListener'];
}

/**
 * An adapter that can remove the bot from a chat via the platform's own leave
 * call (DOR-883) — Telegram only today.
 */
interface LeaveCapableAdapter {
  leaveChat(chatId: string): Promise<void>;
}

/**
 * Whether a live adapter instance exposes `leaveChat` at all. A structural
 * check rather than an `instanceof TelegramAdapter`, the same reasoning
 * {@link reportsVisibility} gives for `getMe` — so a future platform that
 * gains the same accessor works here without an import of its class.
 *
 * @param adapter - The live adapter instance from `AdapterRegistry.get`.
 */
function canLeaveChat(adapter: RelayAdapter): adapter is RelayAdapter & LeaveCapableAdapter {
  return typeof (adapter as { leaveChat?: unknown }).leaveChat === 'function';
}

/** Server-side adapter lifecycle manager. */
export class AdapterManager {
  private readonly registry: AdapterRegistry;
  private configWatcher: FSWatcher | null = null;
  private readonly configPath: string;
  private configs: AdapterConfig[] = [];
  /**
   * Entries the last load of `adapters.json` could not read, held verbatim and
   * written back on every save so editing one integration cannot delete
   * another (see {@link LoadedAdapterConfigs}).
   */
  private unparsedConfigEntries: unknown[] = [];
  private readonly deps: AdapterManagerDeps;
  private manifests = new Map<string, AdapterManifest>();
  private bindingSubsystem?: BindingSubsystem;
  /** Serialized adapter-start passes — see {@link queueStartEnabledAdapters}. */
  private startChain: Promise<void> = Promise.resolve();
  /** Set by {@link shutdown}; stops any in-flight start pass from registering more adapters. */
  private stopped = false;
  /** Normalized runtime-type → agent-runtime map (always populated post-construction). */
  private readonly agentRuntimes: Map<string, AgentRuntimeLike>;

  constructor(registry: AdapterRegistry, configPath: string, deps: AdapterManagerDeps) {
    this.registry = registry;
    this.configPath = configPath;
    this.deps = deps;

    // Normalize agentRuntimes input:
    //   1. If an explicit map is supplied, use it.
    //   2. Else, if a legacy single `agentManager` is supplied, wrap it under
    //      its OWN `type` — not a hardcoded `'claude-code'`. The hardcode was a
    //      silent killer: a TestModeRuntime landed under `'claude-code'` while
    //      every lookup asked for `'test-mode'`, so binding routing failed to
    //      initialize and the relay went quiet with only a warn line. Bare test
    //      doubles with no `type` keep the old key, which is what they mean.
    //   3. Else, start with an empty map — register(...) can populate it later.
    this.agentRuntimes = new Map(deps.agentRuntimes ?? []);
    if (!deps.agentRuntimes && deps.agentManager) {
      this.agentRuntimes.set(deps.agentManager.type ?? 'claude-code', deps.agentManager);
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

  /** Credential store + manifests used to materialize adapter secrets (DOR-280). */
  private get secretsCtx(): MaterializeSecretsContext {
    return {
      store: this.deps.credentialStore ?? defaultCredentialStore,
      manifests: this.manifests,
    };
  }

  /** Read port that resolves adapter-secret references at construction (DOR-280). */
  private get credentialProvider(): CredentialProvider {
    return this.deps.credentialProvider ?? defaultCredentialProvider;
  }

  /**
   * Persist `this.configs`, materializing secrets into credential references
   * first — the single funnel to disk, so a cleartext bot token is never
   * written to `adapters.json` (DOR-280). Rewrites `this.configs` in place.
   */
  private persistConfigs(): Promise<void> {
    return persistAdapterConfigs(
      this.configPath,
      this.configs,
      this.secretsCtx,
      this.unparsedConfigEntries
    );
  }

  /** Load config, start enabled adapters, begin watching for changes. */
  async initialize(): Promise<void> {
    this.populateBuiltinManifests();
    await this.enrichManifestsWithDocs();
    await ensureDefaultAdapterConfig(this.configPath);
    ({ adapters: this.configs, unparsed: this.unparsedConfigEntries } = await loadAdapterConfig(
      this.configPath
    ));

    // Migrate any legacy cleartext bot tokens into the encrypted credential
    // store, rewriting adapters.json to hold references (DOR-280). An
    // already-bound bot keeps working: its token is moved, not invalidated.
    if (await materializeAdapterSecrets(this.configs, this.secretsCtx)) {
      await saveAdapterConfig(this.configPath, this.configs, this.unparsedConfigEntries);
    }

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
      await saveAdapterConfig(this.configPath, this.configs, this.unparsedConfigEntries);
      logger.info('[AdapterManager] Corrected builtin flag on user-created adapter(s)');
    }

    await this.initBindingSubsystem();
    // Adapter starts do network I/O (e.g. Telegram's getMe handshake) that can
    // hang for tens of seconds, and the desktop shell health-gates startup on
    // the server reaching `app.listen` within a fixed window. Starting adapters
    // in the background keeps a slow or unreachable adapter endpoint from
    // taking down the whole server boot; await adaptersStarted() to observe it.
    void this.queueStartEnabledAdapters();
    this.configWatcher = watchAdapterConfig(this.configPath, () => {
      this.reload().catch((err) => {
        logger.warn('[AdapterManager] Hot-reload failed:', err);
      });
    });
  }

  /**
   * Initialize the binding subsystem.
   *
   * Fatal on failure, deliberately: it runs before any adapter starts, so a
   * throw here means `initialize()` rejects and no chat integration comes up.
   * An integration that connects without binding routing looks healthy and
   * answers nobody (see {@link BindingSubsystem.init}).
   */
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
      onFlow: broadcastRelayFlow,
      unclaimedChats: this.deps.unclaimedChats,
      onUnclaimedChat: broadcastUnclaimedChat,
      onUnclaimedChatBurst: broadcastUnclaimedChatBurst,
      roomService: this.deps.roomService,
      roomBridges: this.deps.roomBridges,
      transcriptProbe: this.deps.transcriptProbe,
      operatorAuthorId: this.deps.operatorAuthorId,
      operatorDisplayName: this.deps.operatorDisplayName,
      roomStore: this.deps.roomStore,
      roomAuthors: this.deps.roomAuthors,
      roomSessionBindings: this.deps.roomSessionBindings,
      roomMembers: this.deps.roomMembers,
      // The one seam that has to come from here: the adapter configs live on
      // this manager, and the approver allowlist is a field on one of them.
      approverAllowlistFor: (adapterId) => this.approverAllowlistFor(adapterId),
      resolveBridgeSubject: this.deps.resolveBridgeSubject,
      registerEntryCommitListener: this.deps.registerEntryCommitListener,
      relaySignal: this.deps.relaySignal,
      registerSignalListener: this.deps.registerSignalListener,
      // The bridge-create half of §8's visibility refresh (task 1.13) — bound
      // here because only `AdapterManager` holds the adapter registry
      // `refreshBridgeVisibility` needs; the binding subsystem never sees it.
      refreshVisibility: (adapterId) => this.refreshBridgeVisibility(adapterId),
    });
  }

  /** The durable claim feed store, when wired (connection-scoping spec §Part 3). */
  getUnclaimedChats(): UnclaimedChatStore | undefined {
    return this.deps.unclaimedChats;
  }

  /**
   * Reload config from disk and reconcile adapter state.
   *
   * Runs as one atomic task on the serialized start queue so an in-flight
   * background start pass can never interleave with the unregister loop below
   * (which would otherwise leak a should-be-disabled adapter caught mid-register).
   */
  async reload(): Promise<void> {
    return this.enqueue(() => this.reloadInner());
  }

  /** Reconcile body for {@link reload}. Runs inside the serialized chain. */
  private async reloadInner(): Promise<void> {
    const oldConfigIds = new Set(this.configs.map((c) => c.id));
    // Capture names before reloading config (entries may be removed)
    const oldNames = new Map([...oldConfigIds].map((id) => [id, this.resolveAdapterName(id)]));
    ({ adapters: this.configs, unparsed: this.unparsedConfigEntries } = await loadAdapterConfig(
      this.configPath
    ));

    // Migrate any cleartext token a user hand-added to adapters.json into the
    // encrypted store, so every load path — not just initialize() and the API
    // persist funnel — leaves references at rest (DOR-280).
    if (await materializeAdapterSecrets(this.configs, this.secretsCtx)) {
      await saveAdapterConfig(this.configPath, this.configs, this.unparsedConfigEntries);
    }

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

    // Start/update enabled adapters. Called directly (not via the queue):
    // reloadInner already runs inside the serialized chain, so re-enqueuing
    // here would deadlock the chain waiting on itself.
    await this.startEnabledAdapters();
  }

  /**
   * Resolves once every adapter-start pass queued so far has settled.
   *
   * `initialize()` starts adapters in the background so boot never blocks on
   * adapter network I/O; callers that need started adapters (tests, health
   * introspection) await this instead.
   */
  adaptersStarted(): Promise<void> {
    return this.startChain;
  }

  /**
   * Chain a task onto the serialized adapter queue and return a promise for
   * that task. Every registry mutation runs through here — the background
   * start pass, reload's reconcile, and the register/unregister halves of
   * enable/disable/addAdapter/removeAdapter/updateConfig — so no two of them
   * can ever interleave (a concurrent pair could double-register an adapter,
   * or unregister one an in-flight pass then re-registers).
   *
   * The returned promise settles with the task itself, including rejection,
   * so public methods keep surfacing their own failures to callers. The
   * chain tail is sanitized separately: one broken task never poisons the
   * tasks queued after it, and {@link adaptersStarted} never rejects.
   *
   * A queued task must never await the chain (e.g. via
   * {@link adaptersStarted}, {@link queueStartEnabledAdapters}, or another
   * enqueue) — that would deadlock the chain waiting on itself. Tasks call
   * {@link startEnabledAdapters} directly instead, since they already run
   * inside the chain. Because config state can change while a task waits its
   * turn, tasks must re-check current state (still enabled? already
   * registered?) once they run.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.startChain.then(() => task());
    this.startChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Run {@link startEnabledAdapters} serialized behind any in-flight task, so
   * initialize()'s background pass and other registry mutations never
   * interleave. Per-adapter failures are isolated inside
   * startEnabledAdapters; a whole-pass failure is logged here because
   * initialize() fires this without awaiting it.
   */
  private queueStartEnabledAdapters(): Promise<void> {
    return this.enqueue(() => this.startEnabledAdapters()).catch((err) => {
      logger.warn('[AdapterManager] Adapter start pass failed:', err);
    });
  }

  /**
   * Enable a specific adapter by ID and persist the change to disk.
   *
   * The config flip + persist happen immediately; the register itself is
   * serialized through {@link enqueue} so it can never interleave with the
   * background start pass (which may be mid-loop when this is called).
   * Resolves once the queued register has settled; register failures reject.
   */
  async enable(id: string): Promise<void> {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);

    config.enabled = true;
    await this.persistConfigs();

    await this.enqueue(async () => {
      if (this.stopped) return; // shutdown() ran while queued
      // Re-check inside the queue — the world may have changed while this
      // task waited its turn. The registry.get here is the authoritative
      // dedupe against the background start pass having registered it.
      const current = this.configs.find((c) => c.id === id);
      if (!current?.enabled) return;
      if (this.registry.get(id)) return;

      const adapter = await this.buildAdapter(current);
      if (!adapter) return;
      try {
        await this.registry.register(adapter);
        this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.connected', 'Connected to relay');
        await this.emitAdapterLifecycle(id, 'connected');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.error', message);
        throw err;
      }
    });
  }

  /**
   * Disable a specific adapter by ID and persist the change to disk.
   *
   * The unregister is serialized through {@link enqueue}: if the background
   * start pass is mid-register for this adapter, the queued unregister lands
   * after the pass settles, so the adapter can never survive a disable.
   */
  async disable(id: string): Promise<void> {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`Adapter not found: ${id}`);

    config.enabled = false;
    await this.persistConfigs();

    await this.enqueue(async () => {
      try {
        await this.registry.unregister(id);
      } catch (err) {
        // The config already says disabled. If the adapter would not let go of
        // its connection, the cockpit would show "disabled" over a bot that is
        // still answering — the exact shape of dishonesty this batch exists to
        // remove. Record it and rethrow so the person is told the disable did
        // not take (DOR-789).
        const message = err instanceof Error ? err.message : String(err);
        this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.error', message);
        logger.error(
          `[AdapterManager] '${id}' is disabled in settings but would not stop, so it may ` +
            `still be connected — restart DorkOS if it keeps answering: ${message}`
        );
        throw err;
      }
      this.deps.eventRecorder?.insertAdapterEvent(
        id,
        'adapter.disconnected',
        'Disconnected from relay'
      );
      await this.emitAdapterLifecycle(id, 'disconnected');
    });
  }

  /**
   * List all adapter configs paired with their current runtime status.
   */
  listAdapters(): Array<{ config: AdapterConfig; status: AdapterStatus }> {
    return this.configs.map((config) => this.buildAdapterView(config));
  }

  /**
   * The ids of the saved integrations the last load could not read.
   *
   * They are not running and never will be until someone fixes them, and —
   * because nothing about them could be understood — any token they hold is
   * still in the file in plain text. `GET /api/health/deep` reports the count
   * so an operator finds out without reading server logs.
   *
   * An entry too broken to carry a readable id contributes an empty string, so
   * the count still matches the number of unreadable entries.
   *
   * @returns One id per unreadable entry, in file order.
   */
  listUnparsedEntryIds(): string[] {
    return this.unparsedConfigEntries.map((entry) => unparsedEntryId(entry) ?? '');
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

  /**
   * Get the bridge lifecycle coordinator, or undefined when the rooms subsystem
   * is not wired. The relay bindings PATCH route (DOR-878) calls
   * {@link BridgeLifecycle.bridge}/`unbridge` through it to turn a binding's
   * bridge on and off from the cockpit.
   */
  getBridgeLifecycle(): import('./chat-bridge/index.js').BridgeLifecycle | undefined {
    return this.bindingSubsystem?.getBridgeLifecycle();
  }

  /** Get the MeshCore dependency, or undefined if not provided. */
  getMeshCore(): AdapterMeshCoreLike | undefined {
    return this.deps.meshCore;
  }

  /**
   * The approver allowlist one adapter is configured with, in whatever shape
   * config held it.
   *
   * Read off the masked view rather than the raw config on purpose: masking
   * only rewrites `password` fields, and `approverAllowlist` is a textarea, so
   * the value comes through intact while nothing here can reach a secret.
   *
   * @param adapterId - The adapter instance.
   * @returns The configured value, or `undefined` when there is no such
   *   adapter — which authorizes nobody, because `mayApprove` fails closed.
   */
  private approverAllowlistFor(adapterId: string): unknown {
    const config = this.getAdapter(adapterId)?.config.config as Record<string, unknown> | undefined;
    return config?.approverAllowlist;
  }

  /**
   * Which platform an adapter instance speaks — `'telegram'`, `'slack'`.
   *
   * The adapter's configured `type`, which is exactly the string its inbound
   * path stamps onto an approval's `platform` field, so the two are comparable
   * by construction rather than by convention.
   *
   * @param adapterId - The adapter instance.
   * @returns Its platform, or `undefined` when there is no such adapter — which
   *   matches no principal, and so authorizes nobody.
   */
  private platformOf(adapterId: string): string | undefined {
    return this.getAdapter(adapterId)?.config.type;
  }

  /**
   * Whether a click on a chat platform may authorize one session's tool call
   * (spec `ask-entitlement` §5.3).
   *
   * **The second of two independent gates, and neither is trusted to be the
   * only one.** The adapter's own `mayApprove` runs in process on the click and
   * is unchanged; this runs server-side, before the runtime is touched, because
   * the relay bus carries no authority of its own and a room-bound Ask reaches
   * it by a path no adapter binding covers.
   *
   * Two branches:
   *
   * - **the port is missing** — refused. See the body: a wiring omission must
   *   not read as a direct-bind session.
   * - **the session is room-bound** — {@link askEntitlement} must say `answer`,
   *   which means the click arrived from the platform that room is bridged to
   *   AND the clicking person is named on that bridge adapter's approver
   *   allowlist. A `respondedBy` of `undefined` fails it, the same answer the
   *   adapters give an unidentified caller.
   * - **the session is NOT room-bound** — allowed, the direct-bind path keeping
   *   the shipped gate it has. A stated boundary, not a fail-open default: the
   *   spec's Non-Goals say the direct-bind path is not widened here, and
   *   `approver-allowlist.ts`'s own module doc records the residual.
   *
   * @param decision - What arrived on the approval bus.
   * @returns Whether to forward the decision to the runtime.
   */
  authorizeBridgedApproval(decision: {
    sessionId: string;
    platform: string;
    respondedBy: string | undefined;
  }): boolean {
    const bindings = this.deps.roomSessionBindings;
    if (!bindings) {
      // **Absent means refuse, not allow.** Without this port nothing here can
      // tell a room-bound session from a direct-bound one, so the "not
      // room-bound → keep the shipped direct-bind gate" branch below would
      // swallow every room-bound approval as well — a wiring omission would
      // silently become a fail-open. The composition root always supplies it;
      // a boot that did not has no rooms, and therefore no room-bound Ask for
      // this to refuse.
      logger.warn(
        '[AdapterManager] refusing a bridged approval: no room-session binding port is wired, ' +
          'so this decision cannot be attributed to a room'
      );
      return false;
    }
    const binding = bindings.bindingForSession(decision.sessionId);
    if (!binding) return true;

    const bridge = this.deps.roomBridges?.findBridgeByRoom(binding.roomId);
    return (
      askEntitlement(
        {
          kind: 'bridged',
          platform: decision.platform,
          // An unidentified clicker becomes the empty id, which `mayApprove`
          // refuses outright — the same answer the adapters give. It is
          // deliberately not smuggled past the policy as an absent field.
          platformUserId: decision.respondedBy ?? '',
        },
        {
          sessionId: decision.sessionId,
          roomId: binding.roomId,
          // No bridge means no allowlist to consult, which authorizes nobody.
          approvers: bridge ? toIdList(this.approverAllowlistFor(bridge.adapterId)) : [],
          // The list and the platform come from the SAME bridge, so the pair is
          // always one platform's answer — which is what lets `askEntitlement`
          // refuse a click that arrived from a different one.
          ...(bridge ? { approverPlatform: this.platformOf(bridge.adapterId) } : {}),
        }
      ) === 'answer'
    );
  }

  /**
   * Leave a chat on its platform — the group-add claim flow's "Leave" action
   * (DOR-883, spec §12). Removes the bot from the chat through the live
   * adapter instance's own platform call; writes nothing here, on purpose —
   * the unclaimed-chats route owns dismissing the card once this resolves.
   *
   * @param adapterId - The adapter instance the chat lives on.
   * @param chatId - The platform chat id to leave.
   * @throws When the adapter is not registered or not connected, or does not
   *   support leaving a chat at all (every adapter except Telegram today).
   */
  async leaveChat(adapterId: string, chatId: string): Promise<void> {
    const adapter = this.registry.get(adapterId);
    if (!adapter) {
      throw new Error(`Adapter '${adapterId}' is not registered`);
    }
    if (!canLeaveChat(adapter)) {
      throw new Error(`Adapter '${adapterId}' does not support leaving a chat`);
    }
    await adapter.leaveChat(chatId);
  }

  /**
   * Enrich AdapterContext with Mesh agent info if meshCore is available.
   *
   * Uses the shared {@link parseAgentSubject} helper so both the legacy shape
   * (`relay.agent.<sessionId>`) and the runtime-scoped shape
   * (`relay.agent.<runtimeType>.<sessionId>`) resolve to the same mesh agent
   * identifier. The identifier in this slot is historically overloaded — it
   * may be a sessionId (from the binding router) or a mesh agentId (from
   * direct relay sends); either way we hand it to MeshCore which returns
   * `undefined` for misses, so no further disambiguation is needed here.
   *
   * The runtime type is taken from the subject when it is runtime-scoped; legacy
   * subjects carry no runtime segment and fall back to `'claude-code'`. Resolving
   * the runtime for a legacy subject would need an async `runtimeRegistry` lookup
   * that this synchronous, best-effort context builder deliberately avoids.
   */
  buildContext(subject: string): AdapterContext | undefined {
    if (!this.deps.meshCore) return undefined;

    const parsed = parseAgentSubject(subject);
    const agentId = parsed?.sessionId;
    if (!agentId) return undefined;

    const projectPath = this.deps.meshCore.getProjectPath(agentId);
    if (!projectPath) return undefined;

    return {
      agent: {
        directory: projectPath,
        runtime: parsed.runtimeType ?? 'claude-code',
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

    const adapterConfig = parseAdapterConfigForPersist(
      {
        id,
        type,
        enabled,
        builtin: false, // User-created instances are never builtin
        ...(label ? { label } : {}),
        config,
      },
      manifest
    );
    this.configs.push(adapterConfig);
    await this.persistConfigs();
    logger.debug('[AdapterManager] config saved', { id });

    if (enabled) {
      // Serialized through the queue: a hot-reload or start pass in flight
      // must settle before this register runs, so the new adapter can never
      // be registered twice. Re-check state inside the task — a queued
      // reload/remove may have dropped or disabled the config meanwhile.
      await this.enqueue(async () => {
        if (this.stopped) return;
        const current = this.configs.find((c) => c.id === id);
        if (!current?.enabled || this.registry.get(id)) return;

        const adapter = await this.buildAdapter(current);
        if (!adapter) return;
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
      });
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
    await this.persistConfigs();
  }

  /** Remove an adapter instance, stop it if running, and persist the change. */
  async removeAdapter(id: string): Promise<void> {
    const index = this.configs.findIndex((c) => c.id === id);
    if (index === -1) {
      // Not a running integration — but it may be one whose saved settings
      // could not be read. Those are held aside rather than started, and
      // without this they were undeletable from every surface: invisible to
      // the list, unremovable by name, and rewritten on every save. Deleting
      // one is also the only way to clear a cleartext credential stuck inside
      // it, so this path has to exist.
      if (await this.removeUnparsedEntry(id)) return;
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

    // Serialized: an in-flight start pass may be registering this adapter
    // right now; queueing the unregister behind it guarantees the removal
    // lands after, so the adapter can never outlive its config.
    await this.enqueue(async () => {
      try {
        await this.registry.unregister(id);
      } catch (err) {
        // The config is going away either way — the person asked for that. But
        // an adapter that would not stop is still connected, and saying nothing
        // about it is how a bot goes on answering from an integration the
        // cockpit no longer lists.
        const message = err instanceof Error ? err.message : String(err);
        this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.error', message);
        logger.error(
          `[AdapterManager] '${id}' would not stop while being removed and may still be ` +
            `connected — restart DorkOS if it keeps answering: ${message}`
        );
      }
    });

    await this.emitAdapterLifecycle(id, 'disconnected', adapterName);
    this.configs.splice(index, 1);
    await this.persistConfigs();
    // Best-effort cleanup of the removed adapter's stored secrets (DOR-280).
    await deleteAdapterSecrets(config, this.secretsCtx);

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
        // Bindings were deleted server-side (not via the binding routes), so
        // signal clients to re-fetch their binding list.
        broadcastBindingsChanged();
        logger.info(
          '[AdapterManager] Cleaned %d orphan binding(s) for removed adapter %s',
          orphanBindings.length,
          id
        );
      }
    }
  }

  /**
   * Delete an entry whose saved settings could not be read.
   *
   * Nothing was started for it and no secret of its was ever migrated, so this
   * is a file edit and nothing more: drop it and rewrite `adapters.json`.
   *
   * @param id - The id read off the unreadable entry.
   * @returns `true` when an entry was found and removed.
   */
  private async removeUnparsedEntry(id: string): Promise<boolean> {
    const index = this.unparsedConfigEntries.findIndex((entry) => unparsedEntryId(entry) === id);
    if (index === -1) return false;

    this.unparsedConfigEntries.splice(index, 1);
    await this.persistConfigs();
    logger.info(
      `[AdapterManager] Removed the unreadable saved entry for '${id}'. Nothing was running ` +
        `for it; any credential it held is now gone from adapters.json.`
    );
    return true;
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

    // Re-parse the whole entry rather than assigning the merged record straight
    // in: the merge can drop a key the incoming config omitted, and an
    // unvalidated write is what let an entry reach disk with no `dmPolicy`
    // (see `parseForPersist`).
    existing.config = parseAdapterConfigForPersist(
      { ...existing, config: mergedConfig },
      manifest
    ).config;

    // Promote label from config to top-level if present (client embeds it in config)
    if (typeof mergedConfig.label === 'string' && mergedConfig.label) {
      existing.label = mergedConfig.label;
    }
    await this.persistConfigs();

    // Restart the adapter if running. Serialized and re-checked inside the
    // queue — the enabled/registered snapshot taken outside the queue could
    // be stale against an in-flight start pass or a queued disable.
    await this.enqueue(async () => {
      if (this.stopped) return;
      const current = this.configs.find((c) => c.id === id);
      if (!current?.enabled || !this.registry.get(id)) return;
      try {
        await this.registry.unregister(id);
      } catch (err) {
        // Do NOT build a replacement. The old adapter failed to let go of its
        // connection and is still registered; starting a second one on the same
        // credentials is how one bot token ended up with two pollers, every
        // message delivered twice, and two agent turns billed for one question.
        // The new settings are saved and take effect on the next successful
        // start (a restart, or a re-enable once the stuck adapter releases).
        const message = err instanceof Error ? err.message : String(err);
        this.deps.eventRecorder?.insertAdapterEvent(id, 'adapter.error', message);
        logger.error(
          `[AdapterManager] '${id}' would not stop, so its new settings were saved but not ` +
            `applied — restarting it now would run two copies at once: ${message}`
        );
        throw err;
      }
      const adapter = await this.buildAdapter(current);
      if (adapter) await this.registry.register(adapter);
    });
  }

  /** Stop all adapters and the config file watcher. */
  async shutdown(): Promise<void> {
    // Halt any in-flight background start pass before tearing the registry
    // down, so it can't register fresh adapters into a dead relay.
    this.stopped = true;
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
      if (this.stopped) return; // shutdown() ran mid-pass
      if (!config.enabled) continue;
      if (this.registry.get(config.id)) continue; // Already running

      // buildAdapter is inside the try: resolving a credential reference can
      // throw (a dangling `file:`/`keychain:` secret — DOR-280), and one
      // adapter's missing secret must never abort the whole relay. Isolate it
      // as an adapter.error event and keep starting the rest.
      try {
        const adapter = await this.buildAdapter(config);
        if (!adapter) continue;
        if (this.stopped) return; // shutdown() ran while building — registry is dead
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
    // Every connect/disconnect is a status change connected clients should see
    // without waiting for the 10s poll — signal before the activity early-return.
    broadcastAdaptersChanged();

    // The reconnect catch-up trigger (chats-as-channels §6.1): when an adapter
    // comes (back) up, re-scan every bridged chat on it for entries that could
    // not be delivered while it was down. Detached — a delivery walk must never
    // sit in front of the lifecycle broadcast — and best-effort.
    if (state === 'connected') {
      const catchUp = this.bindingSubsystem?.bridgeCatchUp;
      if (catchUp) {
        void catchUp.scanAdapter(id).catch((err: unknown) => {
          logger.warn('[AdapterManager] bridge catch-up on reconnect failed', {
            adapterId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      // The adapter-start/reconnect half of §8's visibility refresh (chats-as-
      // channels task 1.13): this codebase has no event narrower than a fresh
      // `'connected'` emit, so — like the catch-up scan above — a genuine
      // reconnect and a first start both ride this branch. Detached and
      // best-effort for the same reason: a visibility check must never sit in
      // front of the lifecycle broadcast, and a failed one leaves every live
      // bridge's stored value exactly where it was (the conservative default,
      // per `room-context-framing.ts`).
      void this.refreshBridgeVisibility(id).catch((err: unknown) => {
        logger.warn('[AdapterManager] bridge visibility refresh failed', {
          adapterId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

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

  /**
   * Refresh `visibility`/`visibilityCheckedAt` on every live bridge on one
   * adapter, from that adapter's own live `getMe()` — chats-as-channels §8's
   * source of truth, and the FLAG task 1.13 resolves: refresh on bridge
   * create ({@link BridgeLifecycle.bridge}, threaded through
   * {@link BindingSubsystemDeps.refreshVisibility}) and here, on adapter
   * start/reconnect.
   *
   * A no-op for any adapter that does not report visibility — every adapter
   * except Telegram today — and for one with no live bridges. Errors
   * propagate to the caller, which is `emitAdapterLifecycle`'s job to log and
   * swallow: a failed refresh must never fail an adapter's start.
   *
   * @param adapterId - The adapter that just started or reconnected.
   */
  private async refreshBridgeVisibility(adapterId: string): Promise<void> {
    const bridges = this.deps.roomBridges;
    if (!bridges) return;
    const adapter = this.registry.get(adapterId);
    if (!adapter || !reportsVisibility(adapter)) return;

    const me = await adapter.getMe();
    // `null` means "not yet connected", not "checked and off" — nothing to
    // record, and the stored value (already the conservative `'partial'`
    // default when absent) is left exactly where it was.
    if (!me) return;

    const visibility: BridgeVisibility = me.canReadAllGroupMessages
      ? 'everything'
      : 'mentions-only';
    const checkedAt = new Date().toISOString();
    for (const bridge of bridges.listLiveBridgesByAdapter(adapterId)) {
      bridges.setVisibility(bridge.roomId, visibility, checkedAt);
    }
  }

  /** Delegate adapter instantiation to the factory module. */
  private async buildAdapter(config: AdapterConfig): Promise<RelayAdapter | null> {
    // Resolve credential references to real secrets in memory only — the
    // adapter receives the live token, but it is never written back to disk
    // (DOR-280). A cleartext value (e.g. a transient test config) passes
    // through unchanged.
    const resolved = await resolveAdapterSecrets(config, {
      provider: this.credentialProvider,
      manifests: this.manifests,
    });
    return createAdapter(
      resolved,
      {
        agentRuntimes: this.agentRuntimes,
        traceStore: this.deps.traceStore,
        taskStore: this.deps.taskStore,
        agentSessionStore: this.bindingSubsystem?.getAgentSessionStore(),
        approvalAuthorizer: (decision) => this.authorizeBridgedApproval(decision),
        // The one map both sides of the inbound-budget thread read (DOR-791):
        // the adapter binds a turn here, the in-session `relay_send*` tools read
        // it back. Taken off the relay rather than constructed, so there is
        // exactly one per process.
        ...(this.deps.relayCore?.inboundBudgets && {
          inboundBudgets: this.deps.relayCore.inboundBudgets,
        }),
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
