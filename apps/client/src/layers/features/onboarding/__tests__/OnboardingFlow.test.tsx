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

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockCompleteStep = vi.fn();
const mockSkipStep = vi.fn();
const mockDismiss = vi.fn().mockResolvedValue(undefined);
const mockStartOnboarding = vi.fn();
const mockConfig = {
  agents: {
    defaultDirectory: '~/.dork/agents',
    defaultAgent: 'dorkbot',
  },
};

vi.mock('../model/use-onboarding', () => ({
  useOnboarding: vi.fn(() => ({
    shouldShowOnboarding: true,
    state: {
      completedSteps: [],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
    },
    config: mockConfig,
    completeStep: mockCompleteStep,
    skipStep: mockSkipStep,
    dismiss: mockDismiss,
    startOnboarding: mockStartOnboarding,
  })),
}));

// Mock useMeshAgentPaths — default: returns one agent
const mockAgentPaths = vi.fn().mockReturnValue({
  data: {
    agents: [{ id: 'agent-1', name: 'Test Agent', projectPath: '/test/project', icon: '🤖' }],
  },
  isLoading: false,
});

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => mockAgentPaths(),
}));

// Mock step components to isolate OnboardingFlow navigation logic
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
      <button onClick={onSkip}>Skip setup</button>
    </div>
  ),
}));

vi.mock('../ui/MeetDorkBotStep', () => ({
  MeetDorkBotStep: ({ onStepComplete }: { onStepComplete: () => void }) => (
    <div data-testid="meet-dorkbot-step">
      <button onClick={onStepComplete}>Complete Meet DorkBot</button>
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

vi.mock('../ui/TaskTemplatesStep', () => ({
  TaskTemplatesStep: ({ onStepComplete }: { onStepComplete: () => void }) => (
    <div data-testid="tasks-step">
      <button onClick={onStepComplete}>Complete Tasks</button>
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
        agents: [{ id: 'agent-1', name: 'Test Agent', projectPath: '/test/project', icon: '🤖' }],
      },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  // --- Flow: Welcome -> Requirements -> MeetDorkBot -> Discovery -> Tasks -> Complete ---

  it('renders welcome step initially', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    expect(screen.getByTestId('welcome-step')).toBeTruthy();
  });

  it('calls startOnboarding on mount', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    expect(mockStartOnboarding).toHaveBeenCalled();
  });

  it('Get Started advances to requirements step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    fireEvent.click(screen.getByText('Get Started'));

    expect(screen.getByTestId('requirements-step')).toBeTruthy();
  });

  it('requirements Continue advances to meet-dorkbot step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={-1} />);

    fireEvent.click(screen.getByText('Continue'));

    expect(screen.getByTestId('meet-dorkbot-step')).toBeTruthy();
  });

  it('full flow: Welcome -> Requirements -> MeetDorkBot', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);

    fireEvent.click(screen.getByText('Get Started'));
    expect(screen.getByTestId('requirements-step')).toBeTruthy();

    fireEvent.click(screen.getByText('Continue'));
    expect(screen.getByTestId('meet-dorkbot-step')).toBeTruthy();
  });

  it('meet-dorkbot is step 0 (first numbered step)', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    expect(screen.getByTestId('meet-dorkbot-step')).toBeTruthy();
  });

  it('shows step indicator dots on step pages', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    // Three step indicators rendered as rounded-full elements (meet-dorkbot, discovery, tasks)
    const { container } = render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);
    const dots = container.querySelectorAll('.rounded-full');
    expect(dots.length).toBeGreaterThanOrEqual(3);
  });

  it('shows Skip and Skip all buttons on step pages', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip all' })).toBeTruthy();
  });

  it('initialStep=1 renders the discovery step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={1} />);

    expect(screen.getByTestId('discovery-step')).toBeTruthy();
  });

  it('initialStep=2 renders the tasks step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={2} />);

    expect(screen.getByTestId('tasks-step')).toBeTruthy();
  });

  it('completing meet-dorkbot calls completeStep and advances to discovery', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    fireEvent.click(screen.getByText('Complete Meet DorkBot'));

    expect(mockCompleteStep).toHaveBeenCalledWith('meet-dorkbot');
    expect(screen.getByTestId('discovery-step')).toBeTruthy();
  });

  it('completing discovery advances to tasks step', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={1} />);

    fireEvent.click(screen.getByText('Complete Discovery'));

    expect(mockCompleteStep).toHaveBeenCalledWith('discovery');
    expect(screen.getByTestId('tasks-step')).toBeTruthy();
  });

  it('completing all steps shows completion screen', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={2} />);

    fireEvent.click(screen.getByText('Complete Tasks'));

    expect(mockCompleteStep).toHaveBeenCalledWith('tasks');
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

    expect(mockSkipStep).toHaveBeenCalledWith('meet-dorkbot');
  });

  it('skipping meet-dorkbot marks it skipped and advances to discovery', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={0} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(mockSkipStep).toHaveBeenCalledWith('meet-dorkbot');
    expect(screen.getByTestId('discovery-step')).toBeTruthy();
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

  // --- Auto-skip Tasks when no agents ---

  it('auto-skips tasks step when agents list is empty', async () => {
    mockAgentPaths.mockReturnValue({
      data: { agents: [] },
      isLoading: false,
    });

    render(<OnboardingFlow onComplete={vi.fn()} initialStep={2} />);

    await waitFor(() => {
      expect(mockCompleteStep).toHaveBeenCalledWith('tasks');
    });
    // Should show completion screen (tasks was last step)
    expect(screen.getByTestId('onboarding-complete')).toBeTruthy();
  });

  it('renders tasks step when agents exist', () => {
    render(<OnboardingFlow onComplete={vi.fn()} initialStep={2} />);

    expect(screen.getByTestId('tasks-step')).toBeTruthy();
    expect(mockCompleteStep).not.toHaveBeenCalledWith('tasks');
  });

  // --- Post-onboarding navigation ---

  it('navigates to /session with default agent dir after completing onboarding', async () => {
    const onComplete = vi.fn();

    render(<OnboardingFlow onComplete={onComplete} initialStep={2} />);

    // Complete the last step to show completion screen
    fireEvent.click(screen.getByText('Complete Tasks'));
    // Click the Finish button on the completion screen
    fireEvent.click(screen.getByText('Finish'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '~/.dork/agents/dorkbot' },
    });
    expect(onComplete).toHaveBeenCalled();
  });

  it('uses config values for post-onboarding navigation (not hardcoded)', async () => {
    // Override config with custom agent settings
    const { useOnboarding } = await import('../model/use-onboarding');
    vi.mocked(useOnboarding).mockReturnValue({
      shouldShowOnboarding: true,
      state: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
      },
      config: {
        agents: {
          defaultDirectory: '/custom/agents',
          defaultAgent: 'my-agent',
        },
      } as never,
      completeStep: mockCompleteStep,
      skipStep: mockSkipStep,
      dismiss: mockDismiss,
      startOnboarding: mockStartOnboarding,
      isLoading: false,
      isOnboardingComplete: false,
      isOnboardingDismissed: false,
    });

    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} initialStep={2} />);

    fireEvent.click(screen.getByText('Complete Tasks'));
    fireEvent.click(screen.getByText('Finish'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/custom/agents/my-agent' },
    });
  });
});
