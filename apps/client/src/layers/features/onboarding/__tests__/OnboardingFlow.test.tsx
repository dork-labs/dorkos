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
import { mergeDialogSearch } from '@/layers/shared/model';
import { onboardingStageSearchSchema } from '../model/onboarding-stage';

const mockDismiss = vi.fn().mockResolvedValue(undefined);
const mockStartOnboarding = vi.fn();

vi.mock('../model/use-onboarding', () => ({
  useOnboarding: vi.fn(() => ({
    dismiss: mockDismiss,
    startOnboarding: mockStartOnboarding,
  })),
}));

// `dismiss()` hides the flow AND the getting-started card for good, so this
// toast is the only visible route back into setup. Mocked (not asserted through
// a real Toaster) so the assertion reads the exact description text.
const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock('sonner', () => ({ toast: mockToast }));

// Mock the surfaces to isolate OnboardingFlow's stage navigation.
vi.mock('../ui/SystemRequirementsStep', () => ({
  SystemRequirementsStep: ({ onContinue }: { onContinue: () => void }) => (
    <div data-testid="requirements-step">
      <button onClick={onContinue}>Continue</button>
    </div>
  ),
}));

vi.mock('../ui/WelcomeStep', () => ({
  WelcomeStep: ({
    onGetStarted,
    onSkipAll,
  }: {
    onGetStarted: () => void;
    onSkipAll: () => void;
  }) => (
    <div data-testid="welcome-step">
      <button onClick={onGetStarted}>Get Started</button>
      <button onClick={onSkipAll}>Skip all setup welcome</button>
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
// The dialog params are merged in the way every real leaf route merges them
// (`mergeDialogSearch`), so the skip-all toast's Settings deep link survives
// validation here exactly as it does in the app.
type HistoryActionType = 'PUSH' | 'REPLACE' | 'GO' | 'FORWARD' | 'BACK';

function buildHarness(initialUrl: string, onComplete: () => void) {
  const rootRoute = createRootRoute({ staticData: { header: null } });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(mergeDialogSearch(onboardingStageSearchSchema)),
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
  const readSettingsTab = () => (router.state.location.search as { settings?: string }).settings;

  return { router, history, actions, Wrapper, readStage, readSettingsTab };
}

async function renderFlow(initialUrl = '/', onComplete = vi.fn()) {
  const harness = buildHarness(initialUrl, onComplete);
  render(<harness.Wrapper />);
  await waitFor(() => expect(harness.router.state.status).toBe('idle'));
  return { ...harness, onComplete };
}

/**
 * Assert the skip-all toast fired and still names the route back into setup.
 * Deleting the `toast(...)` call must turn both callers red — it is the only
 * signpost a dismissed user gets.
 */
async function expectWayBackToast() {
  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      'Setup skipped',
      expect.objectContaining({
        description: expect.stringContaining('Settings → Preferences'),
      })
    )
  );
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

  // ── The requirements stage is not a dead end (DOR-481) ─────
  //
  // The nav bar is a sibling of the step, not something the step renders when
  // the scan succeeds — so these hold whatever the runtime probe returns. The
  // zero-runtime rendering itself is browser-verified: jsdom loads no CSS, so
  // it cannot speak to whether the controls are actually reachable on screen.

  it('the requirements step offers Back and Skip all setup', async () => {
    await renderFlow('/?onboarding=requirements');
    expect(screen.getByTestId('requirements-step')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip all setup' })).toBeTruthy();
  });

  it('Skip all setup on requirements dismisses, names the way back, and completes', async () => {
    const onComplete = vi.fn();
    await renderFlow('/?onboarding=requirements', onComplete);
    fireEvent.click(screen.getByRole('button', { name: 'Skip all setup' }));
    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    await expectWayBackToast();
  });

  it('Back on requirements returns to the welcome screen', async () => {
    const harness = await renderFlow('/');
    fireEvent.click(screen.getByText('Get Started'));
    await screen.findByTestId('requirements-step');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('welcome-step')).toBeTruthy();
    await waitFor(() => expect(harness.readStage()).toBe('welcome'));
  });

  it('the conversation nav bar names its whole-flow exit honestly, and has no step dots', async () => {
    await renderFlow('/');
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByTestId('conversation');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip all setup' })).toBeTruthy();
    // The ambiguous wordings that read as "skip this step" (DOR-472) are gone.
    expect(screen.queryByText('Skip', { exact: true })).toBeNull();
    expect(screen.queryByText('Skip setup', { exact: true })).toBeNull();
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

  it('Skip all setup in the conversation dismisses, names the way back, and completes', async () => {
    const onComplete = vi.fn();
    await renderFlow('/', onComplete);
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByTestId('conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Skip all setup' }));
    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    await expectWayBackToast();
  });

  it('Skip all setup on welcome dismisses, names the way back, and completes', async () => {
    const onComplete = vi.fn();
    await renderFlow('/', onComplete);
    fireEvent.click(screen.getByText('Skip all setup welcome'));
    expect(mockDismiss).toHaveBeenCalled();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    await expectWayBackToast();
  });

  it("the skip-all toast's action deep-links Settings to the Replay setup control", async () => {
    const harness = await renderFlow('/');
    fireEvent.click(screen.getByText('Skip all setup welcome'));
    await expectWayBackToast();

    const [, options] = mockToast.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    // Labelled for the control it lands on, not for the dialog it opens.
    expect(options.action.label).toBe('Replay setup');
    act(() => options.action.onClick());
    // `?settings=preferences` is what actually selects the tab holding "Replay
    // setup" — landing on Appearance would be worse than the text alone.
    await waitFor(() => expect(harness.readSettingsTab()).toBe('preferences'));
  });
});
