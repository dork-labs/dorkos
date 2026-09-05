import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { usePendingRead, useTransport } from '@/layers/shared/model';
import type { OnboardingState, OnboardingStep } from '@dorkos/shared/config-schema';
import { configKeys, CONFIG_STALE_TIME_MS } from '@/layers/entities/config';

/**
 * Manage first-time user onboarding state stored server-side in `~/.dork/config.json`.
 *
 * Reads onboarding state from `GET /api/config` and persists mutations
 * via `PATCH /api/config`.
 */
export function useOnboarding() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  // Track steps dispatched but not yet confirmed by the server cache,
  // so rapid calls within the same render frame build correct superset arrays.
  const pendingCompleted = useRef(new Set<OnboardingStep>());
  const pendingSkipped = useRef(new Set<OnboardingStep>());

  const { data: config, isLoading: isFetchingConfig } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  // **"We have not asked yet" is not "there is nothing there"** — and here that
  // distinction decides whether a returning user is shown the first-run wizard.
  // `shouldShowOnboarding` below is computed from an empty config in the restore
  // window, comes out true, and `useOnboardingOverlayVisible` latches it
  // permanently: a cockpit showing "Welcome to DorkOS" to an install that had
  // dismissed onboarding weeks ago, writing a fresh `startedAt` on its way past.
  // Caught in a browser while adding the persisted cache — a warm reload wrote
  // `startedAt` one second AFTER the `dismissedAt` it should have read. Why
  // `isLoading` cannot answer this on its own is in `usePendingRead`.
  const isLoading = usePendingRead(isFetchingConfig);

  const DEFAULT_STATE: OnboardingState = {
    completedSteps: [],
    skippedSteps: [],
    startedAt: null,
    dismissedAt: null,
    completedAt: null,
    runtimeDefaultSetAt: null,
  };

  const state: OnboardingState = config?.onboarding
    ? {
        completedSteps: config.onboarding.completedSteps as OnboardingStep[],
        skippedSteps: config.onboarding.skippedSteps as OnboardingStep[],
        startedAt: config.onboarding.startedAt,
        dismissedAt: config.onboarding.dismissedAt,
        // The server always sends this filled — a config written before the
        // field existed still reads back through the schema's default — so this
        // is not about an upgrade window on disk. It guards the ONE payload
        // shape where the difference bites: a cockpit talking to a server old
        // enough to omit the field entirely, where `undefined !== null` would
        // read as "onboarding finished" and hide first-run setup for good.
        completedAt: config.onboarding.completedAt ?? null,
        // No such guard needed here: absent and null both read as "not decided",
        // which is the honest answer for a server that cannot tell us.
        runtimeDefaultSetAt: config.onboarding.runtimeDefaultSetAt,
      }
    : DEFAULT_STATE;

  // `completedAt` is the single authoritative "onboarding is done" signal
  // (set when the user reaches the finish screen). Per-step completion no
  // longer gates this — a user who skips individual steps and finishes is done.
  const isOnboardingComplete = state.completedAt !== null;
  const isOnboardingDismissed = state.dismissedAt !== null;
  // **"We asked and got nothing" is not "there is nothing there" either.** The
  // note above is about the restoring window; this is the same mistake one step
  // later. A config read that FAILS leaves `isLoading` false with `config`
  // undefined, so every flag below falls back to `DEFAULT_STATE` and a settled
  // install reads as brand new — and `useOnboardingOverlayVisible` latches that
  // permanently, so the first-run wizard was still up after the server came
  // back (DOR-1475). A fresh install is a config that ARRIVED and says nobody
  // has finished onboarding; no config at all is not an answer yet.
  const hasConfig = config !== undefined;
  // The full-screen flow: brand-new installs only (neither finished nor dismissed).
  const shouldShowOnboarding =
    !isLoading && hasConfig && !isOnboardingComplete && !isOnboardingDismissed;
  // The sidebar getting-started helper: after the flow is finished, until the
  // user dismisses the card. A deliberate skip-all (dismissedAt) hides both.
  const shouldShowGettingStarted = !isLoading && isOnboardingComplete && !isOnboardingDismissed;

  const patchOnboarding = useMutation({
    mutationFn: (patch: Partial<OnboardingState>) => transport.updateConfig({ onboarding: patch }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configKeys.all }).then(() => {
        pendingCompleted.current.clear();
        pendingSkipped.current.clear();
      });
    },
    onError: (err, patch) => {
      pendingCompleted.current.clear();
      pendingSkipped.current.clear();
      // The field names go to the console and the breadcrumb trail, never to
      // the toast (DOR-1755). This fires in the first minutes of the product,
      // where a person has the least context: "Failed to save onboarding
      // progress (completedSteps, dismissedAt)" named internal identifiers at
      // someone who had not yet learned what DorkOS is.
      console.error('[onboarding] could not save progress', {
        fields: Object.keys(patch),
        error: err,
      });
      toast.error("DorkOS couldn't save where you got to in setup.", {
        description: 'You can keep going. It will try again.',
      });
    },
    // The shared mutation toast would name the mutation, not the moment; this
    // one is written for a first-run screen, so it opts out of the generic one
    // rather than showing two.
    meta: { suppressErrorToast: true },
  });

  /** Mark a step as completed. */
  function completeStep(step: OnboardingStep) {
    const allCompleted = new Set([...state.completedSteps, ...pendingCompleted.current]);
    if (allCompleted.has(step)) return;
    pendingCompleted.current.add(step);
    patchOnboarding.mutate({
      completedSteps: [...allCompleted, step],
    });
  }

  /** Skip a step without completing it. */
  function skipStep(step: OnboardingStep) {
    const allSkipped = new Set([...state.skippedSteps, ...pendingSkipped.current]);
    if (allSkipped.has(step)) return;
    pendingSkipped.current.add(step);
    patchOnboarding.mutate({
      skippedSteps: [...allSkipped, step],
    });
  }

  /** Dismiss onboarding entirely (skip-all, or dismiss the getting-started card). */
  function dismiss() {
    return patchOnboarding.mutateAsync({
      dismissedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark onboarding finished — the authoritative completion signal. Persists
   * `completedAt` so the full-screen flow never reappears on refresh, and the
   * sidebar getting-started helper takes over.
   */
  function completeOnboarding() {
    if (state.completedAt) return;
    patchOnboarding.mutate({
      completedAt: new Date().toISOString(),
    });
  }

  /** Record the onboarding start timestamp. */
  function startOnboarding() {
    if (state.startedAt) return;
    patchOnboarding.mutate({
      startedAt: new Date().toISOString(),
    });
  }

  return {
    state,
    config,
    isLoading,
    isOnboardingComplete,
    isOnboardingDismissed,
    shouldShowOnboarding,
    shouldShowGettingStarted,
    completeStep,
    skipStep,
    dismiss,
    completeOnboarding,
    startOnboarding,
  };
}
