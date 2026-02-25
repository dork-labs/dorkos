import os from 'os';
import path from 'path';
import { createApp } from './app.js';
import { agentManager } from './services/core/agent-manager.js';
import { tunnelManager } from './services/core/tunnel-manager.js';
import { SessionBroadcaster } from './services/session/session-broadcaster.js';
import { transcriptReader } from './services/session/transcript-reader.js';
import { initConfigManager, configManager } from './services/core/config-manager.js';
import { initBoundary } from './lib/boundary.js';
import { initLogger, logger } from './lib/logger.js';
import { createDorkOsToolServer } from './services/core/mcp-tool-server.js';
import { PulseStore } from './services/pulse/pulse-store.js';
import { SchedulerService } from './services/pulse/scheduler-service.js';
import { createPulseRouter } from './routes/pulse.js';
import { setPulseEnabled } from './services/pulse/pulse-state.js';
import { RelayCore, AdapterRegistry } from '@dorkos/relay';
import { createRelayRouter } from './routes/relay.js';
import { setRelayEnabled } from './services/relay/relay-state.js';
import { AdapterManager } from './services/relay/adapter-manager.js';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { INTERVALS } from './config/constants.js';

const PORT = parseInt(process.env.DORKOS_PORT || String(DEFAULT_PORT), 10);

// Global references for graceful shutdown
let sessionBroadcaster: SessionBroadcaster | null = null;
let schedulerService: SchedulerService | null = null;
let relayCore: RelayCore | undefined;
let adapterManager: AdapterManager | undefined;

async function start() {
  const logLevel = process.env.DORKOS_LOG_LEVEL
    ? parseInt(process.env.DORKOS_LOG_LEVEL, 10)
    : undefined;
  initLogger({ level: logLevel });
  initConfigManager();

  // Initialize directory boundary (must happen before app creation)
  const boundaryConfig = process.env.DORKOS_BOUNDARY || undefined;
  const resolvedBoundary = await initBoundary(boundaryConfig);
  logger.info(`[Boundary] Directory boundary: ${resolvedBoundary}`);

  // Initialize Pulse scheduler if enabled
  const schedulerConfig = configManager.get('scheduler') as {
    enabled: boolean;
    maxConcurrentRuns: number;
    timezone: string | null;
    retentionCount: number;
  };
  const pulseEnabled = process.env.DORKOS_PULSE_ENABLED === 'true' || schedulerConfig.enabled;

  let pulseStore: PulseStore | undefined;
  if (pulseEnabled) {
    const dorkHome = process.env.DORK_HOME || path.join(os.homedir(), '.dork');
    pulseStore = new PulseStore(dorkHome);
    logger.info('[Pulse] PulseStore initialized');
  }

  // Initialize Relay if enabled
  const relayConfig = configManager.get('relay') as { enabled: boolean; dataDir?: string | null };
  const relayEnabled = process.env.DORKOS_RELAY_ENABLED === 'true' || relayConfig?.enabled;

  if (relayEnabled) {
    const dorkHome = process.env.DORK_HOME || path.join(os.homedir(), '.dork');
    const dataDir = relayConfig?.dataDir ?? path.join(dorkHome, 'relay');
    const adapterRegistry = new AdapterRegistry();
    relayCore = new RelayCore({ dataDir, adapterRegistry });
    await relayCore.registerEndpoint('relay.system.console');
    logger.info('[Relay] RelayCore initialized');

    // Initialize adapter lifecycle manager
    const adapterConfigPath = path.join(dorkHome, 'relay', 'adapters.json');
    adapterManager = new AdapterManager(adapterRegistry, adapterConfigPath);
    await adapterManager.initialize();
    logger.info('[Relay] AdapterManager initialized');
  }

  // Create MCP tool server and inject into AgentManager
  const mcpToolServer = createDorkOsToolServer({
    transcriptReader,
    defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? process.cwd(),
    ...(pulseStore && { pulseStore }),
    ...(relayCore && { relayCore }),
    ...(adapterManager && { adapterManager }),
  });
  agentManager.setMcpServers({ dorkos: mcpToolServer });

  const app = createApp();

  // Mount Pulse routes if enabled
  if (pulseEnabled && pulseStore) {
    schedulerService = new SchedulerService(pulseStore, agentManager, {
      maxConcurrentRuns: schedulerConfig.maxConcurrentRuns,
      retentionCount: schedulerConfig.retentionCount,
      timezone: schedulerConfig.timezone,
    });
    app.use('/api/pulse', createPulseRouter(pulseStore, schedulerService));
    setPulseEnabled(true);
    logger.info('[Pulse] Routes mounted and scheduler configured');
  }

  // Mount Relay routes if enabled
  if (relayEnabled && relayCore) {
    app.use('/api/relay', createRelayRouter(relayCore, adapterManager));
    setRelayEnabled(true);
    logger.info('[Relay] Routes mounted');
  }

  // Initialize SessionBroadcaster and attach to app.locals
  sessionBroadcaster = new SessionBroadcaster(transcriptReader);
  app.locals.sessionBroadcaster = sessionBroadcaster;

  const host = process.env.TUNNEL_ENABLED === 'true' ? '0.0.0.0' : 'localhost';
  app.listen(PORT, host, () => {
    logger.info(`DorkOS server running on http://localhost:${PORT}`);
  });

  // Start Pulse scheduler after server is listening
  if (schedulerService) {
    await schedulerService.start();
    logger.info('[Pulse] Scheduler started');
  }

  // Run session health check periodically
  setInterval(
    () => {
      agentManager.checkSessionHealth();
    },
    INTERVALS.HEALTH_CHECK_MS
  );

  // Start ngrok tunnel if enabled
  if (process.env.TUNNEL_ENABLED === 'true') {
    const tunnelPort = parseInt(process.env.TUNNEL_PORT || String(PORT), 10);

    try {
      const url = await tunnelManager.start({
        port: tunnelPort,
        authtoken: process.env.NGROK_AUTHTOKEN,
        basicAuth: process.env.TUNNEL_AUTH,
        domain: process.env.TUNNEL_DOMAIN,
      });

      const hasAuth = !!process.env.TUNNEL_AUTH;
      const isDevPort = tunnelPort !== PORT;

      logger.info('[Tunnel] ngrok tunnel active', {
        url,
        port: tunnelPort,
        auth: hasAuth ? 'basic auth enabled' : 'none (open)',
        ...(isDevPort && { mode: `dev (Vite on :${tunnelPort})` }),
      });
    } catch (err) {
      logger.warn('[Tunnel] Failed to start ngrok tunnel — server continues without tunnel.', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
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
  await tunnelManager.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
