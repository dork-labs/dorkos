import { createApp } from './app.js';
import { agentManager } from './services/agent-manager.js';
import { tunnelManager } from './services/tunnel-manager.js';
import { SessionBroadcaster } from './services/session-broadcaster.js';
import { transcriptReader } from './services/transcript-reader.js';
import { initConfigManager } from './services/config-manager.js';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { INTERVALS } from './config/constants.js';

const PORT = parseInt(process.env.DORKOS_PORT || String(DEFAULT_PORT), 10);

// Global reference for graceful shutdown
let sessionBroadcaster: SessionBroadcaster | null = null;

async function start() {
  initConfigManager();
  const app = createApp();

  // Initialize SessionBroadcaster and attach to app.locals
  sessionBroadcaster = new SessionBroadcaster(transcriptReader);
  app.locals.sessionBroadcaster = sessionBroadcaster;

  const host = process.env.TUNNEL_ENABLED === 'true' ? '0.0.0.0' : 'localhost';
  app.listen(PORT, host, () => {
    console.log(`DorkOS server running on http://localhost:${PORT}`);
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

      console.log('');
      console.log(
        '\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510'
      );
      console.log('\u2502  ngrok tunnel active                            \u2502');
      console.log('\u2502                                                 \u2502');
      console.log(`\u2502  URL:  ${url.padEnd(40)} \u2502`);
      console.log(`\u2502  Port: ${String(tunnelPort).padEnd(40)} \u2502`);
      console.log(
        `\u2502  Auth: ${(hasAuth ? 'basic auth enabled' : 'none (open)').padEnd(40)} \u2502`
      );
      if (isDevPort) {
        console.log(`\u2502  Mode: ${('dev (Vite on :' + tunnelPort + ')').padEnd(40)} \u2502`);
      }
      console.log('\u2502                                                 \u2502');
      console.log('\u2502  Free tier: 1GB/month bandwidth, session limits \u2502');
      console.log(
        '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518'
      );
      console.log('');
    } catch (err) {
      console.warn(
        '[Tunnel] Failed to start ngrok tunnel:',
        err instanceof Error ? err.message : err
      );
      console.warn('[Tunnel] Server continues without tunnel.');
    }
  }
}

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
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
