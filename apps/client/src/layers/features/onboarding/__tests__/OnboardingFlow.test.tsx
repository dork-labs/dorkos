/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { onboardingStageSearchSchema } from '../model/onboarding-stage';

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

// ── Router harness ───────────────────────────────────────────
//
// OnboardingFlow now syncs its stage to the `?onboarding=` search param, so it
// must render inside a router. A single index route validates the same schema
// the real root route uses, so `useSearch`/`useNavigate` behave as in the app.
type HistoryActionType = 'PUSH' | 'REPLACE' | 'GO' | 'FORWARD' | 'BACK';

function buildHarness(initialUrl: string, onComplete: () => void) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(onboardingStageSearchSchema),
    component: () => <OnboardingFlow onComplete={onComplete} />,
  });
  const routeTree = rootRoute.addChildren([indexRoute]);
  const history = createMemoryHistory({ initialEntries: [initialUrl] });
  const router = createRouter({ routeTree, history });

  const actions: HistoryActionType[] = [];
  history.subscribe(({ action }) => actions.push(action.type));

  function Wrapper() {
    return <RouterProvider router={router} />;
  }
  const readStage = () => (router.state.location.search as { onboarding?: string }).onboarding;

  return { router, history, actions, Wrapper, readStage };
}

async function renderFlow(initialUrl = '/', onComplete = vi.fn()) {
  const harness = buildHarness(initialUrl, onComplete);
  render(<harness.Wrapper />);
  await waitFor(() => expect(harness.router.state.status).toBe('idle'));
  return { ...harness, onComplete };
}

describe('OnboardingFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the welcome step and anchors the stage param to welcome', async () => {
    const harness = await renderFlow('/');
    expect(screen.getByTestId('welcome-step')).toBeTruthy();
    await waitFor(() => expect(harness.readStage()).toBe('welcome'));
    // Initialization replaces rather than pushes — it is not a navigable step.
    expect(harness.actions).toContain('REPLACE');
    expect(harness.actions).not.toContain('PUSH');
  });

  it('calls startOnboarding once on mount', async () => {
    await renderFlow('/');
    expect(mockStartOnboarding).toHaveBeenCalledTimes(1);
  });

  it('Get Started advances to requirements and updates the param', async () => {
    const harness = await renderFlow('/');
    fireEvent.click(screen.getByText('Get Started'));
    expect(await screen.findByTestId('requirements-step')).toBeTruthy();
    await waitFor(() => expect(harness.readStage()).toBe('requirements'));
  });

  it('Continue advances from requirements into the conversation', async () => {
    const harness = await renderFlow('/');
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(await screen.findByText('Continue'));
    expect(await screen.findByTestId('conversation')).toBeTruthy();
    await waitFor(() => expect(harness.readStage()).toBe('conversation'));
  });

  it('refresh restores the stage from the param (deep-link is refresh-safe)', async () => {
    await renderFlow('/?onboarding=requirements');
    expect(screen.getByTestId('requirements-step')).toBeTruthy();
  });

  it('browser back walks the stages backward', async () => {
    const harness = await renderFlow('/');
    fireEvent.click(screen.getByText('Get Started'));
    await screen.findByTestId('requirements-step');
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByTestId('conversation');

    act(() => harness.history.back());
    expect(await screen.findByTestId('requirements-step')).toBeTruthy();

    act(() => harness.history.back());
    expect(await screen.findByTestId('welcome-step')).toBeTruthy();
  });

  it('the conversation nav bar has Back and Skip setup, and no step dots', async () => {
    await renderFlow('/');
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByTestId('conversation');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip setup' })).toBeTruthy();
    expect(screen.queryByText('Skip', { exact: true })).toBeNull();
  });

  it('the in-UI Back pops the forward push (no phantom history entry)', async () => {
    const harness = await renderFlow('/');
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByTestId('conversation');

    // Drain the mount/forward actions, then Back should POP, not PUSH — so a
    // later browser Back can't land on a phantom conversation entry.
    harness.actions.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('requirements-step')).toBeTruthy();
    await waitFor(() => expect(harness.readStage()).toBe('requirements'));
    expect(harness.actions).toContain('BACK');
    expect(harness.actions).not.toContain('PUSH');
  });

  it('the in-UI Back pushes to requirements when the stage was restored by refresh', async () => {
    // Landed directly on conversation (refresh/deep-link) — nothing to pop, so
    // Back pushes to requirements instead of ejecting out of the app.
    const harness = await renderFlow('/?onboarding=conversation');
    expect(screen.getByTestId('conversation')).toBeTruthy();

    harness.actions.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('requirements-step')).toBeTruthy();
    await waitFor(() => expect(harness.readStage()).toBe('requirements'));
    expect(harness.actions).toContain('PUSH');
    expect(harness.actions).not.toContain('BACK');
  });

  it('Skip setup in the conversation dismisses and completes', async () => {
    const onComplete = vi.fn();
    await renderFlow('/', onComplete);
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByTestId('conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it('Skip setup on welcome dismisses and completes', async () => {
    const onComplete = vi.fn();
    await renderFlow('/', onComplete);
    fireEvent.click(screen.getByText('Skip setup welcome'));
    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});
