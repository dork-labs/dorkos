import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import type { OnboardingState, OnboardingStep } from '@dorkos/shared/config-schema';

const CONFIG_KEY = ['config'] as const;

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

  const { data: config, isLoading } = useQuery({
    queryKey: [...CONFIG_KEY],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const DEFAULT_STATE: OnboardingState = {
    completedSteps: [],
    skippedSteps: [],
    startedAt: null,
    dismissedAt: null,
    completedAt: null,
  };

  const state: OnboardingState = config?.onboarding
    ? {
        completedSteps: config.onboarding.completedSteps as OnboardingStep[],
        skippedSteps: config.onboarding.skippedSteps as OnboardingStep[],
        startedAt: config.onboarding.startedAt,
        dismissedAt: config.onboarding.dismissedAt,
        // `?? null` guards the upgrade window: an on-disk onboarding block
        // written before `completedAt` existed arrives without the field (conf's
        // top-level defaults-merge is shallow and never adds a nested default),
        // so normalize it rather than let `undefined` read as "complete".
        completedAt: config.onboarding.completedAt ?? null,
      }
    : DEFAULT_STATE;

  // `completedAt` is the single authoritative "onboarding is done" signal
  // (set when the user reaches the finish screen). Per-step completion no
  // longer gates this — a user who skips individual steps and finishes is done.
  const isOnboardingComplete = state.completedAt !== null;
  const isOnboardingDismissed = state.dismissedAt !== null;
  // The full-screen flow: brand-new installs only (neither finished nor dismissed).
  const shouldShowOnboarding = !isLoading && !isOnboardingComplete && !isOnboardingDismissed;
  // The sidebar getting-started helper: after the flow is finished, until the
  // user dismisses the card. A deliberate skip-all (dismissedAt) hides both.
  const shouldShowGettingStarted = !isLoading && isOnboardingComplete && !isOnboardingDismissed;

  const patchOnboarding = useMutation({
    mutationFn: (patch: Partial<OnboardingState>) => transport.updateConfig({ onboarding: patch }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CONFIG_KEY] }).then(() => {
        pendingCompleted.current.clear();
        pendingSkipped.current.clear();
      });
    },
    onError: (_err, patch) => {
      pendingCompleted.current.clear();
      pendingSkipped.current.clear();
      const keys = Object.keys(patch).join(', ');
      toast.error(`Failed to save onboarding progress (${keys})`);
    },
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
