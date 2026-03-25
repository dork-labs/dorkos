/**
 * Tunnel route — endpoints to start/stop/stream ngrok tunnel status,
 * and passcode authentication for remote access.
 *
 * @module routes/tunnel
 */
import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  DEFAULT_PORT,
  PASSCODE_RATE_LIMIT_WINDOW_MS,
  PASSCODE_RATE_LIMIT_MAX,
} from '@dorkos/shared/constants';
import { PasscodeVerifyRequestSchema } from '@dorkos/shared/schemas';
import type { TunnelStatus } from '@dorkos/shared/types';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { configManager } from '../services/core/config-manager.js';
import { verifyPasscode, hashPasscode } from '../lib/passcode-hash.js';

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

// ---------- Passcode endpoints ----------

const passcodeRateLimiter = rateLimit({
  windowMs: PASSCODE_RATE_LIMIT_WINDOW_MS,
  max: PASSCODE_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'Too many attempts. Try again later.',
    retryAfter: PASSCODE_RATE_LIMIT_WINDOW_MS / 1000,
  },
  keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
});

/** POST /api/tunnel/passcode/verify — Rate-limited passcode verification. */
router.post('/passcode/verify', passcodeRateLimiter, async (req, res) => {
  const parsed = PasscodeVerifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid passcode format' });
  }

  const tunnelConfig = configManager.get('tunnel');
  if (!tunnelConfig?.passcodeHash || !tunnelConfig?.passcodeSalt) {
    return res.status(400).json({ ok: false, error: 'No passcode configured' });
  }

  const valid = await verifyPasscode(
    parsed.data.passcode,
    tunnelConfig.passcodeHash,
    tunnelConfig.passcodeSalt
  );

  if (!valid) {
    return res.status(401).json({ ok: false, error: 'Incorrect passcode' });
  }

  req.session!.tunnelAuthenticated = true;
  return res.json({ ok: true });
});

/** GET /api/tunnel/passcode/session — Check passcode session status. */
router.get('/passcode/session', (_req, res) => {
  const tunnelConfig = configManager.get('tunnel');
  const passcodeRequired = !!(tunnelConfig?.passcodeEnabled && tunnelConfig?.passcodeHash);
  const authenticated = !!_req.session?.tunnelAuthenticated;
  return res.json({ authenticated, passcodeRequired });
});

/** POST /api/tunnel/passcode/set — Set, update, or disable the passcode (localhost only). */
router.post('/passcode/set', async (req, res) => {
  if (req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
    return res.status(403).json({ error: 'Passcode can only be changed locally' });
  }

  const { passcode, enabled } = req.body;

  // Handle disable
  if (enabled === false) {
    const currentConfig = configManager.get('tunnel');
    configManager.set('tunnel', { ...currentConfig, passcodeEnabled: false });
    tunnelManager.refreshStatus();
    return res.json({ ok: true });
  }

  // Validate passcode format
  if (!passcode || !/^\d{6}$/.test(passcode)) {
    return res.status(400).json({ error: 'Passcode must be exactly 6 digits' });
  }

  const { hash, salt } = await hashPasscode(passcode);
  const currentConfig = configManager.get('tunnel');
  configManager.set('tunnel', {
    ...currentConfig,
    passcodeEnabled: true,
    passcodeHash: hash,
    passcodeSalt: salt,
  });

  tunnelManager.refreshStatus();
  return res.json({ ok: true });
});

export default router;
