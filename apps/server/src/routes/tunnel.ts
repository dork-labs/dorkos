/**
 * Tunnel route — endpoints to start/stop/stream ngrok tunnel status.
 *
 * @module routes/tunnel
 */
import { Router } from 'express';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import type { TunnelStatus } from '@dorkos/shared/types';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { configManager } from '../services/core/config-manager.js';
import {
  canExpose,
  AUTH_REQUIRED_FOR_EXPOSURE,
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
} from '../services/core/auth/exposure-guard.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Resolve the port the tunnel should forward to.
 * In dev, Vite serves the UI on VITE_PORT (default 4241) and proxies /api to Express,
 * so the tunnel targets Vite. In production, Express serves everything.
 */
function resolveTunnelPort(): number {
  if (process.env.TUNNEL_PORT) return Number(process.env.TUNNEL_PORT);
  const isDev = process.env.NODE_ENV !== 'production';
  const devClientPort = Number(process.env.VITE_PORT) || 4241;
  return isDev ? devClientPort : Number(process.env.DORKOS_PORT) || DEFAULT_PORT;
}

/** GET /api/tunnel/status — on-demand status check. */
router.get('/status', (_req, res) => {
  res.json(tunnelManager.status);
});

/** GET /api/tunnel/stream — SSE endpoint for real-time tunnel status events. */
router.get('/stream', (req, res) => {
  logger.warn('[DEPRECATED] GET /api/tunnel/stream — use GET /api/events instead');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send current status immediately on connection
  res.write(`event: tunnel_status\ndata: ${JSON.stringify(tunnelManager.status)}\n\n`);

  const handler = (status: TunnelStatus) => {
    res.write(`event: tunnel_status\ndata: ${JSON.stringify(status)}\n\n`);
  };

  tunnelManager.on('status_change', handler);
  req.on('close', () => tunnelManager.off('status_change', handler));
});

router.post('/start', async (_req, res) => {
  // Return 409 if tunnel is already running
  if (tunnelManager.status.connected) {
    return res.status(409).json({
      error: 'Tunnel is already running',
      url: tunnelManager.status.url,
    });
  }

  // Exposure guard (task 1.3): never open a public tunnel without a real login.
  // Allowed only when login is enabled AND an owner account exists. The
  // AUTH_REQUIRED_FOR_EXPOSURE code routes the client into owner-account creation.
  if (!canExpose()) {
    logger.warn(
      '[Tunnel] Blocked start — exposing DorkOS requires a login (login disabled or no owner account)'
    );
    return res.status(409).json({
      error: EXPOSURE_REQUIRES_LOGIN_MESSAGE,
      code: AUTH_REQUIRED_FOR_EXPOSURE,
    });
  }

  try {
    // Resolve auth token: env var first, then config fallback
    const authtoken = process.env.NGROK_AUTHTOKEN || configManager.get('tunnel')?.authtoken;
    if (!authtoken) {
      return res.status(400).json({ error: 'No ngrok auth token configured' });
    }

    const port = resolveTunnelPort();
    const tunnelConfig = configManager.get('tunnel');
    const config = {
      port,
      authtoken,
      domain: tunnelConfig?.domain ?? undefined,
      basicAuth: tunnelConfig?.auth ?? undefined,
    };

    await tunnelManager.start(config);

    // Persist enabled state
    configManager.set('tunnel', { ...tunnelConfig, enabled: true });

    return res.json({ url: tunnelManager.status.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start tunnel';
    return res.status(500).json({ error: message });
  }
});

router.post('/stop', async (_req, res) => {
  try {
    await tunnelManager.stop();

    // Persist disabled state
    const tunnelConfig = configManager.get('tunnel');
    configManager.set('tunnel', { ...tunnelConfig, enabled: false });

    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop tunnel';
    return res.status(500).json({ error: message });
  }
});

export default router;
