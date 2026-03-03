/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Mock motion/react before importing the component
vi.mock('motion/react', () => ({
  motion: {
    div: 'div',
    span: 'span',
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
}));

vi.mock('@/layers/shared/model', () => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock('@/layers/shared/lib', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  fireConfetti: vi.fn(),
}));

const mockCompleteStep = vi.fn();
const mockSkipStep = vi.fn();
const mockDismiss = vi.fn().mockResolvedValue(undefined);
const mockStartOnboarding = vi.fn();

vi.mock('../model/use-onboarding', () => ({
  useOnboarding: vi.fn(() => ({
    shouldShowOnboarding: true,
    state: {
      completedSteps: [],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
    },
    completeStep: mockCompleteStep,
    skipStep: mockSkipStep,
    dismiss: mockDismiss,
    startOnboarding: mockStartOnboarding,
  })),
}));

// Mock useMeshAgentPaths — default: returns one agent
const mockAgentPaths = vi.fn().mockReturnValue({
  data: {
    agents: [
      { id: 'agent-1', name: 'Test Agent', projectPath: '/test/project', icon: '🤖' },
    ],
  },
  isLoading: false,
});

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => mockAgentPaths(),
}));

// Mock step components to isolate OnboardingFlow navigation logic
vi.mock('../ui/WelcomeStep', () => ({
  WelcomeStep: ({ onGetStarted, onSkip }: { onGetStarted: () => void; onSkip: () => void }) => (
    <div data-testid="welcome-step">
      <button onClick={onGetStarted}>Get Started</button>
      <button onClick={onSkip}>Skip setup</button>
    </div>
  ),
}));

vi.mock('../ui/AgentDiscoveryStep', () => ({
  AgentDiscoveryStep: ({ onStepComplete }: { onStepComplete: () => void }) => (
    <div data-testid="discovery-step">
      <button onClick={onStepComplete}>Complete Discovery</button>
    </div>
  ),
}));

vi.mock('../ui/PulsePresetsStep', () => ({
  PulsePresetsStep: ({ onStepComplete }: { onStepComplete: () => void }) => (
    <div data-testid="pulse-step">
      <button onClick={onStepComplete}>Complete Pulse</button>
    </div>
  ),
}));

vi.mock('../ui/OnboardingComplete', () => ({
  OnboardingComplete: ({ onComplete }: { onComplete: () => void }) => (
    <div data-testid="onboarding-complete">
      <button onClick={onComplete}>Finish</button>
    </div>
  ),
}));

import { OnboardingFlow } from '../ui/OnboardingFlow';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default: one agent
    mockAgentPaths.mockReturnValue({
      data: {
        agents: [
          { id: 'agent-1', name: 'Test Agent', projectPath: '/test/project', icon: '🤖' },
        ],
      },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Welcome step initially', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    expect(screen.getByTestId('welcome-step')).toBeTruthy();
  });

  it('calls startOnboarding on mount', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    expect(mockStartOnboarding).toHaveBeenCalled();
  });

  it('clicking Get Started advances to discovery step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    fireEvent.click(screen.getByText('Get Started'));

    expect(screen.getByTestId('discovery-step')).toBeTruthy();
  });

  it('shows step indicator dots on step pages', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    // Two step indicators rendered as rounded-full elements
    const { container } = render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);
    const dots = container.querySelectorAll('.rounded-full');
    expect(dots.length).toBeGreaterThanOrEqual(2);
  });

  it('shows Skip and Skip all buttons on step pages', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip all' })).toBeTruthy();
  });

  it('initialStep=1 renders the pulse step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={1} />);

    expect(screen.getByTestId('pulse-step')).toBeTruthy();
  });

  it('completing a step calls completeStep and advances', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    fireEvent.click(screen.getByText('Complete Discovery'));

    expect(mockCompleteStep).toHaveBeenCalledWith('discovery');
    // Should advance to step 2
    expect(screen.getByTestId('pulse-step')).toBeTruthy();
  });

  it('completing all steps shows completion screen', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={1} />);

    fireEvent.click(screen.getByText('Complete Pulse'));

    expect(mockCompleteStep).toHaveBeenCalledWith('pulse');
    expect(screen.getByTestId('onboarding-complete')).toBeTruthy();
  });

  it('Skip all calls dismiss and onComplete', async () => {
    const onComplete = vi.fn();

    render(<OnboardingFlow onComplete={onComplete} initialStep={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }));

    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('Skip calls skipStep with current step and advances', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(mockSkipStep).toHaveBeenCalledWith('discovery');
  });

  it('Skip setup on welcome calls dismiss and onComplete', async () => {
    const onComplete = vi.fn();

    render(<OnboardingFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByText('Skip setup'));

    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  // --- Auto-skip Pulse when no agents ---

  it('auto-skips pulse step when agents list is empty', async () => {
    mockAgentPaths.mockReturnValue({
      data: { agents: [] },
      isLoading: false,
    });

    render(<OnboardingFlow onComplete={vi.fn()} initialStep={1} />);

    await waitFor(() => {
      expect(mockCompleteStep).toHaveBeenCalledWith('pulse');
    });
    // Should show completion screen (pulse was last step)
    expect(screen.getByTestId('onboarding-complete')).toBeTruthy();
  });

  it('renders pulse step when agents exist', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={1} />);

    expect(screen.getByTestId('pulse-step')).toBeTruthy();
    expect(mockCompleteStep).not.toHaveBeenCalledWith('pulse');
  });
});
