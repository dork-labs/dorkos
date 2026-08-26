import { Router } from 'express';
import type { PermissionModeDescriptor, SystemRequirements } from '@dorkos/shared/agent-runtime';
import { deriveRuntimeReadiness } from '@dorkos/shared/agent-runtime';
import type { MemoryProviderStatus } from '@dorkos/shared/memory-provider';
import type { UnattendedAutonomyState } from '@dorkos/shared/permission-semantics';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  collectUnattendedAutonomy,
  UNATTENDED_RUNTIME,
  type UnattendedAutonomyDeps,
} from '../services/core/unattended-autonomy/unattended-autonomy.js';
import { memoryProviderStatus } from '../services/memory/registry.js';

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

  res.json({ runtimes } satisfies SystemRequirements);
});

/**
 * GET /api/system/unattended-autonomy — every live binding and scheduled task
 * currently set to run an agent without asking anyone.
 *
 * The single read behind the standing unattended-autonomy banner, and shaped so
 * the banner can afford to be app-wide: two small filters, a couple of map
 * lookups per binding, one cheap synchronous SELECT for the tasks, and a payload
 * of a handful of small objects. The client fetches it once and re-reads it when
 * the server says bindings, tasks, or integrations moved — never per route,
 * which is the constraint that kept this banner unbuilt until it had an
 * aggregate of its own (spec `trust-dial`, "Follow-ups opened by the
 * implementation").
 *
 * Degrades in both directions rather than failing: no relay and no Tasks means
 * no drivers, and a boot where the runtime behind them is unregistered means no
 * declared modes, which means no claim about what any stored mode does.
 */
router.get('/unattended-autonomy', (req, res) => {
  const deps = (req.app.locals.unattendedAutonomyDeps ?? {}) as UnattendedAutonomyDeps;

  const modes: readonly PermissionModeDescriptor[] = runtimeRegistry.has(UNATTENDED_RUNTIME)
    ? runtimeRegistry.get(UNATTENDED_RUNTIME).getCapabilities().permissionModes.values
    : [];

  const state = collectUnattendedAutonomy({
    bindings: deps.bindings?.() ?? [],
    tasks: deps.tasks?.() ?? [],
    modes,
    adapterName: deps.adapterName ?? ((id) => id),
    // Permissive defaults, and only reachable when the subsystem that would
    // answer is not running. For adapters that means there are no bindings to
    // judge; for Mesh it means erring toward saying something rather than
    // letting a subsystem outage silence a standing warning.
    adapterLive: deps.adapterLive ?? (() => true),
    agentLive: deps.agentLive ?? (() => true),
  });

  res.json(state satisfies UnattendedAutonomyState);
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
 * No deps bag: unlike `unattended-autonomy`, `registry.ts` is a self-contained
 * module-level singleton every memory call already goes through directly, so
 * there is nothing to hand over that the module does not already hold.
 */
router.get('/memory', (_req, res) => {
  res.json(memoryProviderStatus() satisfies MemoryProviderStatus);
});

export default router;
