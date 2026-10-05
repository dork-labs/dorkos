import { Router } from 'express';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { keepAwakeService } from '../services/core/keep-awake/index.js';

const router = Router();

/**
 * GET /api/keep-awake — whether DorkOS is keeping this computer awake right now,
 * and for what (spec `keep-awake`).
 *
 * Read-only and content-free: counts, the setting, and why it cannot hold when
 * it cannot. The app reads it once and is kept current by `keep_awake_status`
 * on the global event stream. The setting itself is written through
 * `PATCH /api/config`.
 */
router.get('/', (_req, res) => {
  res.json(keepAwakeService.status() satisfies KeepAwakeStatus);
});

export default router;
