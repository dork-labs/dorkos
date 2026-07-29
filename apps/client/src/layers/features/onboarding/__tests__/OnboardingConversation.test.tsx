/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { ROLE_CANON } from '@dorkos/shared/profile-recommendations';
import { useAgentBirthStore, useAppStore } from '@/layers/shared/model';

// Instant reveals so the scripted lines land synchronously.
vi.mock('motion/react', () => ({ useReducedMotion: () => true }));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

const mockMutateAsync = vi.fn().mockResolvedValue({});
vi.mock('@/layers/entities/agent', () => ({
  useUpdateAgent: () => ({ mutateAsync: mockMutateAsync }),
}));

// The registered ABSOLUTE path (never the literal tilde) — the client can stream it.
const REGISTERED_DIR = '/home/kai/.dork/agents/dorkbot';
vi.mock('@/layers/entities/config', () => ({
  useDefaultAgentSession: () => ({ defaultAgentDir: REGISTERED_DIR, startSession: vi.fn() }),
}));

const mockCompleteStep = vi.fn();
const mockSkipStep = vi.fn();
const mockCompleteOnboarding = vi.fn();
/**
 * The ABSOLUTE agents directory the server reports — `GET /api/config` resolves
 * `agents.defaultDirectory` against the DorkOS data directory in use, so a
 * literal `~/.dork/agents` never reaches the client (DOR-662). `undefined`
 * stands in for the moment before the config query has landed.
 */
let mockOnboardingConfig:
  | { agents: { defaultDirectory: string; defaultAgent: string } }
  | undefined;
vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({
    config: mockOnboardingConfig,
    completeStep: mockCompleteStep,
    skipStep: mockSkipStep,
    completeOnboarding: mockCompleteOnboarding,
  }),
}));

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

const mockStartScan = vi.fn();
vi.mock('@/layers/entities/discovery', () => ({
  useDiscoveryScan: () => ({ startScan: mockStartScan }),
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

vi.mock('@/layers/entities/mesh', () => ({ useRegisterAgent: () => ({ mutate: vi.fn() }) }));

vi.mock('@/layers/features/chat', () => ({
  MessageItem: ({ message }: { message: { content: string } }) => (
    <div data-testid="msg">{message.content}</div>
  ),
  resolveMessageAuthor: () => ({ kind: 'agent', id: 'dorkbot', displayName: 'DorkBot' }),
  TypingDots: () => <div data-testid="typing" />,
  FirstLight: () => <div data-testid="first-light" />,
  ChatInput: ({
    value,
    onChange,
    onSubmit,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    placeholder?: string;
  }) => (
    <div>
      <input
        data-testid="composer"
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button data-testid="send" onClick={onSubmit}>
        send
      </button>
    </div>
  ),
}));

vi.mock('@/layers/features/agent-hub', () => ({
  PersonalityPicker: ({ onTraitsChange }: { onTraitsChange: (t: unknown) => void }) => (
    <button
      data-testid="pick-personality"
      onClick={() =>
        onTraitsChange({ verbosity: 3, autonomy: 3, chaos: 3, creativity: 3, humor: 5, spice: 3 })
      }
    >
      pick
    </button>
  ),
}));

vi.mock('@/layers/shared/lib', async (importActual) => ({
  ...(await importActual<typeof import('@/layers/shared/lib')>()),
  fireCelebration: vi.fn().mockResolvedValue(vi.fn()),
}));

import { OnboardingConversation } from '../ui/OnboardingConversation';

/** Advance from first light through the personality beat into the profile beat. */
async function reachProfile() {
  await screen.findByTestId('pick-personality');
  fireEvent.click(screen.getByTestId('confirm-personality'));
  await screen.findByTestId('confirm-profile');
}

/** Advance from first light through personality and profile into discovery. */
async function reachDiscovery() {
  await reachProfile();
  fireEvent.click(screen.getByTestId('skip-profile'));
  await screen.findByText('Sure, look around');
}

describe('OnboardingConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnboardingConfig = {
      agents: { defaultDirectory: '/home/kai/.dork/agents', defaultAgent: 'dorkbot' },
    };
    useAgentBirthStore.setState({ records: {} });
    useAppStore.setState({ requestedTour: null });
  });

  afterEach(() => cleanup());

  it('shows first light, then reveals DorkBot arriving with the composer disabled', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    expect(screen.getByTestId('first-light')).toBeTruthy();

    // The scripted arrival lands and the personality widget appears.
    await screen.findByTestId('pick-personality');
    expect(screen.getByText(DORKBOT_ONBOARDING_LINES.arrival[0])).toBeTruthy();
    // Composer is a disabled stand-in until Beat 3 — no real input yet.
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(screen.getByText(DORKBOT_ONBOARDING_LINES.composerSetupPlaceholder)).toBeTruthy();
  });

  it('PATCHes the chosen traits to the DorkBot manifest and completes the step', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await screen.findByTestId('pick-personality');

    fireEvent.click(screen.getByTestId('pick-personality'));
    fireEvent.click(screen.getByTestId('confirm-personality'));
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        path: '/home/kai/.dork/agents/dorkbot',
        updates: {
          traits: { verbosity: 3, autonomy: 3, chaos: 3, creativity: 3, humor: 5, spice: 3 },
        },
      })
    );
    expect(mockCompleteStep).toHaveBeenCalledWith('meet-dorkbot');
  });

  // This save is a WRITE, and the path it writes to used to fall back to a
  // literal `~/.dork/agents` — which the server expands against the operator's
  // real home, so from a dev tree it edited the DorkBot of their live install
  // (DOR-662). With no configured directory yet there is no honest target, so
  // the save fails visibly instead of guessing one.
  it('writes nothing until the server has said where DorkBot lives', async () => {
    mockOnboardingConfig = undefined;
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await screen.findByTestId('pick-personality');

    fireEvent.click(screen.getByTestId('confirm-personality'));

    await waitFor(() => expect(screen.getByTestId('pick-personality')).toBeTruthy());
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockCompleteStep).not.toHaveBeenCalled();
  });

  it('"Skip this step" moves past personality into the profile beat, saving nothing', async () => {
    const onComplete = vi.fn();
    render(<OnboardingConversation onComplete={onComplete} />);
    await screen.findByTestId('pick-personality');

    fireEvent.click(screen.getByTestId('skip-personality'));

    // The profile beat is on screen; the personality card is gone.
    expect(await screen.findByTestId('confirm-profile')).toBeTruthy();
    expect(screen.queryByTestId('pick-personality')).toBeNull();
    expect(screen.getByText(DORKBOT_ONBOARDING_LINES.personalitySkip)).toBeTruthy();
    // No traits were written, and the conversation was not ended.
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockSkipStep).toHaveBeenCalledWith('meet-dorkbot');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('the profile beat shows the canon chips, the question, and the privacy line', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachProfile();

    // Both authored lines landed in the same beat.
    expect(
      screen.getByText((text) => text.includes('what kind of work will we be doing together'))
    ).toBeTruthy();
    expect(screen.getByText((text) => text.includes('stays on this machine'))).toBeTruthy();
    // The first six canon roles render as chips.
    for (const label of ROLE_CANON.slice(0, 6).map((r) => r.label)) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // Nothing selected yet, so the confirm chip waits.
    expect(screen.getByTestId('confirm-profile')).toHaveProperty('disabled', true);
  });

  it(`"That's us" saves the picked roles as { profile: { roles } } and moves to discovery`, async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachProfile();

    fireEvent.click(screen.getByRole('button', { name: 'Hiring people' }));
    fireEvent.click(screen.getByTestId('confirm-profile'));

    await waitFor(() => expect(mockSaveRoles).toHaveBeenCalledWith(['hiring']));
    expect(mockCompleteStep).toHaveBeenCalledWith('profile');
    // DorkBot speaks one authored suggestion line for hiring, then discovery opens.
    expect(await screen.findByText('Sure, look around')).toBeTruthy();
    expect(screen.getByText((text) => text.includes('Gmail and Greenhouse'))).toBeTruthy();
  });

  it('free text adds a role via "Something else"', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachProfile();

    fireEvent.click(screen.getByRole('button', { name: 'Something else' }));
    const input = screen.getByLabelText('Something else: describe your work');
    fireEvent.change(input, { target: { value: 'beekeeping' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The typed role appears as a selected chip and enables the confirm chip.
    expect(screen.getByRole('button', { name: 'beekeeping' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-profile'));
    await waitFor(() => expect(mockSaveRoles).toHaveBeenCalledWith(['beekeeping']));
  });

  it('"Skip this" writes nothing and records the skip forever', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachProfile();

    fireEvent.click(screen.getByTestId('skip-profile'));

    expect(await screen.findByText('Sure, look around')).toBeTruthy();
    expect(mockSaveRoles).not.toHaveBeenCalled();
    expect(mockSkipStep).toHaveBeenCalledWith('profile');
    expect(screen.getByText(DORKBOT_ONBOARDING_LINES.profileSkip)).toBeTruthy();
  });

  it('does not scan before consent, and starts the scan on consent', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachDiscovery();

    // Consent-first: no scan has run just by reaching the discovery beat.
    expect(mockStartScan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Sure, look around'));
    expect(mockStartScan).toHaveBeenCalledTimes(1);
  });

  it('decline skips discovery and reaches the handoff composer', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachDiscovery();

    fireEvent.click(screen.getByText('Not now'));

    expect(mockSkipStep).toHaveBeenCalledWith('discovery');
    // The real composer appears at the handoff beat.
    const composer = await screen.findByTestId('composer');
    expect(composer).toBeTruthy();
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
  });

  it('"Show me around" ends onboarding and hands off to the general tour', async () => {
    const onComplete = vi.fn();
    render(<OnboardingConversation onComplete={onComplete} />);
    await reachDiscovery();
    fireEvent.click(screen.getByText('Not now'));
    await screen.findByText('Show me around');

    fireEvent.click(screen.getByText('Show me around'));

    // No session is created; the flow closes and the tour is requested instead.
    expect(useAgentBirthStore.getState().records).toEqual({});
    expect(useAppStore.getState().requestedTour).toBe('general');
    expect(onComplete).toHaveBeenCalled();
  });

  it('the first message registers a first-message birth record and navigates into a session', async () => {
    const onComplete = vi.fn();
    render(<OnboardingConversation onComplete={onComplete} />);
    await reachDiscovery();
    fireEvent.click(screen.getByText('Not now'));
    await screen.findByTestId('composer');

    fireEvent.change(screen.getByTestId('composer'), {
      target: { value: 'help me set up a project' },
    });
    fireEvent.click(screen.getByTestId('send'));

    const records = Object.values(useAgentBirthStore.getState().records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'first-message',
      kickoffMessage: 'help me set up a project',
      // The REGISTERED absolute path, never the unstreamable literal tilde.
      path: REGISTERED_DIR,
    });
    expect(records[0].path).not.toContain('~');

    const sessionId = Object.keys(useAgentBirthStore.getState().records)[0];
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: REGISTERED_DIR, session: sessionId },
    });
    const navDir = mockNavigate.mock.calls[0][0].search.dir as string;
    expect(navDir).not.toContain('~');
    expect(onComplete).toHaveBeenCalled();
  });
});
