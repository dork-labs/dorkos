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
import type {
  DependencyCheck,
  SystemRequirements,
  RuntimeReadiness as RuntimeConnectState,
} from '@dorkos/shared/agent-runtime';
import { deriveRuntimeReadiness, runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { useRuntimeCapabilities } from './use-runtime-capabilities';

/**
 * Query key for the system-requirements endpoint. Shared so "Check again"
 * refetches — and the on-demand provisioning mutation's invalidation — update
 * every consumer (picker, launch popover, setup panel) in lockstep.
 */
export const REQUIREMENTS_KEY = ['requirements'] as const;

/**
 * Fetch per-runtime dependency checks for all registered runtimes.
 *
 * Unlike capabilities, requirements CHANGE while the server runs (the user
 * installs a CLI, signs in), so this is refetchable, but never automatically.
 * The server probes each runtime's binary + version + auth (bounded and run
 * concurrently), which still costs a real round-trip, so focus-refetch from
 * persistently-mounted consumers (status bar, launch popovers) would add
 * needless load. Explicit refresh only: the setup panel's "Check again" button
 * calls `refetch()`.
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

/**
 * Resolve a runtime's two-state Ready/Connect projection for the setup surface.
 *
 * Prefers the server's derived `state`/`connect` (the single projection
 * authority — it owns the honest CTA label and kind). Three cases:
 * 1. **Entry with `state`** — return the server projection verbatim.
 * 2. **Entry without `state`** — a legacy/loading payload predating the T0
 *    projection; re-derive honestly from `dependencies` via the same shared
 *    {@link deriveRuntimeReadiness} the server uses (never a blind default).
 * 3. **No entry** — while requirements are still loading, stay optimistically
 *    Ready so the surface never flashes a Connect it cannot substantiate; once
 *    loaded, an absent entry means the runtime is not registered with this
 *    server, so present a single Install action (the terminal detail lives in
 *    the Advanced disclosure).
 *
 * @param requirements - The aggregated requirements result, or `undefined` while loading.
 * @param type - Runtime type identifier, e.g. `'opencode'`.
 * @param registered - Whether the runtime is registered with this server. When
 *   an entry is present this is ignored (the entry is authoritative); it only
 *   distinguishes "still loading" from "known but not installed".
 */
export function selectRuntimeReadiness(
  requirements: SystemRequirements | undefined,
  type: string,
  registered = true
): RuntimeConnectState {
  const entry = requirements?.runtimes[type];
  if (entry) {
    if (entry.state) return { state: entry.state, connect: entry.connect };
    return deriveRuntimeReadiness(type, entry.dependencies);
  }
  if (!requirements || registered) return { state: 'ready' };
  return {
    state: 'connect',
    connect: { kind: 'install', label: `Install ${runtimeDisplayName(type)}` },
  };
}

/**
 * How much notice a person gets before a sign-in runs out.
 *
 * Three days is long enough to act on at a convenient moment and short enough
 * that the warning stays rare — a subscription sign-in lasts weeks, so a wider
 * window would leave the line on screen most of the time and teach people to
 * ignore it.
 */
const SIGN_IN_WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** A sign-in close enough to running out that the app says so. */
export interface ExpiringSignIn {
  /** ISO-8601 instant the sign-in runs out. */
  expiresAt: string;
  /**
   * Plain-language time remaining (`'2 days'`, `'5 hours'`, `'under an hour'`),
   * or `null` once the deadline has passed and the sign-in is running on
   * borrowed time — still working, but unable to renew itself.
   */
  timeLeft: string | null;
}

/** Describe a positive duration the way a person would say it, coarsest unit only. */
function describeTimeLeft(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * The runtime's sign-in deadline, but only when it is close enough to be worth
 * mentioning — otherwise `null`, which is the answer nearly all the time.
 *
 * A deadline that has ALREADY passed on a still-`satisfied` check is the loudest
 * case, not a silent one. That is the last stretch before the hard failure: the
 * sign-in can no longer renew itself, but the token in hand still works, so the
 * server honestly reports it as satisfied and the card would otherwise read a
 * plain "Ready" for the few hours that remain — the exact window this warning
 * exists for. It reports `timeLeft: null` so the caller can say so plainly.
 *
 * Deliberately silent in three cases that all look similar in the data and are
 * not the same thing:
 * - **No deadline reported.** Most credentials have none to read (an API key
 *   never expires on a schedule), and absence is not evidence of trouble.
 * - **A deadline further out than the warning window.** Nothing to do yet.
 * - **A check that is already failing.** A sign-in that is fully out of road is
 *   reported as `missing` by the server and the card already offers Connect;
 *   adding a countdown beside it would say the same thing twice.
 *
 * The comparison is against this device's clock, while the deadline is the
 * server's absolute instant. A badly-skewed client shifts the countdown by the
 * skew — tolerable against a three-day window, and not worth a clock-sync
 * handshake to remove.
 *
 * @param requirements - The aggregated requirements result, or `undefined` while loading.
 * @param type - Runtime type identifier, e.g. `'claude-code'`.
 * @param now - Current epoch ms (injectable so the copy can be tested).
 */
export function selectExpiringSignIn(
  requirements: SystemRequirements | undefined,
  type: string,
  now: number = Date.now()
): ExpiringSignIn | null {
  const deadline = requirements?.runtimes[type]?.dependencies.find(
    (d) => d.status === 'satisfied' && d.expiresAt !== undefined
  )?.expiresAt;
  if (deadline === undefined) return null;

  const msLeft = Date.parse(deadline) - now;
  if (Number.isNaN(msLeft) || msLeft > SIGN_IN_WARNING_WINDOW_MS) return null;
  if (msLeft <= 0) return { expiresAt: deadline, timeLeft: null };

  return { expiresAt: deadline, timeLeft: describeTimeLeft(msLeft) };
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
