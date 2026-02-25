/**
 * Tunnel route — POST endpoints to start and stop the ngrok tunnel.
 *
 * @module routes/tunnel
 */
import { Router } from 'express';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { configManager } from '../services/core/config-manager.js';

/** Default port for the Vite dev server. */
const DEV_CLIENT_PORT = 3000;

const router = Router();

/**
 * Resolve the port the tunnel should forward to.
 * In dev, Vite serves the UI on DEV_CLIENT_PORT and proxies /api to Express,
 * so the tunnel targets Vite. In production, Express serves everything.
 */
function resolveTunnelPort(): number {
  if (process.env.TUNNEL_PORT) return Number(process.env.TUNNEL_PORT);
  const isDev = process.env.NODE_ENV !== 'production';
  return isDev ? DEV_CLIENT_PORT : Number(process.env.DORKOS_PORT) || DEFAULT_PORT;
}

router.post('/start', async (_req, res) => {
  try {
    // Resolve auth token: env var first, then config fallback
    const authtoken =
      process.env.NGROK_AUTHTOKEN || configManager.get('tunnel')?.authtoken;
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
    const message =
      err instanceof Error ? err.message : 'Failed to start tunnel';
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
    const message =
      err instanceof Error ? err.message : 'Failed to stop tunnel';
    return res.status(500).json({ error: message });
  }
});

export default router;
