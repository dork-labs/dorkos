/**
 * Health routes.
 *
 * `GET /api/health` is the liveness probe: fast, dependency-free, and depended
 * on by the CLI, the desktop shell, and the tunnel. It must stay that way.
 *
 * `GET /api/health/deep` is the diagnostic sibling — the checks `dorkos doctor`
 * cannot run from outside because they need the running server's own view of
 * rooms, messaging, integrations, and agents. It always answers `200`: a failing
 * check is a fact about the machine, not a failed request.
 *
 * @module routes/health
 */
import { Hono } from 'hono';
import type { DeepHealthResponse } from '@dorkos/shared/health-schemas';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { SERVER_VERSION } from '../lib/version.js';
import {
  runDeepHealthChecks,
  type DeepHealthDeps,
} from '../services/observability/deep-health/index.js';
import type { ApiEnv } from '../http/api-chain.js';

/** What the health routes read from the running server. */
export interface HealthRouteDeps {
  /**
   * The narrow reads behind `/deep`, set once every subsystem they name has
   * had its chance to start. Absent only in tests that build the server bare,
   * where every check correctly reports itself skipped.
   */
  deepHealth?: DeepHealthDeps;
}

/**
 * The `/api/health` routes.
 *
 * @param deps - See {@link HealthRouteDeps}.
 * @returns The routes, for `app.route('/api/health', …)`.
 */
export function createHealthRoutes(deps: HealthRouteDeps = {}): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/', (c) => {
    const response: Record<string, unknown> = {
      status: 'ok',
      version: SERVER_VERSION,
      uptime: process.uptime(),
    };

    const tunnelStatus = tunnelManager.status;
    if (tunnelStatus.enabled) {
      response.tunnel = tunnelStatus;
    }

    return c.json(response);
  });

  router.get('/deep', async (c) => {
    const checks = await runDeepHealthChecks(deps.deepHealth ?? { dorkHome: '' });
    const response: DeepHealthResponse = { checks };
    return c.json(response);
  });

  return router;
}
