import { useState } from 'react';

/** Inputs to {@link useOnboardingOverlayVisible}. */
export interface OnboardingOverlayInput {
  /** Config-derived signal: a brand-new install that has neither finished nor dismissed onboarding. */
  shouldShowOnboarding: boolean;
  /** Session flag set the instant the user finishes or skips — the only thing that closes the overlay. */
  onboardingHiddenForSession: boolean;
}

/**
 * Decide whether the first-run overlay is mounted, with a latch so it never
 * vanishes out from under the user.
 *
 * The problem it solves: reaching the finish screen writes `completedAt` to
 * config, and the ensuing refetch flips `shouldShowOnboarding` to `false`
 * within a second or two. Without a latch the overlay would unmount the moment
 * that write lands — before the user has clicked "Start your first session" —
 * dumping them on the dashboard and skipping the designed DorkBot landing.
 *
 * Once the overlay has been shown this session, it stays mounted until
 * `onboardingHiddenForSession` becomes true, which happens only on an explicit
 * user action (the finish CTA, or Skip all / dismiss). A config refetch can no
 * longer close it as a side effect.
 *
 * @param input - The config-derived show signal and the session hide flag.
 */
export function useOnboardingOverlayVisible(input: OnboardingOverlayInput): boolean {
  const { shouldShowOnboarding, onboardingHiddenForSession } = input;
  const shouldMount = shouldShowOnboarding && !onboardingHiddenForSession;
  const [everShown, setEverShown] = useState(false);

  // Latch by adjusting state during render (React's recommended alternative to
  // an effect): the first time the overlay qualifies to show, remember it, so a
  // later config refetch that flips `shouldShowOnboarding` to false cannot
  // unmount the overlay. Only the session hide flag closes it.
  if (shouldMount && !everShown) {
    setEverShown(true);
  }

  return everShown && !onboardingHiddenForSession;
}
