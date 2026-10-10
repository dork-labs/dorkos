import { Hono } from 'hono';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { keepAwakeService } from '../services/core/keep-awake/index.js';

const router = new Hono<ApiEnv>();

/**
 * GET /api/keep-awake — whether DorkOS is keeping this computer awake right now,
 * and for what (spec `keep-awake`).
 *
 * Read-only and content-free: counts, the setting, and why it cannot hold when
 * it cannot. The app reads it once and is kept current by `keep_awake_status`
 * on the global event stream. The setting itself is written through
 * `PATCH /api/config`.
 */
router.get('/', (c) => c.json(keepAwakeService.status() satisfies KeepAwakeStatus));

export default router;
