import { Router } from 'express';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

const router = Router();

/**
 * GET /api/system/requirements — checks external dependencies for all registered runtimes.
 *
 * Response shape: `SystemRequirements` (per-runtime dependency results + allSatisfied flag).
 */
router.get('/requirements', async (_req, res) => {
  const runtimes: SystemRequirements['runtimes'] = {};

  for (const runtime of runtimeRegistry.listRuntimes()) {
    const dependencies = await runtime.checkDependencies();
    runtimes[runtime.type] = { dependencies };
  }

  const allSatisfied = Object.values(runtimes).every((r) =>
    r.dependencies.every((d) => d.status === 'satisfied')
  );

  res.json({ runtimes, allSatisfied } satisfies SystemRequirements);
});

export default router;
