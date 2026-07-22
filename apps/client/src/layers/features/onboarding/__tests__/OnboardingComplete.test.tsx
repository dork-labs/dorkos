/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('motion/react', () => ({
  motion: { div: 'div', span: 'span' },
  useReducedMotion: () => true,
}));

const stopCelebration = vi.fn();
const fireCelebration = vi.fn().mockResolvedValue(stopCelebration);
vi.mock('@/layers/shared/lib', () => ({
  fireCelebration: (...args: unknown[]) => fireCelebration(...args),
}));

vi.mock('@/layers/shared/ui', () => ({
  HoverBorderGradient: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({
    state: {
      completedSteps: ['meet-dorkbot'],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
      completedAt: null,
    },
  }),
}));

import { OnboardingComplete } from '../ui/OnboardingComplete';

describe('OnboardingComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('fires the celebration once on mount', async () => {
    render(<OnboardingComplete onComplete={vi.fn()} />);
    await waitFor(() => expect(fireCelebration).toHaveBeenCalledTimes(1));
  });

  it('stops the celebration when it unmounts (navigating away must not leave confetti running)', async () => {
    const { unmount } = render(<OnboardingComplete onComplete={vi.fn()} />);
    // Let the async fireCelebration resolve so its cleanup is captured.
    await waitFor(() => expect(fireCelebration).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(stopCelebration).toHaveBeenCalled());
  });

  it('renders the finish CTA', () => {
    render(<OnboardingComplete onComplete={vi.fn()} />);
    expect(screen.getByText('Start your first session')).toBeInTheDocument();
  });
});
