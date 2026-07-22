/**
 * Sync the onboarding overlay's active stage to a URL search param.
 *
 * The overlay is not a route, but its three entry screens should still respond
 * to the browser's back/forward and survive a refresh. This hook derives the
 * current stage from `?onboarding=` and returns a navigator that walks it via
 * real history entries (so back/forward move between stages). On mount it
 * anchors an absent or invalid param to the first stage without adding a history
 * entry. Clearing the param when onboarding ends is handled by the app shell.
 *
 * @module features/onboarding/model/use-onboarding-stage
 */
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { isOnboardingStage, type OnboardingStage } from './onboarding-stage';

/** Route-agnostic search updater — the overlay may sit over any route. */
type OnboardingSearchUpdater = (prev: Record<string, unknown>) => Record<string, unknown>;

/** The derived stage plus a history-integrated navigator. */
export interface OnboardingStageNav {
  /** The active stage, normalized from the URL (defaults to the first stage). */
  stage: OnboardingStage;
  /** Navigate to a stage, pushing a history entry so back/forward can return. */
  goToStage: (stage: OnboardingStage) => void;
  /**
   * Step back one stage the way the browser's Back would.
   *
   * When this session pushed a forward stage, this pops that history entry so
   * the in-UI Back and browser-Back behave identically (no phantom forward
   * entry left behind). When the user landed directly on a later stage (a
   * refresh or deep link restored it, with no in-app entry to pop), it falls
   * back to pushing `fallback` so Back never ejects the user out of the app.
   *
   * @param fallback - Stage to push when there is no in-app entry to pop.
   */
  goBack: (fallback: OnboardingStage) => void;
}

/**
 * Read and drive the onboarding stage through the `?onboarding=` search param.
 */
export function useOnboardingStage(): OnboardingStageNav {
  const navigate = useNavigate();
  const router = useRouter();
  const raw = (useSearch({ strict: false }) as { onboarding?: unknown }).onboarding;
  const stage: OnboardingStage = isOnboardingStage(raw) ? raw : 'welcome';

  // Tracks whether a forward stage was pushed this session, so `goBack` knows
  // there is an in-app history entry it can safely pop (vs. a refresh/deep-link
  // landing, where popping would leave the app entirely).
  const pushedSinceMount = useRef(false);

  // Anchor the param on mount so refresh and back have a concrete stage to land
  // on. `replace` keeps this out of history — it is initialization, not a step.
  // Mount-only by design: later stage changes go through `goToStage`.
  useEffect(() => {
    if (isOnboardingStage(raw)) return;
    const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: 'welcome' });
    navigate({ search: updater as never, replace: true });
  }, []);

  const goToStage = useCallback(
    (next: OnboardingStage) => {
      const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: next });
      // replace:false (the default) so browser back/forward walk the stages.
      pushedSinceMount.current = true;
      navigate({ search: updater as never });
    },
    [navigate]
  );

  const goBack = useCallback(
    (fallback: OnboardingStage) => {
      if (pushedSinceMount.current) {
        // Pop the forward push so Back mirrors browser-Back — no phantom entry.
        router.history.back();
        return;
      }
      // Refresh/deep-link landing: no in-app entry to pop, so push `fallback`
      // instead of popping out of the app entirely.
      const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: fallback });
      navigate({ search: updater as never });
    },
    [router, navigate]
  );

  return { stage, goToStage, goBack };
}

/**
 * Strip a lingering `?onboarding=` stage param once onboarding is over.
 *
 * The overlay owns the param while it is showing, but after the user finishes or
 * dismisses onboarding the overlay never mounts — so a param left by finishing,
 * or deep-linked by a returning user, would otherwise sit in the URL forever.
 * Gating on `done` (rather than "overlay hidden") means a fresh user's param
 * survives config loading and is read back on refresh; only a genuinely finished
 * or dismissed state clears it, via `replace` so it leaves no history entry.
 *
 * @param done - True once onboarding is completed or dismissed.
 */
export function useClearOnboardingStageWhenDone(done: boolean): void {
  const navigate = useNavigate();
  const raw = (useSearch({ strict: false }) as { onboarding?: unknown }).onboarding;
  useEffect(() => {
    if (!raw || !done) return;
    const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: undefined });
    navigate({ search: updater as never, replace: true });
  }, [raw, done, navigate]);
}
