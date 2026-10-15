import { Hono } from 'hono';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { deriveRuntimeReadiness } from '@dorkos/shared/agent-runtime';
import type { MemoryProviderStatus } from '@dorkos/shared/memory-provider';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { memoryProviderStatus } from '../services/memory/registry.js';
import type { ApiEnv } from '../http/api-chain.js';

/**
 * The `/api/system` routes.
 *
 * @returns The routes, for `app.route('/api/system', …)`.
 */
export function createSystemRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

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
  router.get('/requirements', async (c) => {
    // Probe every runtime concurrently: each adapter's checkDependencies is async
    // and time-bounded, so worst-case handler latency is ~max(runtime), not the
    // sum, and one slow runtime cannot stall the others.
    const entries = await Promise.all(
      runtimeRegistry.listRuntimes().map(async (runtime) => {
        const dependencies = await runtime.checkDependencies();
        const readiness = deriveRuntimeReadiness(runtime.type, dependencies);
        // Provider-agnostic runtimes (OpenCode) report their connected source so
        // the client can label a "Change power source" affordance; others omit it.
        const provider = runtime.getConnectedProvider?.() ?? undefined;
        return [
          runtime.type,
          { dependencies, ...readiness, ...(provider ? { provider } : {}) },
        ] as const;
      })
    );

    const runtimes: SystemRequirements['runtimes'] = Object.fromEntries(entries);

    return c.json({ runtimes } satisfies SystemRequirements);
  });

  /**
   * GET /api/system/memory — which memory backend is configured, which one is
   * actually serving agent calls right now, and why they differ.
   *
   * The operator-visible half of the registry's quarantine-and-fallback design
   * (`services/memory/registry.ts`): a backend that throws is benched for the
   * rest of the process and `builtin` takes over silently from the agent's point
   * of view, which is correct — a turn must never die over a notes file — but
   * reads as amnesia to a person watching unless something says so. This is that
   * something, and the standing client banner is its consumer.
   *
   * No deps bag: `registry.ts` is a self-contained module-level singleton every
   * memory call already goes through directly, so there is nothing to hand over
   * that the module does not already hold.
   */
  router.get('/memory', (c) => c.json(memoryProviderStatus() satisfies MemoryProviderStatus));

  return router;
}
