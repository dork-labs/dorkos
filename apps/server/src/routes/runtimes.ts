/**
 * Runtime connect + provisioning routes, mounted at `/api/runtimes`.
 *
 * The forward-looking home for per-runtime connect actions (T1 adds credential
 * + delegated-login endpoints here). Today it hosts opt-in OpenCode provisioning
 * (ADR-0317). All actions here are host-mutating or secret-bearing, so they are
 * loopback-only.
 *
 * @module routes/runtimes
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { provisionOpenCode } from '../services/runtimes/opencode/provision.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Whether a request originated from loopback. Mirrors the tunnel passcode
 * endpoint: a genuine localhost request has `hostname` of `localhost`/`127.0.0.1`
 * (`::1`), while a tunnel request carries the public domain and is rejected.
 */
function isLoopbackRequest(req: Request): boolean {
  return req.hostname === 'localhost' || req.hostname === '127.0.0.1' || req.hostname === '::1';
}

/** Write one SSE frame, no-op once the response has ended. */
function sendEvent(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST /api/runtimes/opencode/provision — opt-in, on-demand OpenCode install.
 *
 * Streams install progress as `progress` SSE frames and a terminal `result`
 * frame carrying the {@link provisionOpenCode} outcome. Loopback-only.
 */
router.post('/opencode/provision', async (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ error: 'Runtime provisioning is only available locally' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const result = await provisionOpenCode((progress) => sendEvent(res, 'progress', progress));
    sendEvent(res, 'result', result);
  } catch (err) {
    // provisionOpenCode returns failures rather than throwing; guard defensively.
    logger.error('[Runtimes] OpenCode provisioning failed unexpectedly', err);
    sendEvent(res, 'result', {
      ok: false,
      error: 'Could not install OpenCode. Please try again.',
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export default router;
