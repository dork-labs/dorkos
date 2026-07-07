/**
 * Cloud-link route — local HTTP API the client Settings panel uses to link this
 * instance to a DorkOS account, read the link state, and unlink
 * (accounts-and-auth P2, task 2.4).
 *
 * Thin over {@link cloudLinkManager}: each handler validates nothing beyond the
 * empty bodies these endpoints take, delegates to the manager, and shapes the
 * response. These routes ride the app-wide session gate like any other `/api/*`
 * route and are INDEPENDENT of `config.auth.enabled`.
 *
 * @module routes/cloud
 */
import { Router } from 'express';
import { cloudLinkManager } from '../services/core/auth/cloud-link.js';
import { logger, logError } from '../lib/logger.js';

const router = Router();

/** POST /api/cloud/link/start — begin the device flow; returns codes to display. */
router.post('/link/start', async (_req, res) => {
  try {
    const result = await cloudLinkManager.startLink();
    return res.json(result);
  } catch (err) {
    logger.error('[Cloud] Failed to start device link', logError(err));
    return res
      .status(502)
      .json({ error: 'Could not reach the DorkOS cloud to start linking. Try again shortly.' });
  }
});

/** GET /api/cloud/link/status — the live link-flow state machine. */
router.get('/link/status', (_req, res) => {
  res.json(cloudLinkManager.getStatus());
});

/** POST /api/cloud/unlink — best-effort server-side revoke, then clear local state. */
router.post('/unlink', async (_req, res) => {
  try {
    await cloudLinkManager.unlink();
    return res.json({ ok: true });
  } catch (err) {
    logger.error('[Cloud] Unlink failed', logError(err));
    return res.status(500).json({ error: 'Failed to unlink this instance' });
  }
});

/** GET /api/cloud/status — settled linked/unlinked summary for Settings. */
router.get('/status', (_req, res) => {
  res.json(cloudLinkManager.getSummary());
});

export default router;
