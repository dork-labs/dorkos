import { Router } from 'express';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { deriveRuntimeReadiness } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

const router = Router();

/**
 * GET /api/system/requirements — checks external dependencies for all registered runtimes.
 *
 * Response shape: `SystemRequirements`. Each runtime carries its raw
 * `dependencies[]` (the client's Advanced disclosure consumes them) PLUS the
 * derived two-state Ready/Connect projection (`state` + optional `connect`), so
 * the client can present all runtimes as siblings without re-deriving readiness.
 * Probes are async and time-bounded (per adapter), so a slow or hung probe never
 * blocks this handler.
 */
router.get('/requirements', async (_req, res) => {
  const runtimes: SystemRequirements['runtimes'] = {};

  for (const runtime of runtimeRegistry.listRuntimes()) {
    const dependencies = await runtime.checkDependencies();
    const readiness = deriveRuntimeReadiness(runtime.type, dependencies);
    runtimes[runtime.type] = { dependencies, ...readiness };
  }

  const allSatisfied = Object.values(runtimes).every((r) =>
    r.dependencies.every((d) => d.status === 'satisfied')
  );

  res.json({ runtimes, allSatisfied } satisfies SystemRequirements);
});

export default router;
