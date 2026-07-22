/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const mockDismiss = vi.fn().mockResolvedValue(undefined);
const mockStartOnboarding = vi.fn();

vi.mock('../model/use-onboarding', () => ({
  useOnboarding: vi.fn(() => ({
    dismiss: mockDismiss,
    startOnboarding: mockStartOnboarding,
  })),
}));

// Mock the surfaces to isolate OnboardingFlow's stage navigation.
vi.mock('../ui/SystemRequirementsStep', () => ({
  SystemRequirementsStep: ({ onContinue }: { onContinue: () => void }) => (
    <div data-testid="requirements-step">
      <button onClick={onContinue}>Continue</button>
    </div>
  ),
}));

vi.mock('../ui/WelcomeStep', () => ({
  WelcomeStep: ({ onGetStarted, onSkip }: { onGetStarted: () => void; onSkip: () => void }) => (
    <div data-testid="welcome-step">
      <button onClick={onGetStarted}>Get Started</button>
      <button onClick={onSkip}>Skip setup welcome</button>
    </div>
  ),
}));

vi.mock('../ui/OnboardingConversation', () => ({
  OnboardingConversation: ({ onComplete }: { onComplete: () => void }) => (
    <div data-testid="conversation">
      <button onClick={onComplete}>Dissolve</button>
    </div>
  ),
}));

import { OnboardingFlow } from '../ui/OnboardingFlow';

/** Drive Welcome -> Requirements -> Conversation. */
function advanceToConversation() {
  fireEvent.click(screen.getByText('Get Started'));
  fireEvent.click(screen.getByText('Continue'));
}

describe('OnboardingFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the welcome step initially', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    expect(screen.getByTestId('welcome-step')).toBeTruthy();
  });

  it('calls startOnboarding once on mount', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    expect(mockStartOnboarding).toHaveBeenCalledTimes(1);
  });

  it('Get Started advances to the requirements step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText('Get Started'));
    expect(screen.getByTestId('requirements-step')).toBeTruthy();
  });

  it('Continue advances from requirements into the conversation', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToConversation();
    expect(screen.getByTestId('conversation')).toBeTruthy();
  });

  it('the conversation nav bar has Back and Skip setup, and no step dots', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToConversation();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip setup' })).toBeTruthy();
    // A conversation is not a dotted wizard — no per-step indicator dots.
    expect(screen.queryByText('Skip', { exact: true })).toBeNull();
  });

  it('Back returns from the conversation to the requirements step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToConversation();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('requirements-step')).toBeTruthy();
  });

  it('Skip setup in the conversation dismisses and completes', async () => {
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);
    advanceToConversation();
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('Skip setup on welcome dismisses and completes', async () => {
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);
    fireEvent.click(screen.getByText('Skip setup welcome'));
    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});
