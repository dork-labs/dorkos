/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { useAgentBirthStore } from '@/layers/shared/model';

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
vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({
    config: { agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' } },
    completeStep: mockCompleteStep,
    skipStep: mockSkipStep,
    completeOnboarding: mockCompleteOnboarding,
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
  findMatchingPreset: () => ({ id: 'hotshot' }),
}));

vi.mock('@/layers/shared/lib', async (importActual) => ({
  ...(await importActual<typeof import('@/layers/shared/lib')>()),
  fireCelebration: vi.fn().mockResolvedValue(vi.fn()),
}));

import { OnboardingConversation } from '../ui/OnboardingConversation';

/** Advance from first light through the personality beat into discovery. */
async function reachDiscovery() {
  await screen.findByTestId('pick-personality');
  fireEvent.click(screen.getByTestId('confirm-personality'));
  await screen.findByText('Sure, look around');
}

describe('OnboardingConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentBirthStore.setState({ records: {} });
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

  it('posts a voice sample on personality change and PATCHes traits to the DorkBot manifest', async () => {
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await screen.findByTestId('pick-personality');

    fireEvent.click(screen.getByTestId('pick-personality'));
    // A sample bubble appears (more than just the three scripted lines).
    await waitFor(() => expect(screen.getAllByTestId('msg').length).toBeGreaterThan(3));

    fireEvent.click(screen.getByTestId('confirm-personality'));
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        path: '~/.dork/agents/dorkbot',
        updates: {
          traits: { verbosity: 3, autonomy: 3, chaos: 3, creativity: 3, humor: 5, spice: 3 },
        },
      })
    );
    expect(mockCompleteStep).toHaveBeenCalledWith('meet-dorkbot');
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
