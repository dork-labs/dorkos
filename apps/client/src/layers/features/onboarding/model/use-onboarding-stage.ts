/**
 * Sync the onboarding overlay's active stage to a URL search param.
 *
 * The overlay is not a route, but its four entry screens should still respond
 * to the browser's back/forward and survive a refresh. This hook derives the
 * current stage from `?onboarding=` and returns a navigator that walks it via
 * real history entries (so back/forward move between stages). On mount it
 * anchors an absent or invalid param to the first stage without adding a history
 * entry. Clearing the param when onboarding ends is handled by the app shell.
 *
 * @module features/onboarding/model/use-onboarding-stage
 */
import { useCallback, useEffect, useRef } from 'react';
import { useRouter, useRouterState, useSearch } from '@tanstack/react-router';
import { useInPlaceNavigate } from '@/layers/shared/model';
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
  const inPlaceNavigate = useInPlaceNavigate();
  const router = useRouter();
  const raw = (useSearch({ strict: false }) as { onboarding?: unknown }).onboarding;
  const stage: OnboardingStage = isOnboardingStage(raw) ? raw : 'welcome';

  // Tracks whether a forward stage was pushed this session, so `goBack` knows
  // there is an in-app history entry it can safely pop (vs. a refresh/deep-link
  // landing, where popping would leave the app entirely).
  const pushedSinceMount = useRef(false);

  // True once the router has resolved the initial location — the moment
  // `?onboarding=` is actually parsed into `raw`. On a cold load the first render
  // can precede that parse, so anchoring off `raw` before this point reads the
  // pre-parse default, not the deep link.
  const routerResolved = useRouterState({ select: (state) => state.status === 'idle' });

  // Establish the initial history anchor exactly once, from the PARSED param.
  //
  // If the URL carries no valid stage on a fresh load, pin it to the first stage
  // so refresh and Back have a concrete stage to land on. `replace` keeps this
  // out of history — it is initialization, not a step.
  //
  // Gating on `routerResolved` is the deep-link fix (DOR-1431): a mount-only
  // effect read `raw` before the router had parsed `?onboarding=` on a cold load,
  // saw the default, and rewrote a deep-linked stage back to `welcome`. Waiting
  // for the router to resolve means `raw` is the real parsed value here. The ref
  // keeps this a one-time initialization: later stage steps (`goToStage`) and the
  // end-of-onboarding param clear must never trigger a re-anchor.
  const hasAnchored = useRef(false);
  useEffect(() => {
    if (hasAnchored.current || !routerResolved) return;
    hasAnchored.current = true;
    if (isOnboardingStage(raw)) return;
    const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: 'welcome' });
    // The overlay rides above whatever route is active, so anchoring its stage
    // is an in-place rewrite, not a departure (DOR-931). `null` only in the
    // router-less embed, which never runs onboarding.
    inPlaceNavigate?.({ search: updater, replace: true });
  }, [routerResolved, raw, inPlaceNavigate]);

  const goToStage = useCallback(
    (next: OnboardingStage) => {
      const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: next });
      // replace:false (the default) so browser back/forward walk the stages —
      // still in-place (the overlay sits over the active route, not a new
      // destination), so the push carries the in-place stamp too.
      pushedSinceMount.current = true;
      inPlaceNavigate?.({ search: updater });
    },
    [inPlaceNavigate]
  );

  const goBack = useCallback(
    (fallback: OnboardingStage) => {
      if (pushedSinceMount.current) {
        // Pop the forward push so Back mirrors browser-Back — no phantom entry.
        router.history.back();
        return;
      }
      // Refresh/deep-link landing: no in-app entry to pop, so push `fallback`
      // instead of popping out of the app entirely. In-place, like every stage
      // step.
      const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: fallback });
      inPlaceNavigate?.({ search: updater });
    },
    [router, inPlaceNavigate]
  );

  return { stage, goToStage, goBack };
}

/** Inputs to {@link useClearOnboardingStageWhenDone}. */
export interface ClearOnboardingStageInput {
  /** True once onboarding is completed or dismissed. */
  done: boolean;
  /**
   * True while the first-run overlay is latched open (the app shell's
   * `useOnboardingOverlayVisible` value). While the overlay shows, the param is
   * its live stage source and must not be stripped.
   */
  overlayVisible: boolean;
}

/**
 * Strip a lingering `?onboarding=` stage param once onboarding is over.
 *
 * The overlay reads the param as its live stage while it is showing, but after
 * the user finishes or dismisses onboarding a param left by finishing, or
 * deep-linked by a returning user, would otherwise sit in the URL forever.
 * Gating on `done` (rather than a config refetch) means a fresh user's param
 * survives config loading and is read back on refresh.
 *
 * The strip is additionally gated on the overlay being closed. The conversation
 * writes `completedAt` mid-flow (so a dissolve into the real session is durable),
 * which flips `done` true while the overlay is deliberately still latched open —
 * stripping then would rewind the derived stage to `welcome` and destroy the
 * in-progress conversation. So the param is cleared only once the overlay has
 * actually closed (first-message dissolve, Skip all setup, or dismiss), via `replace`
 * so it leaves no history entry.
 *
 * @param input - The done signal plus whether the overlay is still showing.
 */
export function useClearOnboardingStageWhenDone(input: ClearOnboardingStageInput): void {
  const { done, overlayVisible } = input;
  const inPlaceNavigate = useInPlaceNavigate();
  const raw = (useSearch({ strict: false }) as { onboarding?: unknown }).onboarding;
  useEffect(() => {
    if (!raw || !done || overlayVisible) return;
    const updater: OnboardingSearchUpdater = (prev) => ({ ...prev, onboarding: undefined });
    // Stripping the finished overlay's param is in-place — nothing moves (DOR-931).
    inPlaceNavigate?.({ search: updater, replace: true });
  }, [raw, done, overlayVisible, inPlaceNavigate]);
}
