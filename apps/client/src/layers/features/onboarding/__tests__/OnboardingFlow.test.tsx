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
  fireCelebration: vi.fn().mockResolvedValue(vi.fn()),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// Controllable shared discovery store — drives the conditional import step.
const mockStartScan = vi.fn();
let mockDiscoveryState: {
  candidates: unknown[];
  existingAgents: unknown[];
  isScanning: boolean;
  lastScanAt: string | null;
  progress: null;
  error: null;
} = {
  candidates: [],
  existingAgents: [],
  isScanning: false,
  lastScanAt: null,
  progress: null,
  error: null,
};
vi.mock('@/layers/entities/discovery', () => ({
  useDiscoveryScan: () => ({ startScan: mockStartScan }),
  useDiscoveryStore: () => mockDiscoveryState,
}));

const mockCompleteStep = vi.fn();
const mockSkipStep = vi.fn();
const mockDismiss = vi.fn().mockResolvedValue(undefined);
const mockStartOnboarding = vi.fn();
const mockCompleteOnboarding = vi.fn();
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
      completedAt: null,
    },
    config: mockConfig,
    completeStep: mockCompleteStep,
    skipStep: mockSkipStep,
    dismiss: mockDismiss,
    completeOnboarding: mockCompleteOnboarding,
    startOnboarding: mockStartOnboarding,
  })),
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

vi.mock('../ui/OnboardingComplete', () => ({
  OnboardingComplete: ({ onComplete }: { onComplete: () => void }) => (
    <div data-testid="onboarding-complete">
      <button onClick={onComplete}>Finish</button>
    </div>
  ),
}));

import { OnboardingFlow } from '../ui/OnboardingFlow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drive Welcome -> Requirements -> Meet DorkBot. */
function advanceToMeetDorkbot() {
  fireEvent.click(screen.getByText('Get Started'));
  fireEvent.click(screen.getByText('Continue'));
}

/** Discovery store snapshot: a completed scan that found projects. */
function withResults() {
  mockDiscoveryState = {
    candidates: [{ path: '/p' }],
    existingAgents: [],
    isScanning: false,
    lastScanAt: '2026-07-21T00:00:00Z',
    progress: null,
    error: null,
  };
}

/** Discovery store snapshot: a completed scan that found nothing. */
function withNoResults() {
  mockDiscoveryState = {
    candidates: [],
    existingAgents: [],
    isScanning: false,
    lastScanAt: '2026-07-21T00:00:00Z',
    progress: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OnboardingFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: cold store (no scan run yet).
    mockDiscoveryState = {
      candidates: [],
      existingAgents: [],
      isScanning: false,
      lastScanAt: null,
      progress: null,
      error: null,
    };
  });

  afterEach(() => {
    cleanup();
  });

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

  it('full flow: Welcome -> Requirements -> MeetDorkBot', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    expect(screen.getByTestId('meet-dorkbot-step')).toBeTruthy();
  });

  it('prefetches the project scan on reaching Meet DorkBot (cold store)', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    expect(mockStartScan).toHaveBeenCalledTimes(1);
  });

  it('does not rescan when the store is already warm', () => {
    withResults();
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    expect(mockStartScan).not.toHaveBeenCalled();
  });

  it('shows Skip and Skip all buttons on step pages', () => {
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip all' })).toBeTruthy();
  });

  it('completing Meet DorkBot shows the import step when the scan found projects', () => {
    withResults();
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();

    fireEvent.click(screen.getByText('Complete Meet DorkBot'));

    expect(mockCompleteStep).toHaveBeenCalledWith('meet-dorkbot');
    expect(screen.getByTestId('discovery-step')).toBeTruthy();
  });

  it('completing Meet DorkBot skips import and finishes when the scan found nothing', () => {
    withNoResults();
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();

    fireEvent.click(screen.getByText('Complete Meet DorkBot'));

    expect(mockCompleteStep).toHaveBeenCalledWith('meet-dorkbot');
    expect(mockSkipStep).toHaveBeenCalledWith('discovery');
    expect(mockCompleteOnboarding).toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-complete')).toBeTruthy();
    expect(screen.queryByTestId('discovery-step')).toBeNull();
  });

  it('shows a checking screen when the scan is still running, then routes on resolve', async () => {
    // Still scanning when the user finishes Meet DorkBot.
    mockDiscoveryState = {
      candidates: [],
      existingAgents: [],
      isScanning: true,
      lastScanAt: null,
      progress: null,
      error: null,
    };
    const { rerender } = render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    fireEvent.click(screen.getByText('Complete Meet DorkBot'));

    expect(screen.getByText('Checking your machine...')).toBeTruthy();

    // Scan completes with results — the flow advances to the import step.
    withResults();
    rerender(<OnboardingFlow onComplete={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('discovery-step')).toBeTruthy();
    });
  });

  it('completing the import step finishes onboarding', () => {
    withResults();
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    fireEvent.click(screen.getByText('Complete Meet DorkBot'));

    fireEvent.click(screen.getByText('Complete Discovery'));

    expect(mockCompleteStep).toHaveBeenCalledWith('discovery');
    expect(mockCompleteOnboarding).toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-complete')).toBeTruthy();
  });

  it('Skip all calls dismiss and onComplete', async () => {
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);
    advanceToMeetDorkbot();

    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }));

    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('Skip on Meet DorkBot marks it skipped and routes forward', () => {
    withResults();
    render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();

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

  it('honest step dots: only one dot when the import step is skipped', () => {
    withNoResults();
    const { container } = render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    const dots = container.querySelectorAll('.rounded-full');
    expect(dots.length).toBe(1);
  });

  it('honest step dots: two dots when the import step will show', () => {
    withResults();
    const { container } = render(<OnboardingFlow onComplete={vi.fn()} />);
    advanceToMeetDorkbot();
    const dots = container.querySelectorAll('.rounded-full');
    expect(dots.length).toBe(2);
  });

  // --- Post-onboarding navigation ---

  it('navigates to /session with default agent dir after finishing', () => {
    withNoResults();
    const onComplete = vi.fn();
    render(<OnboardingFlow onComplete={onComplete} />);
    advanceToMeetDorkbot();

    fireEvent.click(screen.getByText('Complete Meet DorkBot'));
    fireEvent.click(screen.getByText('Finish'));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '~/.dork/agents/dorkbot' },
    });
    expect(onComplete).toHaveBeenCalled();
  });
});
