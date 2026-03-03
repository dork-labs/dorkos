import path from 'path';
import { createApp, finalizeApp } from './app.js';
import { agentManager } from './services/core/agent-manager.js';
import { tunnelManager } from './services/core/tunnel-manager.js';
import { SessionBroadcaster } from './services/session/session-broadcaster.js';
import { transcriptReader } from './services/session/transcript-reader.js';
import { initConfigManager, configManager } from './services/core/config-manager.js';
import { initBoundary } from './lib/boundary.js';
import { initLogger, logger, logError } from './lib/logger.js';
import { createDorkOsToolServer } from './services/core/mcp-tools/index.js';
import { PulseStore } from './services/pulse/pulse-store.js';
import { SchedulerService } from './services/pulse/scheduler-service.js';
import { createPulseRouter } from './routes/pulse.js';
import { setPulseEnabled, setPulseInitError } from './services/pulse/pulse-state.js';
import { RelayCore, AdapterRegistry, SignalEmitter } from '@dorkos/relay';
import { createRelayRouter } from './routes/relay.js';
import { setRelayEnabled, setRelayInitError } from './services/relay/relay-state.js';
import { AdapterManager } from './services/relay/adapter-manager.js';
import { TraceStore } from './services/relay/trace-store.js';
import { MeshCore } from '@dorkos/mesh';
import { createMeshRouter } from './routes/mesh.js';
import { setMeshEnabled, setMeshInitError } from './services/mesh/mesh-state.js';
import { createAgentsRouter } from './routes/agents.js';
import { createDiscoveryRouter } from './routes/discovery.js';
import { createAdminRouter } from './routes/admin.js';
import { createDb, runMigrations } from '@dorkos/db';
import { INTERVALS } from './config/constants.js';
import { resolveDorkHome } from './lib/dork-home.js';
import { env } from './env.js';

const PORT = env.DORKOS_PORT;

// Global references for graceful shutdown
let sessionBroadcaster: SessionBroadcaster | null = null;
let schedulerService: SchedulerService | null = null;
let relayCore: RelayCore | undefined;
let adapterManager: AdapterManager | undefined;
let traceStore: TraceStore | undefined;
let meshCore: MeshCore | undefined;
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

  // Initialize Pulse scheduler if enabled
  const schedulerConfig = configManager.get('scheduler');
  const pulseEnabled = env.DORKOS_PULSE_ENABLED || schedulerConfig.enabled;

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
  const relayEnabled = env.DORKOS_RELAY_ENABLED || relayConfig?.enabled;

  if (relayEnabled) {
    const relayDataDir = relayConfig?.dataDir ?? path.join(dorkHome, 'relay');
    try {
      const adapterRegistry = new AdapterRegistry();
      adapterRegistry.setLogger(logger);

      // Initialize trace store before RelayCore so it can be injected for delivery tracking
      traceStore = new TraceStore(db);
      logger.info('[Relay] TraceStore initialized');

      relayCore = new RelayCore({ dataDir: relayDataDir, adapterRegistry, db, traceStore });
      await relayCore.registerEndpoint('relay.system.console');
      logger.info(`[Relay] RelayCore initialized (dataDir: ${relayDataDir})`);

      // Initialize adapter lifecycle manager (includes ClaudeCodeAdapter for agent dispatch)
      const adapterConfigPath = path.join(dorkHome, 'relay', 'adapters.json');
      adapterManager = new AdapterManager(adapterRegistry, adapterConfigPath, {
        agentManager,
        traceStore,
        pulseStore,
        relayCore,
      });
      await adapterManager.initialize();
      relayCore.setAdapterContextBuilder(adapterManager.buildContext.bind(adapterManager));
      logger.info('[Relay] AdapterManager initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Relay] Failed to initialize at ${relayDataDir}`, errInfo);
      setRelayInitError(errInfo.error);
      // Relay failure is non-fatal: server continues without relay routes.
      relayCore = undefined;
      traceStore = undefined;
      adapterManager = undefined;
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

  // Subscribe to lifecycle signals for diagnostic logging
  if (meshSignalEmitter && meshCore) {
    meshSignalEmitter.subscribe('mesh.agent.lifecycle.>', (subject, signal) => {
      logger.info(`[mesh] lifecycle: ${signal.state}`, { subject, data: signal.data });
    });
  }

  // Register MCP tool server factory — creates fresh instances per query() call
  // to avoid "Already connected to a transport" errors from reused Protocol objects.
  const mcpToolDeps = {
    transcriptReader,
    defaultCwd: env.DORKOS_DEFAULT_CWD ?? process.cwd(),
    ...(pulseStore && { pulseStore }),
    ...(relayCore && { relayCore }),
    ...(adapterManager && { adapterManager }),
    ...(adapterManager && { bindingStore: adapterManager.getBindingStore() }),
    ...(traceStore && { traceStore }),
    ...(meshCore && { meshCore }),
  };
  agentManager.setMcpServerFactory(() => ({ dorkos: createDorkOsToolServer(mcpToolDeps) }));

  const app = createApp();

  // Mount Pulse routes if enabled
  if (pulseEnabled && pulseStore) {
    schedulerService = new SchedulerService(pulseStore, agentManager, {
      maxConcurrentRuns: schedulerConfig.maxConcurrentRuns,
      retentionCount: schedulerConfig.retentionCount,
      timezone: schedulerConfig.timezone,
    }, relayCore);
    app.use('/api/pulse', createPulseRouter(pulseStore, schedulerService));
    setPulseEnabled(true);
    logger.info('[Pulse] Routes mounted and scheduler configured');
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

  // Mount Discovery routes (always available, no feature flag)
  app.use('/api/discovery', createDiscoveryRouter());
  logger.info('[Discovery] Routes mounted');

  // Mount Admin routes (reset, restart)
  app.use('/api/admin', createAdminRouter({
    dorkHome,
    shutdownServices,
    closeDb: () => db.$client.close(),
  }));
  logger.info('[Admin] Routes mounted');

  // Finalize app: API 404 catch-all, error handler, and SPA serving
  finalizeApp(app);

  // Initialize SessionBroadcaster and attach to app.locals
  sessionBroadcaster = new SessionBroadcaster(transcriptReader);
  if (relayCore) {
    sessionBroadcaster.setRelay(relayCore);
  }
  app.locals.sessionBroadcaster = sessionBroadcaster;

  const host = env.DORKOS_HOST;
  app.listen(PORT, host, () => {
    logger.info(`DorkOS server running on http://${host}:${PORT}`);
  });

  // Start Pulse scheduler after server is listening
  if (schedulerService) {
    await schedulerService.start();
    logger.info('[Pulse] Scheduler started');
  }

  // Run session health check periodically
  healthCheckInterval = setInterval(
    () => {
      agentManager.checkSessionHealth();
    },
    INTERVALS.HEALTH_CHECK_MS
  );

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
      logger.warn('[Tunnel] Failed to start ngrok tunnel — server continues without tunnel.', logError(err));
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
  if (sessionBroadcaster) {
    sessionBroadcaster.shutdown();
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

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  await shutdownServices();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
