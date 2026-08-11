/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import { ROLE_CANON } from '@dorkos/shared/profile-recommendations';
import { useAgentBirthStore, useAppStore } from '@/layers/shared/model';
import { hashToHslColor, hashToEmoji, resolveAgentVisual } from '@/layers/shared/lib';

// Instant reveals so the scripted lines land synchronously.
vi.mock('motion/react', () => ({ useReducedMotion: () => true }));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

/**
 * DorkBot's manifest id. A ULID, because `ensureDorkBot` mints one with
 * `ulid()` — never the slug `'dorkbot'`, which is what every face on this
 * screen used to be drawn from.
 */
const DORKBOT_ID = '01JQZ8XKF3M0000000000DBOT';

/** DorkBot's own workspace path, as the mesh registry reports it. */
const DORKBOT_PATH = '/home/kai/.dork/agents/dorkbot';

/**
 * How the agents queries answer. `resolved` is the happy path; `pending` is
 * either query still out; `error` is settled-with-a-failure. The last two are
 * separate names for the same placeholder on purpose — the component treats
 * them alike and says so.
 */
let mockAgentsState: 'resolved' | 'pending' | 'error' = 'resolved';

/**
 * DorkBot's manifest as the registry returns it — carrying NO colour and NO
 * icon, exactly as `ensureDorkBot` writes it, so its face is hashed wholly
 * from the ULID. A test that supplied a colour here would pass while the
 * production face stayed broken.
 */
const DORKBOT_MANIFEST: {
  id: string;
  name: string;
  isSystem: boolean;
  icon?: string;
  color?: string;
} = { id: DORKBOT_ID, name: 'dorkbot', isSystem: true };

/** What the registry returns for DorkBot — swapped by the stored-face test. */
let mockDorkbotManifest = DORKBOT_MANIFEST;

/** A second, non-system agent, listed FIRST — the lookup must not pick it. */
const OTHER_MANIFEST = { id: 'other-ulid', name: 'api-bot', isSystem: false };

const mockMutateAsync = vi.fn().mockResolvedValue({});
vi.mock('@/layers/entities/agent', () => ({
  useUpdateAgent: () => ({ mutateAsync: mockMutateAsync }),
  useResolvedAgents: () => ({
    data:
      mockAgentsState === 'resolved'
        ? { '/home/kai/projects/api': OTHER_MANIFEST, [DORKBOT_PATH]: mockDorkbotManifest }
        : undefined,
  }),
}));

// The registered ABSOLUTE path (never the literal tilde) — the client can stream it.
const REGISTERED_DIR = DORKBOT_PATH;
// The session DIRECTORY only. The face no longer comes from here, deliberately:
// the configured default agent may be some other agent entirely.
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
  | {
      agents: { defaultDirectory: string; defaultAgent: string };
      executionDefaults?: { runtime: string };
    }
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

vi.mock('@/layers/entities/mesh', () => ({
  useRegisterAgent: () => ({ mutate: vi.fn() }),
  useMeshAgentPaths: () => ({
    // `pending` and `error` both answer with no data — the component cannot
    // tell them apart from the outside, and treats them alike on purpose.
    data:
      mockAgentsState === 'resolved'
        ? { agents: [{ projectPath: '/home/kai/projects/api' }, { projectPath: DORKBOT_PATH }] }
        : undefined,
  }),
}));

/**
 * What the requirements scan says, for the one question this screen asks it:
 * can the configured default actually run the first session? `undefined` is the
 * answer nobody has yet, which must never override anything.
 */
let mockRequirements: { runtimes: Record<string, { state: string }> } | undefined;
vi.mock('@/layers/entities/runtime', () => ({
  // The real order — the fallback's tie-break is the product's own, and a mock
  // that invented one would test the mock.
  PRIMARY_RUNTIME_TYPES: ['claude-code', 'codex', 'opencode'] as const,
  useRuntimeRequirements: () => ({ data: mockRequirements }),
  selectRuntimeReadiness: (
    reqs: { runtimes: Record<string, { state: string }> },
    type: string
  ) => ({
    state: reqs.runtimes[type]?.state ?? 'connect',
  }),
}));

/**
 * The chat surfaces, stubbed down to the identity they were handed — the real
 * disc is `IdentityAvatar`'s job and is covered where it lives. What this screen
 * owns is WHICH identity reaches it, so the stubs publish exactly that.
 */
vi.mock('@/layers/features/chat', () => ({
  MessageItem: ({
    message,
    author,
  }: {
    message: { content: string };
    author: { id: string; color?: string; emoji?: string };
  }) => (
    <div
      data-testid="msg"
      data-author-id={author.id}
      data-author-color={author.color ?? ''}
      data-author-emoji={author.emoji ?? ''}
    >
      {message.content}
    </div>
  ),
  // Mirrors the real resolver's branch order for the two roles this screen
  // produces: a `user` message is the HUMAN, never the agent. Collapsing that
  // branch would let an assertion about DorkBot's face pass on the user's own
  // bubble.
  resolveMessageAuthor: (
    message: { role: string },
    ctx: { agent: Record<string, unknown>; humanName?: string | null }
  ) =>
    message.role === 'user'
      ? { kind: 'human', id: 'human', displayName: ctx.humanName?.trim() || 'You' }
      : { kind: 'agent', ...ctx.agent },
  TypingDots: () => <div data-testid="typing" />,
  // Mirrors the REAL FirstLight's one load-bearing line: it resolves the record
  // through `resolveAgentVisual`, which HASHES an emoji and colour from
  // `agentId` whenever `icon`/`color` are absent. Publishing the record's raw
  // fields instead would make an absent icon indistinguishable from an
  // explicitly empty one — and that difference IS the bug, so the stub would
  // have reported green over it.
  FirstLight: ({ record }: { record: { agentId: string; icon?: string; color?: string } }) => {
    const visual = resolveAgentVisual({
      id: record.agentId,
      icon: record.icon,
      color: record.color,
    });
    return (
      <div
        data-testid="first-light"
        data-agent-id={record.agentId}
        data-icon={visual.emoji}
        data-color={visual.color}
      />
    );
  },
}));

vi.mock('@/layers/features/composer', () => ({
  Composer: {
    Input: ({
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
  },
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
    // Every runtime ready unless a test says otherwise, so the fallback stays
    // out of the way of the cases that are not about it.
    mockRequirements = {
      runtimes: {
        'claude-code': { state: 'ready' },
        codex: { state: 'ready' },
        opencode: { state: 'ready' },
      },
    };
    useAgentBirthStore.setState({ records: {} });
    useAppStore.setState({ requestedTour: null });
    mockAgentsState = 'resolved';
    mockDorkbotManifest = DORKBOT_MANIFEST;
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

  // Two literals here used to say `claude-code` no matter what the server's
  // default was, so a person who had chosen Codex was told their very first
  // session ran on something it did not.
  it("names the server's default runtime on the first session, not a hardcoded one", async () => {
    mockOnboardingConfig = {
      agents: { defaultDirectory: '/home/kai/.dork/agents', defaultAgent: 'dorkbot' },
      executionDefaults: { runtime: 'codex' },
    };
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachDiscovery();
    fireEvent.click(screen.getByText('Not now'));
    await screen.findByTestId('composer');
    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send'));

    const records = Object.values(useAgentBirthStore.getState().records);
    expect(records[0]).toMatchObject({ runtime: 'codex' });
  });

  // Setup lets a person point the default at a runtime they have not connected
  // yet — honest, and the same thing the Settings field allows. Onboarding then
  // ends by SENDING a message, so that one session has to land somewhere that
  // can actually answer.
  it('falls back to a connected runtime for the first session, and leaves the default alone', async () => {
    mockOnboardingConfig = {
      agents: { defaultDirectory: '/home/kai/.dork/agents', defaultAgent: 'dorkbot' },
      executionDefaults: { runtime: 'opencode' },
    };
    mockRequirements = {
      runtimes: { 'claude-code': { state: 'connect' }, codex: { state: 'ready' } },
    };
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachDiscovery();
    fireEvent.click(screen.getByText('Not now'));
    await screen.findByTestId('composer');
    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send'));

    // The certificate names what it runs on…
    const records = Object.values(useAgentBirthStore.getState().records);
    expect(records[0]).toMatchObject({ runtime: 'codex' });
    // …and the session is LAUNCHED on it, which is the half that is not cosmetic.
    expect(mockNavigate.mock.calls[0][0].search.runtime).toBe('codex');
  });

  it('a scan that has not answered yet never overrides the configured default', async () => {
    mockOnboardingConfig = {
      agents: { defaultDirectory: '/home/kai/.dork/agents', defaultAgent: 'dorkbot' },
      executionDefaults: { runtime: 'opencode' },
    };
    mockRequirements = undefined;
    render(<OnboardingConversation onComplete={vi.fn()} />);
    await reachDiscovery();
    fireEvent.click(screen.getByText('Not now'));
    await screen.findByTestId('composer');
    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('send'));

    expect(mockNavigate.mock.calls[0][0].search.runtime).toBe('opencode');
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
    // The birth certificate names the runtime the session will actually run on.
    expect(records[0]).toMatchObject({ runtime: 'claude-code' });

    const sessionId = Object.keys(useAgentBirthStore.getState().records)[0];
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: REGISTERED_DIR, session: sessionId, runtime: 'claude-code' },
    });
    const navDir = mockNavigate.mock.calls[0][0].search.dir as string;
    expect(navDir).not.toContain('~');
    expect(onComplete).toHaveBeenCalled();
  });

  describe("DorkBot's face", () => {
    /** Drive the dissolve and hand back the birth record it registered. */
    async function dissolveIntoSession() {
      await reachDiscovery();
      fireEvent.click(screen.getByText('Not now'));
      await screen.findByTestId('composer');
      fireEvent.change(screen.getByTestId('composer'), { target: { value: 'hi' } });
      fireEvent.click(screen.getByTestId('send'));
      return Object.values(useAgentBirthStore.getState().records)[0];
    }

    it('is drawn from the SYSTEM agent’s manifest id, not from the name "dorkbot"', async () => {
      render(<OnboardingConversation onComplete={vi.fn()} />);
      await screen.findByTestId('pick-personality');

      const [bubble] = screen.getAllByTestId('msg');
      expect(bubble.getAttribute('data-author-id')).toBe(DORKBOT_ID);
      // The whole defect in one assertion: hashing the slug is a face DorkBot
      // wears in no other surface, because its manifest id is a ULID.
      expect(bubble.getAttribute('data-author-color')).toBe(hashToHslColor(DORKBOT_ID));
      expect(bubble.getAttribute('data-author-color')).not.toBe(hashToHslColor('dorkbot'));
      expect(bubble.getAttribute('data-author-emoji')).toBe(hashToEmoji(DORKBOT_ID));
      expect(bubble.getAttribute('data-author-emoji')).not.toBe(hashToEmoji('dorkbot'));
    });

    it('picks the system agent even though another agent is registered first', async () => {
      render(<OnboardingConversation onComplete={vi.fn()} />);
      await screen.findByTestId('pick-personality');

      // `OTHER_MANIFEST` sits ahead of DorkBot in the registry answer, so a
      // lookup that took the first agent rather than the `isSystem` one would
      // put a different agent's face on DorkBot's script.
      expect(screen.getAllByTestId('msg')[0].getAttribute('data-author-id')).not.toBe(
        OTHER_MANIFEST.id
      );
      expect(screen.getAllByTestId('msg')[0].getAttribute('data-author-id')).toBe(DORKBOT_ID);
    });

    it.each(['pending', 'error'] as const)(
      'shows a neutral placeholder rather than a slug face while the agents query is %s',
      async (state) => {
        mockAgentsState = state;
        render(<OnboardingConversation onComplete={vi.fn()} />);

        // FIRST LIGHT is the surface most likely to see this: it is the very
        // first thing rendered, and its 48px disc is the largest face on screen.
        const firstLight = screen.getByTestId('first-light');
        expect(firstLight.getAttribute('data-agent-id')).not.toBe(DORKBOT_ID);
        // Explicitly EMPTY, not absent: `resolveAgentVisual` hashes an emoji
        // from the id whenever `icon` is missing, so an omitted icon is exactly
        // how a slug-hashed face reaches first light.
        expect(firstLight.getAttribute('data-icon')).toBe('');
        expect(firstLight.getAttribute('data-color')).toContain('var(');
        expect(firstLight.getAttribute('data-color')).not.toBe(hashToHslColor('dorkbot'));

        await screen.findByTestId('pick-personality');
        const [bubble] = screen.getAllByTestId('msg');
        expect(bubble.getAttribute('data-author-emoji')).toBe('');
        expect(bubble.getAttribute('data-author-color')).toContain('var(');
        expect(bubble.getAttribute('data-author-color')).not.toBe(hashToHslColor('dorkbot'));
      }
    );

    it('is the same face at first light and in the birth record it hands the session', async () => {
      render(<OnboardingConversation onComplete={vi.fn()} />);
      const firstLight = screen.getByTestId('first-light');
      expect(firstLight.getAttribute('data-agent-id')).toBe(DORKBOT_ID);
      expect(firstLight.getAttribute('data-icon')).toBe(hashToEmoji(DORKBOT_ID));

      const record = await dissolveIntoSession();
      expect(record.agentId).toBe(DORKBOT_ID);
      expect(record.icon).toBe(hashToEmoji(DORKBOT_ID));
      expect(record.color).toBe(hashToHslColor(DORKBOT_ID));
    });

    it('carries a STORED icon and colour through to the birth records', async () => {
      // DorkBot ships with neither, so the hash is what every other assertion
      // here sees — which means nothing else would notice if the manifest's own
      // face stopped being passed through. A user who picks a face gets this.
      mockDorkbotManifest = { ...DORKBOT_MANIFEST, icon: '🛰️', color: '#123456' };
      render(<OnboardingConversation onComplete={vi.fn()} />);

      const firstLight = screen.getByTestId('first-light');
      expect(firstLight.getAttribute('data-icon')).toBe('🛰️');
      expect(firstLight.getAttribute('data-color')).toBe('#123456');

      const record = await dissolveIntoSession();
      expect(record.icon).toBe('🛰️');
      expect(record.color).toBe('#123456');
    });
  });
});
