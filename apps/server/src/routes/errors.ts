/**
 * `POST /api/errors` — the cockpit crash-report intake (DOR-318, ADR
 * 260713-143958 Phase 6).
 *
 * The client shell relays a caught top-level React error, a `window` `error`, or
 * an `unhandledrejection` here. The body is **never trusted**: only
 * `name`/`message`/`stack` strings are accepted and the report is rebuilt and
 * scrubbed SERVER-SIDE (`captureClientError` → the shared allowlist scrubber), so
 * a hostile or buggy client cannot smuggle absolute paths, home dirs, or tokens
 * into the outbound `$exception` event. The raw message is dropped entirely.
 *
 * Ingest posture mirrors the owned-ingest event stream: **always accept, never
 * make the client retry**. The route returns `202 { ok: true }` for any
 * well-formed request. When error reporting is off (no Tier 2 opt-in, or an env
 * kill switch), `captureClientError` is a silent no-op — the route still accepts
 * and drops (same consent gate as the server/CLI senders).
 *
 * @module routes/errors
 */

import { Router } from 'express';
import { z } from 'zod';

import { captureClientError } from '../services/core/error-reporter.js';

const router = Router();

/**
 * Untrusted client payload. Bounded lengths cap an adversarial body; every field
 * is optional because a crash may carry only some of them. Extra keys are
 * stripped (default Zod behavior) rather than rejected — the route accepts and
 * drops noise instead of erroring.
 */
const ClientErrorBodySchema = z.object({
  name: z.string().max(256).optional(),
  message: z.string().max(4096).optional(),
  stack: z.string().max(20_000).optional(),
});

router.post('/', (req, res) => {
  const parsed = ClientErrorBodySchema.safeParse(req.body ?? {});
  if (parsed.success) {
    // Fire-and-forget: scrubbing + send happen server-side and must never block
    // or fail the request. A no-op when error reporting is off.
    void captureClientError(parsed.data);
  }
  // Always accept — this is a fire-and-forget stream, not a command to retry.
  res.status(202).json({ ok: true });
});

export default router;
