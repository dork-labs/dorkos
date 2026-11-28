import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { mountLoadGateRoutes } from './system-load-gate.js';
import { mountShellCheckRoutes } from './system-shell-check.js';

/**
 * The `/api/system` routes.
 *
 * @returns The routes, for `app.route('/api/system', …)`.
 */
export function createSystemRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // The requirements, memory and shell-check reads are capabilities the mount
  // serves (`services/core/runtime-doors/computer-read-capabilities.ts`, DOR-4978).
  mountShellCheckRoutes(router);
  mountLoadGateRoutes(router);

  return router;
}
