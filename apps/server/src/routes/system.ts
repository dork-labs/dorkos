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
 * Probes are async, time-bounded (per adapter), and run concurrently across
 * runtimes, so a slow or hung probe never blocks this handler and never
 * serializes the other runtimes behind it.
 */
router.get('/requirements', async (_req, res) => {
  // Probe every runtime concurrently: each adapter's checkDependencies is async
  // and time-bounded, so worst-case handler latency is ~max(runtime), not the
  // sum, and one slow runtime cannot stall the others.
  const entries = await Promise.all(
    runtimeRegistry.listRuntimes().map(async (runtime) => {
      const dependencies = await runtime.checkDependencies();
      const readiness = deriveRuntimeReadiness(runtime.type, dependencies);
      return [runtime.type, { dependencies, ...readiness }] as const;
    })
  );

  const runtimes: SystemRequirements['runtimes'] = Object.fromEntries(entries);

  const allSatisfied = Object.values(runtimes).every((r) =>
    r.dependencies.every((d) => d.status === 'satisfied')
  );

  res.json({ runtimes, allSatisfied } satisfies SystemRequirements);
});

export default router;
