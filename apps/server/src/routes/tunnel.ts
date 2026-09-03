/**
 * Tunnel route — endpoints to start/stop/stream ngrok tunnel status.
 *
 * @module routes/tunnel
 */
import { Router } from 'express';
import type { TunnelStatus } from '@dorkos/shared/types';
import { env } from '../env.js';
import { getLocalCockpitPort } from '../lib/trusted-origins.js';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import {
  canExpose,
  AUTH_REQUIRED_FOR_EXPOSURE,
  EXPOSURE_REQUIRES_LOGIN_MESSAGE,
} from '../services/core/auth/exposure-guard.js';
import { resolveTunnelSettings } from '../services/core/config/tunnel-settings.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import {
  OPERATOR_ONLY_CONFIG_CODE,
  OPERATOR_ONLY_CONFIG_ERROR,
} from '../services/core/operator/config-write-policy.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { logger, logError } from '../lib/logger.js';

const router = Router();

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

router.post('/start', async (req, res) => {
  // Opening a tunnel publishes this machine, and `tunnel.enabled` is one of the
  // operator-only settings in `config-write-policy.ts` — which this route then
  // writes directly, bypassing the bars `PATCH /api/config` runs for exactly
  // those paths. So it runs the same two bars here, in the same order and for
  // the same reasons (see `routes/config.ts` → `refuseOperatorOnly`): the cookie
  // bar first, so a caller failing both hears the more useful answer.
  //
  // They go BEFORE the already-running and exposure checks so a caller who may
  // not do this does not learn the tunnel's public URL on the way to being
  // refused.
  //
  // `/stop` runs neither, and that asymmetry is deliberate — see the comment
  // there. Stopping only ever narrows exposure.
  const cookieRefusal = requireOperatorCookieUnderLogin(res, 'Remote Access');
  if (cookieRefusal) {
    return res
      .status(cookieRefusal.status)
      .json({ error: cookieRefusal.error, code: cookieRefusal.code });
  }
  if (!trustedCaller(readCallerAuthority(req, res))) {
    logger.warn('[Tunnel] Blocked start — an agent may not publish this machine');
    return res
      .status(403)
      .json({ error: OPERATOR_ONLY_CONFIG_ERROR, code: OPERATOR_ONLY_CONFIG_CODE });
  }

  // Return 409 if a tunnel is already open. Asked of the manager rather than of
  // `status.connected`, which goes false for as long as ngrok is reconnecting
  // while the listener is still open — reading it turned a momentary
  // disconnect into `start()` throwing 'Tunnel is already running', answered as
  // a 500 (DOR-1738).
  if (tunnelManager.isRunning) {
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

  const tunnelConfig = configManager.get('tunnel');
  // The same resolver the boot-time autostart reads, so the two cannot disagree
  // about what "the tunnel's settings" are (DOR-1738).
  const { config } = resolveTunnelSettings({
    env,
    stored: tunnelConfig,
    fallbackPort: getLocalCockpitPort(),
  });

  if (!config.authtoken) {
    return res.status(400).json({ error: 'No ngrok auth token configured' });
  }

  try {
    await tunnelManager.start(config);

    // Persist enabled state
    configManager.set('tunnel', { ...tunnelConfig, enabled: true });
    logConfigWrite('the tunnel route', 'tunnel', tunnelConfig, configManager.get('tunnel'));

    return res.json({ url: tunnelManager.status.url });
  } catch (err) {
    // Say what went wrong somewhere a person can read it. The 500 body carries
    // one sentence; whoever is debugging raised the log level for the stack, and
    // before DOR-1738 found nothing there at all (GitHub #1458).
    logger.error('[Tunnel] Failed to start', logError(err));
    const message = err instanceof Error ? err.message : 'Failed to start tunnel';
    return res.status(500).json({ error: message });
  }
});

router.post('/stop', async (_req, res) => {
  // DOR-574 revisited: an earlier version of this route gated `/stop` behind
  // `canExpose()`, mirroring `/start`. Adversarial review rejected that —
  // `canExpose()` answers "is login configured for exposure", not "is this
  // caller authorized", so it gates nothing a real attacker cannot already
  // walk past (when it is false, login is off and the whole API is open
  // anyway). Worse, it actively strands a running tunnel: start it while
  // exposable, disable login afterward, and `/stop` would 409 forever — the
  // response tells the operator to CREATE a login in order to turn something
  // OFF, and a default install with a stale `tunnel.enabled: true` from a
  // prior session could never self-heal. Stopping a tunnel only ever narrows
  // exposure, so it must always succeed regardless of the login posture.
  try {
    await tunnelManager.stop();

    // Persist disabled state
    const tunnelConfig = configManager.get('tunnel');
    configManager.set('tunnel', { ...tunnelConfig, enabled: false });
    logConfigWrite('the tunnel route', 'tunnel', tunnelConfig, configManager.get('tunnel'));

    return res.json({ ok: true });
  } catch (err) {
    logger.error('[Tunnel] Failed to stop', logError(err));
    const message = err instanceof Error ? err.message : 'Failed to stop tunnel';
    return res.status(500).json({ error: message });
  }
});

export default router;
