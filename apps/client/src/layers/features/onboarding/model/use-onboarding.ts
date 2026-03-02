import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

  const { data: config } = useQuery({
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
  const shouldShowOnboarding = !isOnboardingComplete && !isOnboardingDismissed;

  const patchOnboarding = useMutation({
    mutationFn: (patch: Partial<OnboardingState>) =>
      transport.updateConfig({ onboarding: { ...state, ...patch } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CONFIG_KEY] });
    },
  });

  /** Mark a step as completed. */
  function completeStep(step: OnboardingStep) {
    if (state.completedSteps.includes(step)) return;
    patchOnboarding.mutate({
      completedSteps: [...state.completedSteps, step],
    });
  }

  /** Skip a step without completing it. */
  function skipStep(step: OnboardingStep) {
    if (state.skippedSteps.includes(step)) return;
    patchOnboarding.mutate({
      skippedSteps: [...state.skippedSteps, step],
    });
  }

  /** Dismiss onboarding entirely. */
  function dismiss() {
    patchOnboarding.mutate({
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
    isOnboardingComplete,
    isOnboardingDismissed,
    shouldShowOnboarding,
    completeStep,
    skipStep,
    dismiss,
    startOnboarding,
  };
}
