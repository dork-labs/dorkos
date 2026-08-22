/**
 * First-run setup picks which runtime new conversations start on, once.
 *
 * The decision waits for the requirements scan to settle rather than running at
 * boot, because readiness is not a fixed fact during onboarding: the connect
 * cards exist precisely so a person can authenticate Codex mid-flow, and a
 * choice made before that would name a runtime that was not connected yet
 * (spec `execution-defaults` §7).
 *
 * @module features/onboarding/model/use-onboarding-runtime-default
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConfig, useUpdateConfig, configKeys } from '@/layers/entities/config';
import { PRIMARY_RUNTIME_TYPES } from '@/layers/entities/runtime';

/** What a new session runs on when nothing has ever been chosen. */
const BUILT_IN_DEFAULT = 'claude-code';

/**
 * Which ready runtime new conversations should start on.
 *
 * Two rules, in order. **A ready current default is never changed** — a person
 * or a previous install already answered this question, and re-answering it
 * because a second runtime happens to be connected would be the system
 * overruling them. Otherwise the pick follows the same runtime order the rest
 * of the product presents (`PRIMARY_RUNTIME_TYPES`), so "the one that is
 * actually ready" is deterministic rather than dependent on the order an object
 * happened to be keyed in.
 *
 * @param readyTypes - Runtime types the requirements scan found connected
 * @param currentDefault - What `runtimes.default` says right now
 * @returns The runtime to start new conversations on, or `null` if none is ready
 */
export function chooseDefaultRuntime(readyTypes: string[], currentDefault: string): string | null {
  if (readyTypes.length === 0) return null;
  if (readyTypes.includes(currentDefault)) return currentDefault;
  const preferred = PRIMARY_RUNTIME_TYPES.find((type) => readyTypes.includes(type));
  return preferred ?? readyTypes[0];
}

/** Inputs to {@link useOnboardingRuntimeDefault}. */
export interface OnboardingRuntimeDefaultOptions {
  /** Runtime types the scan found connected. */
  readyTypes: string[];
  /** Whether the scan has finished — a decision on an unsettled scan is a guess. */
  settled: boolean;
  /**
   * A value that changes once per completed scan and at no other time — the
   * query's `dataUpdatedAt`. It is what "one attempt per settle" is counted in.
   *
   * Deliberately not the `readyTypes` array's identity: a recheck that comes
   * back byte-identical is structurally shared by TanStack Query, so the array
   * would be the same object and a person who fixed the problem and pressed
   * "Check again" would get no second attempt.
   */
  settleToken: number;
}

/** What first-run setup decided, and the way to change it. */
export interface OnboardingRuntimeDefault {
  /**
   * The runtime new conversations will start on, or `null` while the answer is
   * still unknown (config loading, nothing ready yet, or a write that failed).
   * Drives the disclosure sentence, which must not claim a default that is not
   * in force.
   */
  runtime: string | null;
  /**
   * What the picker should show as selected: the pending choice, else whatever
   * config says right now. Never null once config has loaded, so the way to set
   * a default survives a failed write — which is the moment a person most needs
   * it (there is no other route to this setting from inside onboarding).
   */
  current: string;
  /** Change the default — the one tap that follows the disclosure. */
  choose: (type: string) => void;
  /** A failed write, in one sentence a person can act on. */
  error: string | null;
}

/**
 * Decide, disclose, and let the person change the default runtime.
 *
 * Two latches, for two different repeats. `onboarding.runtimeDefaultSetAt` is
 * the durable one: it is what makes a second visit to this step, or a refresh
 * in the middle of the first, leave the setting alone. Within one visit, a ref
 * holding the `settleToken` this hook last acted on is the other — one attempt
 * per completed scan, which also absorbs the double effect React runs in
 * development.
 *
 * **Counting attempts in settles rather than in "have we written yet" is what
 * makes a failed write retryable without becoming a loop.** An onboarding step
 * is the one place with no other route to this setting, so a write that failed
 * cannot latch the decision shut forever — but a plain boolean released on
 * failure re-fires on the very next render, and a failing server turns that into
 * a hot loop (measured against a 500ing server: 134 PATCHes in six seconds). A
 * settle cannot repeat without a new scan, so "Check again" is exactly one more
 * attempt and a render is none.
 *
 * @param options - The scan's readiness result and whether it has settled
 * @returns The decided runtime, what the picker should show, a setter, and any error
 */
export function useOnboardingRuntimeDefault({
  readyTypes,
  settled,
  settleToken,
}: OnboardingRuntimeDefaultOptions): OnboardingRuntimeDefault {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // What the person sees, ahead of the round trip. A disclosure that lags the
  // write by a refetch would say "Claude Code" for a beat after a tap that
  // chose Codex, which reads as the tap not working.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  // The settle this hook has already acted on. `null` means it has acted on none.
  const actedOnRef = useRef<number | null>(null);

  const configured = config?.executionDefaults?.runtime ?? BUILT_IN_DEFAULT;
  const alreadyDecided = Boolean(config?.onboarding?.runtimeDefaultSetAt);

  /**
   * One write, and every reader moves with it.
   *
   * Invalidates the `configKeys.all` PREFIX rather than this hook's own key: the
   * onboarding conversation stamps the first session's birth certificate with
   * the default runtime off a different query under the same root, and the
   * server applies `runtimes.default` live.
   */
  const write = useCallback(
    (patch: Record<string, unknown>, chosen: string) => {
      setError(null);
      setOptimistic(chosen);
      updateConfig.mutate(patch, {
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: configKeys.all }),
        onError: (err) => {
          // Nothing was decided, so the sentence goes back to claiming nothing.
          // `actedOnRef` deliberately stays: this settle has had its turn, and
          // the next one gets another.
          setOptimistic(null);
          setError(err.message || 'Could not save that. Try again.');
        },
      });
    },
    [updateConfig, queryClient]
  );

  useEffect(() => {
    if (!settled || readyTypes.length === 0) return;
    // No config yet means the marker is unknown, and an unknown marker must
    // never be read as "not decided" — that is how an install past first run
    // would get its setting rewritten.
    if (!config || alreadyDecided || actedOnRef.current === settleToken) return;

    const chosen = chooseDefaultRuntime(readyTypes, configured);
    if (!chosen) return;
    actedOnRef.current = settleToken;
    write(
      {
        onboarding: { runtimeDefaultSetAt: new Date().toISOString() },
        // Skipped when the ready runtime is already the default: the decision
        // still gets stamped, but nothing pretends a setting changed.
        ...(chosen === configured ? {} : { runtimes: { default: chosen } }),
      },
      chosen
    );
  }, [settled, settleToken, readyTypes, config, alreadyDecided, configured, write]);

  const choose = useCallback(
    (type: string) => {
      if (type === (optimistic ?? configured)) return;
      write(
        {
          runtimes: { default: type },
          // A person tapping a runtime here IS the decision, even in the case
          // where the automatic one never got to run.
          ...(alreadyDecided
            ? {}
            : { onboarding: { runtimeDefaultSetAt: new Date().toISOString() } }),
        },
        type
      );
    },
    [write, optimistic, configured, alreadyDecided]
  );

  const decided = alreadyDecided || optimistic !== null;

  return {
    runtime: optimistic ?? (decided && config ? configured : null),
    current: optimistic ?? configured,
    choose,
    error,
  };
}
