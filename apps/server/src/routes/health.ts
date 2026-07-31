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
import { Router } from 'express';
import type { DeepHealthResponse } from '@dorkos/shared/health-schemas';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { SERVER_VERSION } from '../lib/version.js';
import {
  runDeepHealthChecks,
  type DeepHealthDeps,
} from '../services/observability/deep-health/index.js';

const router = Router();

router.get('/', (_req, res) => {
  const response: Record<string, unknown> = {
    status: 'ok',
    version: SERVER_VERSION,
    uptime: process.uptime(),
  };

  const tunnelStatus = tunnelManager.status;
  if (tunnelStatus.enabled) {
    response.tunnel = tunnelStatus;
  }

  res.json(response);
});

router.get('/deep', async (req, res) => {
  // Set once during bootstrap in index.ts, after every subsystem it names has
  // had its chance to start. Absent only in unit tests that build the app bare,
  // where every check correctly reports itself skipped.
  const deps = req.app.locals.deepHealthDeps as DeepHealthDeps | undefined;
  const checks = await runDeepHealthChecks(deps ?? { dorkHome: '' });
  const response: DeepHealthResponse = { checks };
  res.json(response);
});

export default router;
