/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('motion/react', () => ({
  motion: {
    div: 'div',
  },
  useReducedMotion: () => false,
}));

const mockUseOnboarding = vi.fn();

vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => mockUseOnboarding(),
}));

import { ProgressCard } from '../ui/ProgressCard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOnboardingState(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      completedSteps: [] as string[],
      skippedSteps: [] as string[],
      startedAt: null,
      dismissedAt: null,
    },
    shouldShowOnboarding: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProgressCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOnboarding.mockReturnValue(defaultOnboardingState());
  });

  afterEach(() => {
    cleanup();
  });

  it('shows both step names', () => {
    render(<ProgressCard onStepClick={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByText('Discover agents')).toBeTruthy();
    expect(screen.getByText('Set up Pulse schedules')).toBeTruthy();
  });

  it('shows Getting Started heading', () => {
    render(<ProgressCard onStepClick={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByText('Getting Started')).toBeTruthy();
  });

  it('completed steps show muted text without strikethrough', () => {
    mockUseOnboarding.mockReturnValue(
      defaultOnboardingState({
        state: {
          completedSteps: ['discovery'],
          skippedSteps: [],
          startedAt: null,
          dismissedAt: null,
        },
      })
    );

    render(<ProgressCard onStepClick={vi.fn()} onDismiss={vi.fn()} />);

    const completedItem = screen.getByText('Discover agents');
    expect(completedItem.className).not.toContain('line-through');
  });

  it('dismiss button calls onDismiss', () => {
    const onDismiss = vi.fn();

    render(<ProgressCard onStepClick={vi.fn()} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('incomplete step links call onStepClick with correct index', () => {
    const onStepClick = vi.fn();

    render(<ProgressCard onStepClick={onStepClick} onDismiss={vi.fn()} />);

    // Click the second step (index 1)
    fireEvent.click(screen.getByText('Set up Pulse schedules'));

    expect(onStepClick).toHaveBeenCalledWith(1);
  });

  it('first step link calls onStepClick with index 0', () => {
    const onStepClick = vi.fn();

    render(<ProgressCard onStepClick={onStepClick} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByText('Discover agents'));

    expect(onStepClick).toHaveBeenCalledWith(0);
  });

  it('skipped steps are still clickable', () => {
    const onStepClick = vi.fn();

    mockUseOnboarding.mockReturnValue(
      defaultOnboardingState({
        state: {
          completedSteps: [],
          skippedSteps: ['pulse'],
          startedAt: null,
          dismissedAt: null,
        },
      })
    );

    render(<ProgressCard onStepClick={onStepClick} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByText('Set up Pulse schedules'));

    expect(onStepClick).toHaveBeenCalledWith(1);
  });

  it('completed steps are not clickable buttons', () => {
    mockUseOnboarding.mockReturnValue(
      defaultOnboardingState({
        state: {
          completedSteps: ['discovery'],
          skippedSteps: [],
          startedAt: null,
          dismissedAt: null,
        },
      })
    );

    render(<ProgressCard onStepClick={vi.fn()} onDismiss={vi.fn()} />);

    // The completed step text is a span, not a button
    const completedText = screen.getByText('Discover agents');
    expect(completedText.tagName).toBe('SPAN');
  });
});
