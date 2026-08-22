/**
 * @vitest-environment jsdom
 *
 * DOR-472 — what "skip" means at each level of onboarding.
 *
 * Two affordances, two different consequences, and the regression guarded here
 * is that they never trade places: a per-beat skip advances one beat with the
 * flow still on screen, while the nav bar's "Skip all setup" ends onboarding.
 * So this mounts the REAL conversation inside the REAL flow — only the two
 * pre-conversation screens and the transport-backed leaves are mocked — and
 * asserts what is on screen afterwards, never that a handler fired: a fired
 * callback cannot tell "advanced one beat" from "dismissed everything".
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { onboardingStageSearchSchema } from '../model/onboarding-stage';

// Instant reveals so each beat's scripted lines land synchronously.
vi.mock('motion/react', () => ({ useReducedMotion: () => true }));

const mockDismiss = vi.fn().mockResolvedValue(undefined);
const mockStartOnboarding = vi.fn();
const mockCompleteStep = vi.fn();
const mockSkipStep = vi.fn();
const mockCompleteOnboarding = vi.fn();

vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({
    config: { agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' } },
    dismiss: mockDismiss,
    startOnboarding: mockStartOnboarding,
    completeStep: mockCompleteStep,
    skipStep: mockSkipStep,
    completeOnboarding: mockCompleteOnboarding,
  }),
}));

/** The roles write — must stay untouched when the profile beat is skipped. */
const mockSaveRoles = vi.fn().mockResolvedValue(undefined);
vi.mock('../model/use-profile', () => ({
  useProfile: () => ({
    roles: [],
    rolePromptDismissedAt: null,
    isLoading: false,
    saveRoles: mockSaveRoles,
    dismissRolePrompt: vi.fn(),
  }),
}));

/** The traits write — must stay untouched when the personality beat is skipped. */
const mockSaveTraits = vi.fn().mockResolvedValue({});
/** DorkBot's workspace, and the system-agent manifest the registry returns for it. */
const DORKBOT_PATH = '/home/kai/.dork/agents/dorkbot';
vi.mock('@/layers/entities/agent', () => ({
  PersonalityPicker: () => <div data-testid="personality-picker" />,
  useUpdateAgent: () => ({ mutateAsync: mockSaveTraits }),
  useResolvedAgents: () => ({
    data: { [DORKBOT_PATH]: { id: '01JQZ8XKF3M0000000000DBOT', name: 'dorkbot', isSystem: true } },
  }),
}));

vi.mock('@/layers/entities/config', () => ({
  // The session DIRECTORY only — the face comes from the system-agent lookup.
  useDefaultAgentSession: () => ({
    defaultAgentDir: '/home/kai/.dork/agents/dorkbot',
    startSession: vi.fn(),
  }),
}));

vi.mock('@/layers/entities/discovery', () => ({
  useDiscoveryScan: () => ({ startScan: vi.fn() }),
  useDiscoveryStore: () => ({
    candidates: [],
    existingAgents: [],
    isScanning: false,
    lastScanAt: null,
    error: null,
    progress: null,
  }),
  useActedPaths: () => ({ actedPaths: new Set(), markActed: vi.fn(), resetActed: vi.fn() }),
  buildRegistrationOverrides: () => ({}),
  sortCandidates: (c: unknown[]) => c,
  CandidateCard: () => null,
  BulkAddBar: () => null,
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisterAgent: () => ({ mutate: vi.fn() }),
  useMeshAgentPaths: () => ({ data: { agents: [{ projectPath: DORKBOT_PATH }] } }),
}));

// The conversation asks whether the default runtime can actually run the first
// session. Nothing here is about that, so every runtime answers ready.
vi.mock('@/layers/entities/runtime', () => ({
  PRIMARY_RUNTIME_TYPES: ['claude-code', 'codex', 'opencode'] as const,
  useRuntimeRequirements: () => ({ data: { runtimes: { 'claude-code': { state: 'ready' } } } }),
  selectRuntimeReadiness: () => ({ state: 'ready' }),
}));

vi.mock('../ui/NarrationMessage', () => ({
  NarrationMessage: ({ message }: { message: { content: string } }) => (
    <div data-testid="msg">{message.content}</div>
  ),
}));

vi.mock('@/layers/features/chat', () => ({
  resolveMessageAuthor: () => ({ kind: 'agent', id: 'dorkbot', displayName: 'DorkBot' }),
  TypingDots: () => <div data-testid="typing" />,
  FirstLight: () => <div data-testid="first-light" />,
}));

vi.mock('@/layers/features/composer', () => ({
  Composer: { Input: () => <div data-testid="composer" /> },
}));

// The two screens ahead of the conversation are not under test here; stubbing
// them keeps the harness free of the runtime-requirements query.
vi.mock('../ui/SystemRequirementsStep', () => ({
  SystemRequirementsStep: ({ onContinue }: { onContinue: () => void }) => (
    <div data-testid="requirements-step">
      <button onClick={onContinue}>Continue</button>
    </div>
  ),
}));

vi.mock('../ui/WelcomeStep', () => ({
  WelcomeStep: ({ onGetStarted }: { onGetStarted: () => void }) => (
    <div data-testid="welcome-step">
      <button onClick={onGetStarted}>Get Started</button>
    </div>
  ),
}));

import { OnboardingFlow } from '../ui/OnboardingFlow';

/**
 * Stand-in for the app shell: it swaps the overlay out for the app the moment
 * `onComplete` fires, exactly as `setOnboardingHiddenForSession(true)` does. That
 * makes "the flow is still on screen" a real measurement — a flow that ended
 * leaves the app stub behind instead of a beat.
 */
function FlowHost({ onComplete }: { onComplete: () => void }) {
  const [ended, setEnded] = useState(false);
  if (ended) return <div data-testid="app-stub" />;
  return (
    <OnboardingFlow
      onComplete={() => {
        setEnded(true);
        onComplete();
      }}
    />
  );
}

/** Mount the flow at a stage, inside a router that validates the real schema. */
async function renderFlow(initialUrl: string) {
  const onComplete = vi.fn();
  const rootRoute = createRootRoute({ staticData: { header: null } });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(onboardingStageSearchSchema),
    component: () => <FlowHost onComplete={onComplete} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe('idle'));
  const readStage = () => (router.state.location.search as { onboarding?: string }).onboarding;
  return { onComplete, readStage };
}

/** The flow is still on screen: its nav bar is up and the app has not taken over. */
function expectFlowStillMounted() {
  expect(screen.queryByTestId('app-stub')).toBeNull();
  expect(screen.getByRole('button', { name: 'Skip all setup' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
}

describe('onboarding skip semantics (DOR-472)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('skipping the personality beat lands on the profile beat, flow still mounted', async () => {
    const { onComplete, readStage } = await renderFlow('/?onboarding=conversation');
    await screen.findByTestId('skip-personality');

    fireEvent.click(screen.getByTestId('skip-personality'));

    // The next beat is what is on screen: the role question's chips.
    expect(await screen.findByTestId('confirm-profile')).toBeTruthy();
    expect(screen.getByTestId('skip-profile')).toBeTruthy();
    // The beat that was skipped is gone, and the flow around it is not.
    expect(screen.queryByTestId('skip-personality')).toBeNull();
    expectFlowStillMounted();
    expect(readStage()).toBe('conversation');
    // Nothing was dismissed, and no personality was written on the way past.
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(mockSaveTraits).not.toHaveBeenCalled();
    expect(mockSkipStep).toHaveBeenCalledWith('meet-dorkbot');
  });

  it('skipping every beat in turn ends on the handoff, still inside the flow', async () => {
    const { onComplete } = await renderFlow('/?onboarding=conversation');
    await screen.findByTestId('skip-personality');

    fireEvent.click(screen.getByTestId('skip-personality'));
    fireEvent.click(await screen.findByTestId('skip-profile'));
    fireEvent.click(await screen.findByText('Not now'));

    // Last beat: the live composer, reached without ever leaving onboarding.
    expect(await screen.findByTestId('composer')).toBeTruthy();
    expect(screen.getByText('Show me around')).toBeTruthy();
    expectFlowStillMounted();
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    // Reaching the handoff is the authoritative "onboarding is done" write, so
    // a person who skipped every beat still gets the getting-started card.
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(mockSkipStep).toHaveBeenCalledWith('meet-dorkbot');
    expect(mockSkipStep).toHaveBeenCalledWith('profile');
    expect(mockSkipStep).toHaveBeenCalledWith('discovery');
    // Skipping the profile beat wrote nothing to the profile.
    expect(mockSaveRoles).not.toHaveBeenCalled();
  });

  it('a skipped beat can be taken again: Back then Continue restarts the conversation', async () => {
    await renderFlow('/?onboarding=conversation');
    await screen.findByTestId('skip-personality');
    fireEvent.click(screen.getByTestId('skip-personality'));
    fireEvent.click(await screen.findByTestId('skip-profile'));
    await screen.findByText('Sure, look around');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByText('Continue'));

    // The conversation replays from the top, so the personality beat is offered
    // again — the flow never traps a person behind a step they skipped.
    expect(await screen.findByTestId('personality-picker')).toBeTruthy();
    expect(screen.getByTestId('confirm-personality')).toBeTruthy();
  });

  it('Skip all setup is the only control that ends the flow', async () => {
    const { onComplete } = await renderFlow('/?onboarding=conversation');
    await screen.findByTestId('skip-personality');

    fireEvent.click(screen.getByRole('button', { name: 'Skip all setup' }));

    // The contrast case: this one really does end onboarding — the app takes
    // over and no beat is left on screen.
    expect(await screen.findByTestId('app-stub')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip all setup' })).toBeNull();
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});
