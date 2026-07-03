import path from 'path';
import { createApp, finalizeApp } from './app.js';
import { ClaudeCodeRuntime } from './services/runtimes/claude-code/claude-code-runtime.js';
import { CodexRuntime, CodexThreadMap } from './services/runtimes/codex/index.js';
import { OpenCodeRuntime, openCodeServerManager } from './services/runtimes/opencode/index.js';
import {
  runtimeRegistry,
  applyConfiguredDefaultRuntime,
} from './services/core/runtime-registry.js';
import { tunnelManager } from './services/core/tunnel-manager.js';
import { initConfigManager, configManager } from './services/core/config-manager.js';
import { initCredentialProvider } from './services/core/credential-provider.js';
import { initBoundary } from './lib/boundary.js';
import { initLogger, logger, logError } from './lib/logger.js';
import { createDorkOsToolServer } from './services/runtimes/claude-code/mcp-tools/index.js';
import { TaskStore } from './services/tasks/task-store.js';
import { TaskSchedulerService } from './services/tasks/task-scheduler-service.js';
import { resolveTasksFiring } from './services/tasks/resolve-firing.js';
import { TaskFileWatcher } from './services/tasks/task-file-watcher.js';
import { TaskReconciler } from './services/tasks/task-reconciler.js';
import { ensureDefaultTemplates } from './services/tasks/task-templates.js';
import { createTasksRouter } from './routes/tasks.js';
import { setTasksEnabled, setTasksInitError } from './services/tasks/task-state.js';
import {
  RelayCore,
  AdapterRegistry,
  SignalEmitter,
  type ClaudeCodeAgentRuntimeLike,
} from '@dorkos/relay';
import { createRelayRouter } from './routes/relay.js';
import { setRelayEnabled, setRelayInitError } from './services/relay/relay-state.js';
import { AdapterManager } from './services/relay/adapter-manager.js';
import { TraceStore } from './services/relay/trace-store.js';
import { MeshCore } from '@dorkos/mesh';
import { createMeshRouter } from './routes/mesh.js';
import { setMeshEnabled, setMeshInitError } from './services/mesh/mesh-state.js';
import { ensureDorkBot } from './services/mesh/ensure-dorkbot.js';
import { createA2aRouter } from './routes/a2a.js';
import { createAgentsRouter } from './routes/agents.js';
import { createDiscoveryRouter } from './routes/discovery.js';
import { createTemplateRouter } from './routes/templates.js';
import { createAdminRouter } from './routes/admin.js';
import { ExtensionManager } from './services/extensions/extension-manager.js';
import { ensureCoreExtensions } from './services/core-extensions/ensure-core-extensions.js';
import { warnRedundantEnabledEntries } from './services/core-extensions/warn-redundant-enabled.js';
import type { CoreExtensionInfo } from './services/extensions/extension-enable-resolution.js';
import { createExtensionsRouter } from './routes/extensions.js';
import { createAgentWorkspace } from './services/core/agent-creator.js';
import { defaultTemplateDownloader } from './services/core/template-downloader.js';
import { MarketplaceSourceManager } from './services/marketplace/marketplace-source-manager.js';
import { MarketplaceCache } from './services/marketplace/marketplace-cache.js';
import { PackageResolver } from './services/marketplace/package-resolver.js';
import { PackageFetcher } from './services/marketplace/package-fetcher.js';
import { ConflictDetector } from './services/marketplace/conflict-detector.js';
import { PermissionPreviewBuilder } from './services/marketplace/permission-preview.js';
import { PluginInstallFlow } from './services/marketplace/flows/install-plugin.js';
import { AgentInstallFlow } from './services/marketplace/flows/install-agent.js';
import { SkillPackInstallFlow } from './services/marketplace/flows/install-skill-pack.js';
import { AdapterInstallFlow } from './services/marketplace/flows/install-adapter.js';
import { UninstallFlow } from './services/marketplace/flows/uninstall.js';
import { UpdateFlow } from './services/marketplace/flows/update.js';
import { MarketplaceInstaller } from './services/marketplace/marketplace-installer.js';
import { createMarketplaceRouter } from './routes/marketplace.js';
import { runAutoProjection } from './services/harness/auto-project.js';
import { ensurePersonalMarketplace } from './services/marketplace-mcp/personal-marketplace.js';
import {
  AutoApproveConfirmationProvider,
  TokenConfirmationProvider,
  type ConfirmationProvider,
} from './services/marketplace-mcp/confirmation-provider.js';
import { setMarketplaceConfirmationProvider } from './services/marketplace-mcp/confirmation-registry.js';
import type { MarketplaceMcpDeps } from './services/marketplace-mcp/marketplace-mcp-tools.js';
import { ActivityService } from './services/activity/activity-service.js';
import { createActivityRouter } from './routes/activity.js';
import { createExtensionRoutesMiddleware } from './middleware/extension-routes.js';
import { createExternalMcpServer } from './services/core/mcp-server.js';
import { createMcpRouter } from './routes/mcp.js';
import { mcpApiKeyAuth } from './middleware/mcp-auth.js';
import { validateMcpOrigin } from './middleware/mcp-origin.js';
import { requireMcpEnabled } from './middleware/mcp-enabled.js';
import { buildMcpRateLimiter } from './middleware/mcp-rate-limit.js';
import { createDb, runMigrations } from '@dorkos/db';
import { INTERVALS } from './config/constants.js';
import { resolveDorkHome } from './lib/dork-home.js';
import { SERVER_VERSION } from './lib/version.js';
import { createWorkspaceSubsystem, setWorkspaceManager } from './services/workspace/index.js';
import { registerDorkosCommunityTelemetry } from './services/marketplace/telemetry-reporter.js';
import { eventFanOut } from './services/core/event-fan-out.js';
import { sessionListBroadcaster } from './services/session/session-list-broadcaster.js';
import { aggregateSessionList } from './services/session/aggregate-session-list.js';
import { env } from './env.js';

const PORT = env.DORKOS_PORT;

// Global references for graceful shutdown
let claudeRuntime: ClaudeCodeRuntime | null = null;
let schedulerService: TaskSchedulerService | null = null;
let relayCore: RelayCore | undefined;
let adapterRegistry: AdapterRegistry | undefined;
let adapterManager: AdapterManager | undefined;
let traceStore: TraceStore | undefined;
let meshCore: MeshCore | undefined;
let extensionManager: ExtensionManager | undefined;
let taskFileWatcher: TaskFileWatcher | undefined;
let taskReconciler: TaskReconciler | undefined;
let healthCheckInterval: ReturnType<typeof setInterval> | undefined;

async function start() {
  // Resolve data directory once and make it available to all downstream services.
  // Priority: DORK_HOME env var > .temp/.dork (dev) > ~/.dork (production)
  const dorkHome = resolveDorkHome();
  // eslint-disable-next-line no-restricted-syntax -- write (not read): broadcasts resolved dorkHome to services loaded after this point
  process.env.DORK_HOME = dorkHome;
  console.log(`[DorkOS] Data directory: ${dorkHome}`);

  const logLevel = env.DORKOS_LOG_LEVEL;
  initLogger({ level: logLevel, logDir: path.join(dorkHome, 'logs') });
  initConfigManager(dorkHome);
  // Credential substrate (ADR-0315): resolves stored credential references to
  // secrets at each runtime's env-injection seam. Must precede any runtime spawn.
  initCredentialProvider(dorkHome);

  // Apply logging config (maxLogSize/maxLogFiles) from user config.
  // initLogger was already called above with defaults — re-init with config values.
  const loggingConfig = configManager.get('logging');
  if (loggingConfig?.maxLogSizeKb || loggingConfig?.maxLogFiles) {
    initLogger({
      level: logLevel,
      logDir: path.join(dorkHome, 'logs'),
      maxLogSize: (loggingConfig.maxLogSizeKb ?? 500) * 1024,
      maxLogFiles: loggingConfig.maxLogFiles ?? 14,
    });
  }

  // Create consolidated Drizzle database and run migrations before any service init.
  // Individual services still manage their own legacy databases for now — they will
  // be migrated to accept this `db` instance in subsequent tasks.
  const dbPath = path.join(dorkHome, 'dork.db');
  const db = createDb(dbPath);
  runMigrations(db);
  logger.info(`[DB] Consolidated database ready at ${dbPath}`);

  // Inject the DB handle into the runtime registry so session-scoped resolution
  // (resolveForSession / persistSessionRuntime / getSessionRuntimeType) can read
  // and write the `session_metadata` table. Must happen before any route or
  // service uses these methods. See ADR 0255.
  runtimeRegistry.setDb(db);

  // Initialize Activity Service and prune stale events
  const activityService = new ActivityService(db);
  const retentionDays = env.DORKOS_ACTIVITY_RETENTION_DAYS ?? 30;
  try {
    const pruned = await activityService.prune(retentionDays);
    if (pruned > 0) {
      logger.info(`[Activity] Pruned ${pruned} events older than ${retentionDays} days`);
    }
  } catch (err) {
    logger.warn('[Activity] Startup prune failed', logError(err));
  }

  // Initialize directory boundary (must happen before app creation)
  const boundaryConfig = env.DORKOS_BOUNDARY;
  const resolvedBoundary = await initBoundary(boundaryConfig);
  logger.info(`[Boundary] Directory boundary: ${resolvedBoundary}`);

  // Register the dorkos.ai marketplace telemetry reporter. This is a no-op
  // unless `config.telemetry.enabled === true` — defaults to false. The
  // reporter forwards `InstallEvent`s emitted by the marketplace install
  // pipeline to https://dorkos.ai/api/telemetry/install with a stable
  // per-machine install ID stored in dorkHome. Privacy contract:
  // https://dorkos.ai/marketplace/privacy
  const telemetryConfig = configManager.get('telemetry');
  registerDorkosCommunityTelemetry(telemetryConfig?.enabled ?? false, dorkHome, SERVER_VERSION);
  if (telemetryConfig?.enabled) {
    logger.info('[Telemetry] Marketplace install reporter registered (consent: opt-in)');
  }

  // Stage the bundled core extensions on disk before the discovery pipeline
  // runs, and capture their tier metadata (default-on/off, disableability) to
  // hand to the ExtensionManager. Non-fatal: a missing or malformed bundle must
  // not block server boot — it just means that core extension is absent.
  let coreExtensions: CoreExtensionInfo[] = [];
  try {
    coreExtensions = await ensureCoreExtensions(dorkHome);
  } catch (err) {
    logger.warn('[CoreExtensions] Failed to stage core extensions', logError(err));
  }
  // Honest-by-design guardrail: warn if a hand-editor listed a default-on core
  // extension in `extensions.enabled` (a no-op — use `extensions.disabled`).
  warnRedundantEnabledEntries(coreExtensions, configManager.get('extensions').enabled);

  // Initialize Extension System
  try {
    extensionManager = new ExtensionManager(dorkHome, coreExtensions);
    const initialCwd = env.DORKOS_DEFAULT_CWD ?? null;
    await extensionManager.initialize(initialCwd);
    logger.info('[Extensions] Extension system initialized');
  } catch (err) {
    logger.error('[Extensions] Failed to initialize extension system', err);
    // Extension failure is non-fatal: server continues without extensions
    extensionManager = undefined;
  }

  // --- Register runtime: TestModeRuntime in test mode, ClaudeCodeRuntime otherwise ---
  if (env.DORKOS_TEST_RUNTIME) {
    const { TestModeRuntime } = await import('./services/runtimes/test-mode/test-mode-runtime.js');
    runtimeRegistry.register(new TestModeRuntime());
    // Optional SECOND instance under a distinct type — gives e2e a server with
    // more than one registered runtime (status-bar picker, ?runtime= launch
    // binding, session-list runtime marks) with zero real agent binaries.
    // Test branch only; the production path never registers test runtimes.
    if (env.DORKOS_TEST_RUNTIME_SECONDARY) {
      runtimeRegistry.register(new TestModeRuntime('test-mode-b'));
      logger.info('[TestMode] Secondary TestModeRuntime registered as test-mode-b');
    }
    runtimeRegistry.setDefault('test-mode');
    logger.info('[TestMode] TestModeRuntime registered — no real Claude API calls will be made');
  } else {
    claudeRuntime = new ClaudeCodeRuntime(dorkHome, env.DORKOS_DEFAULT_CWD);
    runtimeRegistry.register(claudeRuntime);
    // Inject the core session-settings store (ADR-0260). The registry implements
    // SessionSettingsPort structurally over session_metadata; setDb() ran above.
    claudeRuntime.setSessionSettings(runtimeRegistry);
    logger.info('[Runtime] ClaudeCodeRuntime registered as default');

    // Non-blocking warm-up — populates model cache without delaying server listen
    claudeRuntime.warmup().catch((err) => {
      logger.warn('[Startup] Model warm-up failed (will retry on first API call)', { err });
    });

    // Non-blocking plugin scan — populates activatedPlugins cache so the first
    // session picks up any previously installed marketplace plugins (ADR-0239).
    claudeRuntime.refreshActivatedPlugins().catch((err) => {
      logger.warn('[Startup] Plugin activation scan failed (will retry on next install)', { err });
    });

    // --- Codex runtime (spec additional-agent-runtimes, ADR-0309) ---
    // Gated on `runtimes.codex.enabled` config. Must register BEFORE
    // sessionListBroadcaster.start() below — runtimes registered after
    // start() are not fanned into the global session-list stream.
    const codexConfig = configManager.get('runtimes').codex;
    if (codexConfig.enabled) {
      const codexRuntime = new CodexRuntime({
        // The thread map shares the consolidated Drizzle handle injected into
        // runtimeRegistry.setDb() above (one DB, one `codex_threads` table).
        threadMap: new CodexThreadMap(db),
        binaryPath: codexConfig.binaryPath,
      });
      // Durable per-session settings hydrate/write-through (ADR-0260), same
      // port the Claude adapter uses.
      codexRuntime.setSessionSettings(runtimeRegistry);
      runtimeRegistry.register(codexRuntime);
      logger.info('[Runtime] CodexRuntime registered');
    }

    // --- OpenCode runtime (spec additional-agent-runtimes, ADR-0308) ---
    // Gated on `runtimes.opencode.enabled` config. Must register BEFORE
    // sessionListBroadcaster.start() below, same as Codex. The sidecar spawns
    // lazily on first use; its shutdown is wired into shutdownServices().
    const openCodeConfig = configManager.get('runtimes').opencode;
    if (openCodeConfig.enabled) {
      const openCodeRuntime = new OpenCodeRuntime({ provider: openCodeServerManager });
      // Durable per-session settings hydrate/write-through (ADR-0260), same
      // port the Claude adapter uses.
      openCodeRuntime.setSessionSettings(runtimeRegistry);
      runtimeRegistry.register(openCodeRuntime);
      logger.info('[Runtime] OpenCodeRuntime registered');
    }

    // Apply the user's configured default runtime (runtimes.default) once all
    // production runtimes are registered. An unregistered value (disabled
    // runtime, typo) keeps the built-in default rather than failing boot.
    const configuredDefault = configManager.get('runtimes').default;
    if (
      !applyConfiguredDefaultRuntime(runtimeRegistry, configuredDefault) &&
      configuredDefault !== runtimeRegistry.getDefaultType()
    ) {
      logger.warn('[Runtime] configured runtimes.default is not registered; keeping built-in', {
        configured: configuredDefault,
        active: runtimeRegistry.getDefaultType(),
      });
    }
  }

  // Workspace subsystem (DOR-84) — server-managed isolated workspaces. Sessions
  // bind via cwd; the manager allocates collision-free port blocks and owns the
  // lifecycle. Attached sessions are resolved from the runtime's session list.
  const workspaceConfig = configManager.get('workspace');
  if (workspaceConfig.enabled) {
    const { service: workspaceService, reconciler: workspaceReconciler } = createWorkspaceSubsystem(
      {
        db,
        dorkHome,
        config: workspaceConfig,
        listAttachedSessions: async (workspacePath) => {
          try {
            // Aggregate across every registered runtime (ADR-0310) — a workspace
            // may hold Codex or OpenCode sessions, not just the default runtime's.
            const { sessions } = await aggregateSessionList({
              runtimes: runtimeRegistry.listRuntimes(),
              projectDir: workspacePath,
            });
            return sessions.map((s) => ({
              sessionId: s.id,
              cwd: s.cwd ?? workspacePath,
              title: s.title,
            }));
          } catch {
            return [];
          }
        },
      }
    );
    setWorkspaceManager(workspaceService);
    workspaceReconciler.start();
    logger.info('[Workspace] WorkspaceManager registered');
  }

  // Initialize Tasks scheduler if enabled
  const schedulerConfig = configManager.get('scheduler');

  const tasksEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED : schedulerConfig.enabled;

  // The FIRING gate (ADR-285) is decoupled from the subsystem gate above: tasks
  // still list/display wherever the subsystem is up, but only a real production
  // environment fires (dev/preview default off unless DORKOS_TASKS_ENABLED=true).
  const firing = resolveTasksFiring({
    nodeEnv: env.NODE_ENV,
    // eslint-disable-next-line no-restricted-syntax -- presence check: unset vs explicit false
    explicitOverride: 'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED : undefined,
    schedulerEnabled: schedulerConfig.enabled,
  });

  let taskStore: TaskStore | undefined;
  if (tasksEnabled) {
    try {
      taskStore = new TaskStore(db);
      logger.info('[Tasks] TaskStore initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Tasks] Failed to initialize TaskStore at ${dorkHome}`, errInfo);
      setTasksInitError(errInfo.error);
      // Tasks failure is non-fatal: server continues without scheduler routes.
    }
  }

  // Initialize Relay if enabled
  const relayConfig = configManager.get('relay');
  // Env var wins when explicitly set; fall back to config when not set.
  // boolFlag defaults to false even when unset, so check process.env directly.

  const relayEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_RELAY_ENABLED' in process.env ? env.DORKOS_RELAY_ENABLED : relayConfig.enabled;

  // Phase A: core relay infrastructure (RelayCore + TraceStore)
  // AdapterManager construction is deferred to Phase C (after meshCore init)
  // so that meshCore is available for CWD resolution via buildContext().
  const relayDataDir = relayConfig.dataDir ?? path.join(dorkHome, 'relay');
  if (relayEnabled) {
    try {
      adapterRegistry = new AdapterRegistry();
      adapterRegistry.setLogger(logger);

      // Initialize trace store before RelayCore so it can be injected for delivery tracking
      traceStore = new TraceStore(db);
      logger.info('[Relay] TraceStore initialized');

      relayCore = new RelayCore({ dataDir: relayDataDir, adapterRegistry, db, traceStore, logger });
      await relayCore.registerEndpoint('relay.system.console');
      logger.info(`[Relay] RelayCore initialized (dataDir: ${relayDataDir})`);
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Relay] Failed to initialize at ${relayDataDir}`, errInfo);
      setRelayInitError(errInfo.error);
      // Relay failure is non-fatal: server continues without relay routes.
      relayCore = undefined;
      traceStore = undefined;
    }
  }

  // Initialize Mesh (always-on, ADR-0062)
  // Wire SignalEmitter when Relay is enabled so MeshCore can broadcast lifecycle
  // signals. When Relay is absent, signalEmitter stays undefined and MeshCore
  // silently skips signal emission.
  const meshSignalEmitter = relayCore ? new SignalEmitter() : undefined;

  try {
    meshCore = new MeshCore({
      db,
      relayCore,
      signalEmitter: meshSignalEmitter,
      logger,
    });
    logger.info('[Mesh] MeshCore initialized');

    // Provide MeshCore to runtime for per-session manifest lookup and peer agents context
    // Only ClaudeCodeRuntime exposes setMeshCore — skip in test mode.
    if (claudeRuntime) {
      claudeRuntime.setMeshCore(meshCore);
    }

    // Run startup reconciliation (non-fatal)
    try {
      const result = await meshCore.reconcileOnStartup();
      logger.info('[Mesh] Startup reconciliation complete', result);
    } catch (err) {
      logger.error('[Mesh] Startup reconciliation failed', logError(err));
    }

    // Ensure DorkBot system agent exists (non-fatal)
    try {
      await ensureDorkBot(meshCore, dorkHome);
    } catch (err) {
      logger.warn('[Mesh] Failed to ensure DorkBot system agent', logError(err));
    }

    // Start periodic reconciliation (every 5 minutes)
    meshCore.startPeriodicReconciliation(300_000);
  } catch (err) {
    const errInfo = logError(err);
    logger.error('[Mesh] Failed to initialize MeshCore', errInfo);
    setMeshInitError(errInfo.error);
    // Mesh failure is non-fatal: server continues without mesh routes.
  }

  // Phase C: adapter manager — now meshCore is available for CWD resolution.
  // Must run after meshCore init so buildContext() can call meshCore.getProjectPath().
  // Uses runtimeRegistry.getDefault() so this works in both production (ClaudeCodeRuntime)
  // and test mode (TestModeRuntime). Both satisfy AgentRuntimeLike structurally.
  if (relayEnabled && relayCore && adapterRegistry && traceStore) {
    try {
      const adapterConfigPath = path.join(dorkHome, 'relay', 'adapters.json');
      adapterManager = new AdapterManager(adapterRegistry, adapterConfigPath, {
        agentManager: runtimeRegistry.getDefault() as unknown as ClaudeCodeAgentRuntimeLike,
        traceStore,
        taskStore: taskStore,
        relayCore,
        meshCore, // meshCore is now available
        eventRecorder: traceStore,
        activityService,
      });
      await adapterManager.initialize();
      relayCore.setAdapterContextBuilder(adapterManager.buildContext.bind(adapterManager));

      // Provide relay binding context to runtime for <relay_connections> system prompt block
      const bindingRouter = adapterManager.getBindingRouter();
      const bindingStore = adapterManager.getBindingStore();
      if (claudeRuntime && bindingRouter && bindingStore) {
        claudeRuntime.setRelayBindingContext(bindingRouter, bindingStore, adapterManager);
      }

      logger.info('[Relay] AdapterManager initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error('[Relay] Failed to initialize AdapterManager', errInfo);
      // Non-fatal: RelayCore and MeshCore remain operational.
      // Adapters (including ClaudeCodeAdapter) will be unavailable.
      adapterManager = undefined;
    }
  }

  // Subscribe to lifecycle signals for diagnostic logging
  if (meshSignalEmitter && meshCore) {
    meshSignalEmitter.subscribe('mesh.agent.lifecycle.>', (subject, signal) => {
      logger.info(`[mesh] lifecycle: ${signal.state}`, { subject, data: signal.data });
    });
  }

  const app = createApp();

  // Build mcpToolDeps and register factory only when ClaudeCodeRuntime is available.
  let mcpToolDeps: Parameters<typeof createExternalMcpServer>[0] | undefined;
  // Marketplace MCP deps are populated later in the marketplace wiring block
  // (only when extensionManager + adapterManager are available). The factory
  // closure below reads the captured `let` binding lazily on each request, so
  // by the time the first MCP request arrives this is either populated or
  // intentionally undefined (relay disabled).
  let marketplaceMcpDeps: MarketplaceMcpDeps | undefined;
  if (claudeRuntime) {
    mcpToolDeps = {
      transcriptReader: claudeRuntime.getTranscriptReader(),
      defaultCwd: env.DORKOS_DEFAULT_CWD ?? process.cwd(),
      ...(taskStore && { taskStore }),
      ...(relayCore && { relayCore }),
      ...(adapterManager && { adapterManager }),
      ...(adapterManager && { bindingStore: adapterManager.getBindingStore() }),
      ...(adapterManager && { bindingRouter: adapterManager.getBindingRouter() }),
      ...(traceStore && { traceStore }),
      ...(meshCore && { meshCore }),
    };
    claudeRuntime.setMcpServerFactory((session) => ({
      dorkos: createDorkOsToolServer(mcpToolDeps!, session),
    }));
  }

  // Always mount /mcp — requireMcpEnabled handles the disabled case with a clean 503.
  const mcpRateLimiter = buildMcpRateLimiter();
  const mcpAuthMode =
    (env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey) ? 'auth: API key' : 'auth: none';

  app.use(
    '/mcp',
    validateMcpOrigin,
    requireMcpEnabled,
    mcpApiKeyAuth,
    mcpRateLimiter,
    createMcpRouter(() => {
      if (!claudeRuntime || !mcpToolDeps) {
        throw new Error(
          'ClaudeCodeRuntime not available — external MCP server cannot handle requests'
        );
      }
      return createExternalMcpServer(mcpToolDeps, marketplaceMcpDeps);
    })
  );
  logger.info(`[MCP] External MCP server mounted at /mcp (stateless, ${mcpAuthMode})`);

  // Mount Tasks routes if enabled — Tasks requires ClaudeCodeRuntime as SchedulerAgentManager.
  if (tasksEnabled && taskStore && claudeRuntime) {
    schedulerService = new TaskSchedulerService({
      store: taskStore,
      agentManager: claudeRuntime,
      config: {
        maxConcurrentRuns: schedulerConfig.maxConcurrentRuns,
        retentionCount: schedulerConfig.retentionCount,
        timezone: schedulerConfig.timezone,
        mayFire: firing.mayFire,
        firingReason: firing.reason,
      },
      relay: relayCore,
      meshCore,
      activityService,
      dorkHome,
    });
    app.use(
      '/api/tasks',
      createTasksRouter(taskStore, schedulerService, dorkHome, meshCore, activityService)
    );
    setTasksEnabled(true);
    logger.info('[Tasks] Routes mounted and scheduler configured');

    // Cascade-disable: when an agent is unregistered from Mesh, disable its linked task schedules
    if (meshCore) {
      meshCore.onUnregister((agentId) => {
        const disabledCount = taskStore.disableTasksByAgentId(agentId);
        if (disabledCount > 0) {
          logger.info(
            `[Tasks] Disabled ${disabledCount} schedule(s) for unregistered agent ${agentId}`
          );
        }
        // Stop watching the agent's task directory
        if (taskFileWatcher) {
          const projectPath = meshCore!.getProjectPath(agentId);
          if (projectPath) {
            const agentTasksDir = path.join(projectPath, '.dork', 'tasks');
            taskFileWatcher.stopWatching(agentTasksDir).catch(() => {});
          }
        }
        taskReconciler?.removeDirectory(
          meshCore!.getProjectPath(agentId)
            ? path.join(meshCore!.getProjectPath(agentId)!, '.dork', 'tasks')
            : ''
        );
      });
    }

    // Wire file watcher and reconciler for file-first task sync
    const globalTasksDir = path.join(dorkHome, 'tasks');
    taskFileWatcher = new TaskFileWatcher(taskStore, () => {}, dorkHome);
    taskFileWatcher.watch(globalTasksDir, 'global');

    taskReconciler = new TaskReconciler(taskStore);
    taskReconciler.addDirectory(globalTasksDir, 'global');

    // Watch each registered agent's task directory
    if (meshCore) {
      for (const agent of meshCore.list()) {
        const projectPath = meshCore.getProjectPath(agent.id);
        if (projectPath) {
          const agentTasksDir = path.join(projectPath, '.dork', 'tasks');
          taskFileWatcher.watch(agentTasksDir, 'project', projectPath, agent.id);
          taskReconciler.addDirectory(agentTasksDir, 'project', projectPath, agent.id);
        }
      }
    }

    taskReconciler.start();
    logger.info('[Tasks] File watcher and reconciler started');

    // Ensure default templates exist
    ensureDefaultTemplates(dorkHome).catch((err) => {
      logger.warn('[Tasks] Failed to seed default templates', logError(err));
    });
  }

  // Mount Relay routes if enabled
  if (relayEnabled && relayCore) {
    app.use('/api/relay', createRelayRouter(relayCore, adapterManager, traceStore));
    setRelayEnabled(true);

    // Store relayCore on app.locals so the sessions router can access it
    app.locals.relayCore = relayCore;

    // Wire relay events to unified SSE stream
    relayCore.subscribe('relay.human.console.>', (envelope) => {
      eventFanOut.broadcast('relay_message', envelope);
    });

    relayCore.onSignal('relay.human.console.>', (_subject, signal) => {
      const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
      eventFanOut.broadcast(eventType, signal);
    });

    eventFanOut.broadcast('relay_connected', {
      pattern: 'relay.human.console.>',
      connectedAt: new Date().toISOString(),
    });

    logger.info('[Relay] Routes mounted');
  }

  // Wire global session-list discovery → unified SSE stream (ADR-0265/0266).
  // ALWAYS ON: fans every registered runtime's transition-only session-list
  // stream (session_upserted/session_removed/session_status) onto /api/events
  // with no timer poll (ADR-0310 fan-in). Started here because all runtimes
  // are registered by this point.
  sessionListBroadcaster.start(runtimeRegistry.listRuntimes());
  logger.info('[SessionList] Discovery broadcaster started');

  // Mount Mesh routes if MeshCore initialized successfully (always-on, ADR-0062)
  if (meshCore) {
    app.use('/api/mesh', createMeshRouter(meshCore));
    setMeshEnabled(true);
    logger.info('[Mesh] Routes mounted');
  }

  // Always mounted — not behind any feature flag.
  // ADR-0043: pass meshCore (when available) so writes sync to Mesh DB cache.
  app.use('/api/agents', createAgentsRouter(meshCore));

  // Template catalog — always available, merges built-in + user templates.
  app.use('/api/templates', createTemplateRouter(dorkHome));

  // Activity feed — always available, not behind a feature flag.
  app.use('/api/activity', createActivityRouter(activityService));
  app.locals.activityService = activityService;
  logger.info('[Activity] Routes mounted');

  // Mount Extensions routes if extension system initialized successfully.
  if (extensionManager) {
    app.use(
      '/api/extensions',
      createExtensionsRouter(extensionManager, dorkHome, () => env.DORKOS_DEFAULT_CWD ?? null)
    );

    // Delegate /api/ext/:id/* to extension-registered Express routers
    app.use('/api/ext/:id', createExtensionRoutesMiddleware(extensionManager));

    logger.info('[Extensions] Routes mounted');
  }

  // Mount Discovery routes when MeshCore is available (delegates to meshCore.discover())
  if (meshCore) {
    app.use('/api/discovery', createDiscoveryRouter(meshCore));
    logger.info('[Discovery] Routes mounted');
  }

  // Mount A2A gateway if enabled — requires both Relay (message routing) and Mesh (agent registry)
  if (env.DORKOS_A2A_ENABLED && relayCore && meshCore) {
    const baseUrl = `http://${env.DORKOS_HOST}:${PORT}`;
    const version = env.DORKOS_VERSION_OVERRIDE ?? '0.0.0';
    const { router: a2aRouter, fleetCardHandler } = createA2aRouter({
      meshCore,
      relay: relayCore,
      db,
      baseUrl,
      version,
    });

    // Fleet Agent Card at the well-known path (outside /a2a prefix)
    app.get('/.well-known/agent.json', mcpApiKeyAuth, fleetCardHandler);

    // Per-agent cards and JSON-RPC under /a2a
    app.use('/a2a', mcpApiKeyAuth, a2aRouter);

    const a2aAuthMode = env.MCP_API_KEY ? 'auth: API key' : 'auth: none';
    logger.info(
      `[A2A] Gateway mounted (fleet card: /.well-known/agent.json, RPC: POST /a2a, ${a2aAuthMode})`
    );
  }

  // Mount Admin routes (reset, restart)
  app.use(
    '/api/admin',
    createAdminRouter({
      dorkHome,
      shutdownServices,
      closeDb: () => db.$client.close(),
    })
  );
  logger.info('[Admin] Routes mounted');

  // Mount Marketplace routes. The install pipeline has two optional
  // collaborators — `extensionManager` (needed by plugin + uninstall flows)
  // and `adapterManager` (needed by adapter + uninstall flows). When either
  // is absent the corresponding flows will surface a clear error on call,
  // but source listing, cache, discovery, agent installs, and skill-pack
  // installs remain fully functional, so we always mount the router rather
  // than gating the entire namespace.
  if (extensionManager && adapterManager) {
    const marketplaceSourceManager = new MarketplaceSourceManager(dorkHome);
    const marketplaceCache = new MarketplaceCache(dorkHome);
    const marketplaceFetcher = new PackageFetcher(
      marketplaceCache,
      defaultTemplateDownloader,
      logger
    );
    const marketplaceResolver = new PackageResolver(marketplaceSourceManager, marketplaceCache);
    const marketplaceConflictDetector = new ConflictDetector(dorkHome, adapterManager);
    const marketplacePreviewBuilder = new PermissionPreviewBuilder(
      dorkHome,
      marketplaceConflictDetector
    );

    const marketplacePluginFlow = new PluginInstallFlow({
      dorkHome,
      extensionCompiler: extensionManager.getCompiler(),
      extensionManager,
      logger,
    });
    const marketplaceAgentFlow = new AgentInstallFlow({
      dorkHome,
      agentCreator: { createAgentWorkspace },
      logger,
    });
    const marketplaceSkillPackFlow = new SkillPackInstallFlow({ dorkHome, logger });
    const marketplaceAdapterFlow = new AdapterInstallFlow({
      dorkHome,
      adapterManager,
      logger,
    });
    const marketplaceUninstallFlow = new UninstallFlow({
      dorkHome,
      extensionManager,
      adapterManager,
      logger,
    });

    const marketplaceInstaller = new MarketplaceInstaller({
      dorkHome,
      resolver: marketplaceResolver,
      fetcher: marketplaceFetcher,
      previewBuilder: marketplacePreviewBuilder,
      pluginFlow: marketplacePluginFlow,
      agentFlow: marketplaceAgentFlow,
      skillPackFlow: marketplaceSkillPackFlow,
      adapterFlow: marketplaceAdapterFlow,
      uninstallFlow: marketplaceUninstallFlow,
      logger,
    });

    // UpdateFlow takes an `InstallerLike` — passing the concrete installer
    // is safe because `MarketplaceInstaller implements InstallerLike` and
    // breaks the type cycle between installer and update flow at the type
    // level (see `marketplace-installer.ts`).
    const marketplaceUpdateFlow = new UpdateFlow({
      dorkHome,
      installer: marketplaceInstaller,
      sourceManager: marketplaceSourceManager,
      fetcher: marketplaceFetcher,
      logger,
    });

    // Cross-scope installed listing walks every registered agent's
    // .dork/plugins. Resolved lazily per call so agents registered after
    // startup are included; display name preferred for the UI. Shared by the
    // HTTP router and the `marketplace_list_installed` MCP tool so both report
    // the same one-entry-per-installation truth.
    const listAgentScopes = () =>
      (meshCore?.listWithPaths() ?? []).map((a) => ({
        projectPath: a.projectPath,
        id: a.id,
        name: a.displayName ?? a.name,
      }));

    app.use(
      '/api/marketplace',
      createMarketplaceRouter({
        sourceManager: marketplaceSourceManager,
        cache: marketplaceCache,
        fetcher: marketplaceFetcher,
        installer: marketplaceInstaller,
        uninstallFlow: marketplaceUninstallFlow,
        updateFlow: marketplaceUpdateFlow,
        dorkHome,
        listAgentScopes,
        onPluginsChanged: (ctx) => {
          // Pass the project path (when the change was project-scoped) so the
          // runtime drops that cwd's cached command list and re-warms it with
          // the merged per-cwd plugin set.
          claudeRuntime?.refreshActivatedPlugins(ctx.projectPath).catch((err) => {
            logger.warn('[Marketplace] Post-install plugin refresh failed', { err });
          });
          // Harness Sync auto-projection (GAP-4): project the changed plugin's
          // assets to the project's other harnesses. Fire-and-forget; the
          // service is internally best-effort and never throws, but we still
          // catch here to honor the no-floating-promise convention.
          runAutoProjection(ctx, { dorkHome }).catch((err) => {
            logger.warn('[Marketplace] Harness auto-projection failed', { err });
          });
        },
      })
    );
    logger.info('[Marketplace] Routes mounted');

    // Personal marketplace bootstrap — runs after the source manager is wired
    // but before the MCP server fields its first request so the personal
    // source is registered when external clients call
    // `marketplace_list_marketplaces`. Failure here is non-fatal: a missing
    // personal marketplace just means the `marketplace_create_package` tool
    // has no destination, every other tool keeps working.
    try {
      await ensurePersonalMarketplace({
        dorkHome,
        sourceManager: marketplaceSourceManager,
        logger,
      });
    } catch (err) {
      logger.warn('[personal-marketplace] bootstrap failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Build the confirmation provider that gates marketplace mutation tools.
    // `MARKETPLACE_AUTO_APPROVE=1` selects the auto-approve provider for CI
    // and tests; everything else uses the token provider, which issues
    // out-of-band tokens that the DorkOS UI resolves via the
    // `POST /api/marketplace/confirmations/:token` route.
    const confirmationProvider: ConfirmationProvider =
      env.MARKETPLACE_AUTO_APPROVE === '1'
        ? new AutoApproveConfirmationProvider()
        : new TokenConfirmationProvider();
    setMarketplaceConfirmationProvider(confirmationProvider);

    marketplaceMcpDeps = {
      dorkHome,
      installer: marketplaceInstaller,
      sourceManager: marketplaceSourceManager,
      fetcher: marketplaceFetcher,
      cache: marketplaceCache,
      uninstallFlow: marketplaceUninstallFlow,
      confirmationProvider,
      listAgentScopes,
      logger,
    };
    logger.info('[Marketplace] MCP tools wired into external /mcp server');
  } else {
    logger.warn(
      '[Marketplace] Routes skipped — requires extensionManager and adapterManager (relay must be enabled and extensions must have initialized successfully)'
    );
  }

  // Finalize app: API 404 catch-all, error handler, and SPA serving
  finalizeApp(app);

  // Inject relay into the active runtime (a no-op for both runtimes today;
  // the method survives on the interface for future relay-aware runtimes).
  if (relayCore) {
    runtimeRegistry.getDefault().setRelay?.(relayCore);
  }

  const host = env.DORKOS_HOST;
  const server = app.listen(PORT, host, () => {
    logger.info(`DorkOS server running on http://${host}:${PORT}`);

    // Fire-and-forget: record startup in the activity feed so the dashboard
    // shows when the server was last (re)started.
    activityService.emit({
      actorType: 'system',
      actorLabel: 'System',
      category: 'system',
      eventType: 'system.started',
      summary: 'DorkOS started',
    });
  });

  // Surface port conflicts with an actionable message instead of a raw EADDRINUSE stack trace
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Port ${PORT} is already in use. ` +
          `Run \`lsof -i :${PORT}\` to find the process, or start with \`--port ${PORT + 1}\`.`
      );
      process.exit(1);
    }
    throw err;
  });

  // Start Tasks scheduler after server is listening
  if (schedulerService) {
    await schedulerService.start();
    logger.info('[Tasks] Scheduler started');
  }

  // Run session health check periodically — only ClaudeCodeRuntime needs this.
  if (claudeRuntime) {
    healthCheckInterval = setInterval(() => {
      claudeRuntime!.checkSessionHealth();
    }, INTERVALS.HEALTH_CHECK_MS);
  }

  // Start ngrok tunnel if enabled
  if (env.TUNNEL_ENABLED) {
    const tunnelPort = env.TUNNEL_PORT ?? PORT;

    try {
      const url = await tunnelManager.start({
        port: tunnelPort,
        authtoken: env.NGROK_AUTHTOKEN,
        basicAuth: env.TUNNEL_AUTH,
        domain: env.TUNNEL_DOMAIN,
      });

      const hasAuth = !!env.TUNNEL_AUTH;
      const isDevPort = tunnelPort !== PORT;

      logger.info('[Tunnel] ngrok tunnel active', {
        url,
        port: tunnelPort,
        auth: hasAuth ? 'basic auth enabled' : 'none (open)',
        ...(isDevPort && { mode: `dev (Vite on :${tunnelPort})` }),
      });
    } catch (err) {
      logger.warn(
        '[Tunnel] Failed to start ngrok tunnel — server continues without tunnel.',
        logError(err)
      );
    }
  }

  // Wire tunnel status changes to unified SSE stream
  tunnelManager.on('status_change', (status) => {
    eventFanOut.broadcast('tunnel_status', status);
  });
}

// Ordered teardown of all running services WITHOUT calling process.exit().
// Extracted so the admin router can invoke it before a restart.
async function shutdownServices() {
  logger.info('Shutting down services...');
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  // Close the global session-list subscription (and its directory watcher).
  await sessionListBroadcaster.stop();
  if (schedulerService) {
    await schedulerService.stop();
  }
  // Stop adapters before RelayCore — adapters may need to drain in-flight messages
  if (adapterManager) {
    await adapterManager.shutdown();
  }
  if (relayCore) {
    await relayCore.close();
  }
  // Close trace store after RelayCore — ensures final spans are flushed
  if (traceStore) {
    traceStore.close();
  }
  if (taskFileWatcher) {
    await taskFileWatcher.stopAll();
  }
  if (taskReconciler) {
    taskReconciler.stop();
  }
  if (meshCore) {
    meshCore.stopPeriodicReconciliation();
    meshCore.close();
  }
  // Kill the managed OpenCode sidecar (SIGTERM, then SIGKILL after a grace
  // window) so shutdown never leaves an orphan. No-op when it never booted.
  await openCodeServerManager.shutdown();
  await tunnelManager.stop();
}

// Graceful shutdown — guarded against concurrent signals (SIGINT + SIGTERM)
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');
  await shutdownServices();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Safety nets — log and exit gracefully on truly unhandled errors instead of
// silently crashing. These should never fire if route-level error handling is
// correct, but they prevent data loss if something slips through.
process.on('uncaughtException', (err) => {
  logger.error('[DorkOS] Uncaught exception — shutting down', {
    message: err.message,
    stack: err.stack,
    name: err.name,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('[DorkOS] Unhandled promise rejection', {
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
  });
  // Don't exit — the rejection may be non-fatal (e.g., a cancelled fetch).
  // Node 15+ defaults to --unhandled-rejections=throw which would crash anyway,
  // but logging here ensures we capture context before that happens.
});

start().catch((err) => {
  const info = logError(err);
  logger.error('[DorkOS] Fatal error during startup', info);

  process.exit(1);
});
