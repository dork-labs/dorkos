import { createApp } from './app.js';
import { agentManager } from './services/agent-manager.js';
import { tunnelManager } from './services/tunnel-manager.js';
import { SessionBroadcaster } from './services/session-broadcaster.js';
import { transcriptReader } from './services/transcript-reader.js';
import { initConfigManager } from './services/config-manager.js';
import { initBoundary } from './lib/boundary.js';
import { initLogger, logger } from './lib/logger.js';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { INTERVALS } from './config/constants.js';

const PORT = parseInt(process.env.DORKOS_PORT || String(DEFAULT_PORT), 10);

// Global reference for graceful shutdown
let sessionBroadcaster: SessionBroadcaster | null = null;

async function start() {
  initLogger();
  initConfigManager();

  // Initialize directory boundary (must happen before app creation)
  const boundaryConfig = process.env.DORKOS_BOUNDARY || undefined;
  const resolvedBoundary = await initBoundary(boundaryConfig);
  logger.info(`[Boundary] Directory boundary: ${resolvedBoundary}`);

  const app = createApp();

  // Initialize SessionBroadcaster and attach to app.locals
  sessionBroadcaster = new SessionBroadcaster(transcriptReader);
  app.locals.sessionBroadcaster = sessionBroadcaster;

  const host = process.env.TUNNEL_ENABLED === 'true' ? '0.0.0.0' : 'localhost';
  app.listen(PORT, host, () => {
    logger.info(`DorkOS server running on http://localhost:${PORT}`);
  });

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
function shutdown() {
  logger.info('Shutting down...');
  if (sessionBroadcaster) {
    sessionBroadcaster.shutdown();
  }
  tunnelManager.stop().finally(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
