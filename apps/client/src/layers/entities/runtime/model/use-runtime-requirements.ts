/**
 * Runtime readiness — per-runtime dependency checks and setup state.
 *
 * A runtime is *ready* when it is registered with the server AND every one of
 * its `checkDependencies` results is satisfied. Anything less renders as a
 * guided "needs setup" state (spec additional-agent-runtimes, 4.1) — never a
 * dead option or a raw error.
 *
 * @module entities/runtime/model/use-runtime-requirements
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { DependencyCheck, SystemRequirements } from '@dorkos/shared/agent-runtime';
import { useRuntimeCapabilities } from './use-runtime-capabilities';

/**
 * Query key for the system-requirements endpoint. Shared so "Check again"
 * refetches update every consumer (picker, launch popover, setup panel).
 */
const REQUIREMENTS_KEY = ['requirements'] as const;

/**
 * Fetch per-runtime dependency checks for all registered runtimes.
 *
 * Unlike capabilities, requirements CHANGE while the server runs (the user
 * installs a CLI, signs in), so this is refetchable — but never automatically:
 * the server probes shell out synchronously per runtime (binary + version +
 * auth, up to seconds), so focus-refetch from persistently-mounted consumers
 * (status bar, launch popovers) would stutter live SSE streams. Explicit
 * refresh only — the setup panel's "Check again" button calls `refetch()`.
 */
export function useRuntimeRequirements() {
  const transport = useTransport();

  return useQuery({
    queryKey: [...REQUIREMENTS_KEY],
    queryFn: () => transport.checkRequirements(),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Whether a runtime's dependency checks all pass.
 *
 * Optimistic on unknown: while requirements are loading — or when the runtime
 * has no entry in the map — this returns `true`, so the picker never flashes a
 * needs-setup state it cannot substantiate. Registration is a separate
 * question (see {@link useRuntimeReadiness}).
 *
 * @param requirements - The aggregated requirements result, or `undefined` while loading.
 * @param type - Runtime type identifier, e.g. `'codex'`.
 */
export function isRuntimeReady(
  requirements: SystemRequirements | undefined,
  type: string
): boolean {
  const entry = requirements?.runtimes[type];
  if (!entry) return true;
  return entry.dependencies.every((d) => d.status === 'satisfied');
}

/**
 * The failing dependency checks for a runtime (missing or outdated).
 *
 * Returns `[]` while requirements are unknown, mirroring the optimistic
 * stance of {@link isRuntimeReady}.
 *
 * @param requirements - The aggregated requirements result, or `undefined` while loading.
 * @param type - Runtime type identifier, e.g. `'opencode'`.
 */
export function selectUnsatisfiedDeps(
  requirements: SystemRequirements | undefined,
  type: string
): DependencyCheck[] {
  return requirements?.runtimes[type]?.dependencies.filter((d) => d.status !== 'satisfied') ?? [];
}

/** Readiness summary for one runtime type. */
export interface RuntimeReadiness {
  /**
   * False only once the capability map has loaded AND the runtime is absent
   * from it (not registered with this server). Optimistically true while
   * loading.
   */
  registered: boolean;
  /** Registered with every dependency check satisfied (optimistic while loading). */
  ready: boolean;
  /** Failing dependency checks for this runtime (`[]` while loading). */
  unsatisfiedDeps: DependencyCheck[];
}

/**
 * Resolve one runtime's readiness: registered + dependency checks satisfied.
 *
 * Use where a SINGLE runtime's launchability gates an affordance (e.g. the
 * agent launch popover). For per-type checks over a list, call
 * {@link useRuntimeRequirements} once and apply {@link isRuntimeReady}.
 *
 * @param type - Runtime type to check, or `undefined` for "no opinion" (ready).
 */
export function useRuntimeReadiness(type: string | undefined): RuntimeReadiness {
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: requirements } = useRuntimeRequirements();

  return useMemo(() => {
    if (!type) return { registered: true, ready: true, unsatisfiedDeps: [] };
    const registered = capabilityMap ? type in capabilityMap.capabilities : true;
    return {
      registered,
      ready: registered && isRuntimeReady(requirements, type),
      unsatisfiedDeps: selectUnsatisfiedDeps(requirements, type),
    };
  }, [type, capabilityMap, requirements]);
}
