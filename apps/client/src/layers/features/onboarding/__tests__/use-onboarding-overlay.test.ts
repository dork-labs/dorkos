/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOnboardingOverlayVisible } from '../model/use-onboarding-overlay';

describe('useOnboardingOverlayVisible', () => {
  it('shows the overlay for a fresh install', () => {
    const { result } = renderHook(() =>
      useOnboardingOverlayVisible({
        shouldShowOnboarding: true,
        onboardingHiddenForSession: false,
      })
    );
    expect(result.current).toBe(true);
  });

  it('stays mounted after a config refetch flips shouldShowOnboarding (the completedAt race)', () => {
    const { result, rerender } = renderHook((props) => useOnboardingOverlayVisible(props), {
      initialProps: { shouldShowOnboarding: true, onboardingHiddenForSession: false },
    });
    expect(result.current).toBe(true);

    // completedAt is written when the finish screen is reached; the refetch
    // flips shouldShowOnboarding to false — but the user has not clicked the CTA.
    rerender({ shouldShowOnboarding: false, onboardingHiddenForSession: false });
    expect(result.current).toBe(true);
  });

  it('unmounts once the user acts (session hide flag set)', () => {
    const { result, rerender } = renderHook((props) => useOnboardingOverlayVisible(props), {
      initialProps: { shouldShowOnboarding: true, onboardingHiddenForSession: false },
    });
    rerender({ shouldShowOnboarding: false, onboardingHiddenForSession: false });
    expect(result.current).toBe(true);

    // Finish CTA or Skip all sets the session flag — the only thing that closes it.
    rerender({ shouldShowOnboarding: false, onboardingHiddenForSession: true });
    expect(result.current).toBe(false);
  });

  it('never shows for a returning user who already finished onboarding', () => {
    const { result } = renderHook(() =>
      useOnboardingOverlayVisible({
        shouldShowOnboarding: false,
        onboardingHiddenForSession: false,
      })
    );
    expect(result.current).toBe(false);
  });
});
