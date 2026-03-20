import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import type { OnboardingState, OnboardingStep } from '@dorkos/shared/config-schema';

const CONFIG_KEY = ['config'] as const;
const ALL_STEPS: OnboardingStep[] = ['discovery', 'pulse', 'adapters'];

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
  };

  const state: OnboardingState = config?.onboarding
    ? {
        completedSteps: config.onboarding.completedSteps as OnboardingStep[],
        skippedSteps: config.onboarding.skippedSteps as OnboardingStep[],
        startedAt: config.onboarding.startedAt,
        dismissedAt: config.onboarding.dismissedAt,
      }
    : DEFAULT_STATE;

  const isOnboardingComplete = ALL_STEPS.every((step) => state.completedSteps.includes(step));
  const isOnboardingDismissed = state.dismissedAt !== null;
  const shouldShowOnboarding = !isLoading && !isOnboardingComplete && !isOnboardingDismissed;

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

  /** Dismiss onboarding entirely. */
  function dismiss() {
    return patchOnboarding.mutateAsync({
      dismissedAt: new Date().toISOString(),
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
    isLoading,
    isOnboardingComplete,
    isOnboardingDismissed,
    shouldShowOnboarding,
    completeStep,
    skipStep,
    dismiss,
    startOnboarding,
  };
}
