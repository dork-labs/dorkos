import path from 'path';
import { createApp, finalizeApp } from './app.js';
import { ClaudeCodeRuntime } from './services/runtimes/claude-code/claude-code-runtime.js';
import { runtimeRegistry } from './services/core/runtime-registry.js';
import { tunnelManager } from './services/core/tunnel-manager.js';
import { initConfigManager, configManager } from './services/core/config-manager.js';
import { initBoundary } from './lib/boundary.js';
import { initLogger, logger, logError } from './lib/logger.js';
import { createDorkOsToolServer } from './services/runtimes/claude-code/mcp-tools/index.js';
import { PulseStore } from './services/pulse/pulse-store.js';
import { SchedulerService } from './services/pulse/scheduler-service.js';
import { createPulseRouter } from './routes/pulse.js';
import { setPulseEnabled, setPulseInitError } from './services/pulse/pulse-state.js';
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
import { createA2aRouter } from './routes/a2a.js';
import { createAgentsRouter } from './routes/agents.js';
import { createDiscoveryRouter } from './routes/discovery.js';
import { createTemplateRouter } from './routes/templates.js';
import { createAdminRouter } from './routes/admin.js';
import { ExtensionManager } from './services/extensions/extension-manager.js';
import { createExtensionsRouter } from './routes/extensions.js';
import { createExternalMcpServer } from './services/core/mcp-server.js';
import { createMcpRouter } from './routes/mcp.js';
import { mcpApiKeyAuth } from './middleware/mcp-auth.js';
import { validateMcpOrigin } from './middleware/mcp-origin.js';
import { createDb, runMigrations } from '@dorkos/db';
import { INTERVALS } from './config/constants.js';
import { resolveDorkHome } from './lib/dork-home.js';
import { env } from './env.js';

const PORT = env.DORKOS_PORT;

// Global references for graceful shutdown
let claudeRuntime: ClaudeCodeRuntime | null = null;
let schedulerService: SchedulerService | null = null;
let relayCore: RelayCore | undefined;
let adapterRegistry: AdapterRegistry | undefined;
let adapterManager: AdapterManager | undefined;
let traceStore: TraceStore | undefined;
let meshCore: MeshCore | undefined;
let extensionManager: ExtensionManager | undefined;
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

  // Initialize directory boundary (must happen before app creation)
  const boundaryConfig = env.DORKOS_BOUNDARY;
  const resolvedBoundary = await initBoundary(boundaryConfig);
  logger.info(`[Boundary] Directory boundary: ${resolvedBoundary}`);

  // Initialize Extension System
  try {
    extensionManager = new ExtensionManager(dorkHome);
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
    runtimeRegistry.setDefault('test-mode');
    logger.info('[TestMode] TestModeRuntime registered — no real Claude API calls will be made');
  } else {
    claudeRuntime = new ClaudeCodeRuntime(env.DORKOS_DEFAULT_CWD);
    runtimeRegistry.register(claudeRuntime);
    logger.info('[Runtime] ClaudeCodeRuntime registered as default');
  }

  // Initialize Pulse scheduler if enabled
  const schedulerConfig = configManager.get('scheduler');

  const pulseEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_PULSE_ENABLED' in process.env ? env.DORKOS_PULSE_ENABLED : schedulerConfig.enabled;

  let pulseStore: PulseStore | undefined;
  if (pulseEnabled) {
    try {
      pulseStore = new PulseStore(db);
      logger.info('[Pulse] PulseStore initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Pulse] Failed to initialize PulseStore at ${dorkHome}`, errInfo);
      setPulseInitError(errInfo.error);
      // Pulse failure is non-fatal: server continues without scheduler routes.
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
        pulseStore,
        relayCore,
        meshCore, // meshCore is now available
        eventRecorder: traceStore,
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

  // Register MCP tool server factory — only available with ClaudeCodeRuntime.
  // In test mode claudeRuntime is null so the MCP server and /mcp route are skipped.
  if (claudeRuntime) {
    const mcpToolDeps = {
      transcriptReader: claudeRuntime.getTranscriptReader(),
      defaultCwd: env.DORKOS_DEFAULT_CWD ?? process.cwd(),
      ...(pulseStore && { pulseStore }),
      ...(relayCore && { relayCore }),
      ...(adapterManager && { adapterManager }),
      ...(adapterManager && { bindingStore: adapterManager.getBindingStore() }),
      ...(adapterManager && { bindingRouter: adapterManager.getBindingRouter() }),
      ...(traceStore && { traceStore }),
      ...(meshCore && { meshCore }),
    };
    claudeRuntime.setMcpServerFactory((session) => ({
      dorkos: createDorkOsToolServer(mcpToolDeps, session),
    }));

    const mcpAuthMode = env.MCP_API_KEY ? 'auth: API key' : 'auth: none';
    // Mount external MCP server at /mcp (protocol endpoint, not REST API)
    // Stateless mode: each POST creates a fresh McpServer + transport (per SDK docs).
    app.use(
      '/mcp',
      validateMcpOrigin,
      mcpApiKeyAuth,
      createMcpRouter(() => createExternalMcpServer(mcpToolDeps))
    );
    logger.info(`[MCP] External MCP server mounted at /mcp (stateless, ${mcpAuthMode})`);
  }

  // Mount Pulse routes if enabled — Pulse requires ClaudeCodeRuntime as SchedulerAgentManager.
  if (pulseEnabled && pulseStore && claudeRuntime) {
    schedulerService = new SchedulerService(
      pulseStore,
      claudeRuntime,
      {
        maxConcurrentRuns: schedulerConfig.maxConcurrentRuns,
        retentionCount: schedulerConfig.retentionCount,
        timezone: schedulerConfig.timezone,
      },
      relayCore,
      meshCore
    );
    app.use('/api/pulse', createPulseRouter(pulseStore, schedulerService, dorkHome, meshCore));
    setPulseEnabled(true);
    logger.info('[Pulse] Routes mounted and scheduler configured');

    // Cascade-disable: when an agent is unregistered from Mesh, disable its linked Pulse schedules
    if (meshCore) {
      meshCore.onUnregister((agentId) => {
        const disabledCount = pulseStore.disableSchedulesByAgentId(agentId);
        if (disabledCount > 0) {
          logger.info(
            `[Pulse] Disabled ${disabledCount} schedule(s) for unregistered agent ${agentId}`
          );
        }
      });
    }
  }

  // Mount Relay routes if enabled
  if (relayEnabled && relayCore) {
    app.use('/api/relay', createRelayRouter(relayCore, adapterManager, traceStore));
    setRelayEnabled(true);

    // Store relayCore on app.locals so the sessions router can access it
    app.locals.relayCore = relayCore;

    logger.info('[Relay] Routes mounted');
  }

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

  // Mount Extensions routes if extension system initialized successfully.
  if (extensionManager) {
    app.use(
      '/api/extensions',
      createExtensionsRouter(extensionManager, dorkHome, () => env.DORKOS_DEFAULT_CWD ?? null)
    );
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

  // Finalize app: API 404 catch-all, error handler, and SPA serving
  finalizeApp(app);

  // Inject relay into the active runtime.
  // ClaudeCodeRuntime: no-op (broadcaster no longer needs relay).
  // TestModeRuntime: setRelay() enables relay subscription in watchSession().
  if (relayCore) {
    runtimeRegistry.getDefault().setRelay?.(relayCore);
  }

  const host = env.DORKOS_HOST;
  app.listen(PORT, host, () => {
    logger.info(`DorkOS server running on http://${host}:${PORT}`);
  });

  // Start Pulse scheduler after server is listening
  if (schedulerService) {
    await schedulerService.start();
    logger.info('[Pulse] Scheduler started');
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
}

// Ordered teardown of all running services WITHOUT calling process.exit().
// Extracted so the admin router can invoke it before a restart.
async function shutdownServices() {
  logger.info('Shutting down services...');
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  // SessionBroadcaster is owned by the runtime
  if (claudeRuntime) {
    claudeRuntime.getSessionBroadcaster().shutdown();
  }
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
  if (meshCore) {
    meshCore.stopPeriodicReconciliation();
    meshCore.close();
  }
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

start().catch((err) => {
  const info = logError(err);
  logger.error('[DorkOS] Fatal error during startup', info);

  process.exit(1);
});
