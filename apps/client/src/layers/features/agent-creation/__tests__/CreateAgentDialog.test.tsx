/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { createMockTransport } from '@dorkos/test-utils';
import { useImportProjectsStore, useAgentBirthStore } from '@/layers/shared/model';
import {
  useAutoKickoff,
  __resetFiredKickoffsForTest,
} from '@/layers/features/chat/model/kickoff/use-auto-kickoff';
import { CreateAgentDialog } from '../ui/CreateAgentDialog';
import { useAgentCreationStore } from '../model/store';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPlayCelebration = vi.fn();

vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    playCelebration: (...args: unknown[]) => mockPlayCelebration(...args),
  };
});

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('sonner', () => {
  const errorFn = vi.fn();
  return {
    toast: Object.assign(vi.fn(), { error: errorFn }),
  };
});

// The gallery is exercised in AgentGallery.test.tsx; here it stands in for the
// M2 step and lets each test drive a specific selection.
vi.mock('../ui/AgentGallery', () => ({
  AgentGallery: ({
    onDesignYourOwn,
    onSelectTemplate,
    onImport,
  }: {
    onDesignYourOwn: () => void;
    onSelectTemplate: (t: unknown) => void;
    onImport: () => void;
  }) => (
    <div data-testid="agent-gallery-mock">
      <button data-testid="mock-design-your-own" onClick={onDesignYourOwn}>
        Design your own
      </button>
      <button
        data-testid="mock-select-template"
        onClick={() =>
          onSelectTemplate({
            source: 'github.com/dorkos/code-reviewer',
            name: '@dorkos/code-reviewer',
            displayName: 'Code Reviewer',
            description: 'Reviews pull requests',
            icon: '🔍',
            tags: ['github'],
          })
        }
      >
        Pick Template
      </button>
      <button
        data-testid="mock-select-other-template"
        onClick={() =>
          onSelectTemplate({
            source: 'github.com/dorkos/release-scribe',
            name: '@dorkos/release-scribe',
            displayName: 'Release Scribe',
            description: 'Writes release notes',
            icon: '📝',
          })
        }
      >
        Pick Other Template
      </button>
      <button data-testid="mock-import" onClick={onImport}>
        Import
      </button>
    </div>
  ),
}));

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/ui')>();
  return {
    ...actual,
    DirectoryPicker: ({
      open,
      onSelect,
      onOpenChange,
    }: {
      open: boolean;
      onSelect: (path: string) => void;
      onOpenChange: (open: boolean) => void;
    }) =>
      open ? (
        <div data-testid="directory-picker">
          <button
            data-testid="picker-select"
            onClick={() => {
              onSelect('/custom/path');
              onOpenChange(false);
            }}
          >
            Select Dir
          </button>
        </div>
      ) : null,
  };
});

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderDialog(transport = createMockTransport(), queryClient = createTestQueryClient()) {
  if (!vi.isMockFunction(transport.getConfig)) {
    transport.getConfig = vi.fn();
  }
  vi.mocked(transport.getConfig).mockResolvedValue({
    version: 1,
    agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
  } as never);

  if (!vi.isMockFunction(transport.browseDirectory)) {
    transport.browseDirectory = vi.fn();
  }
  vi.mocked(transport.browseDirectory).mockRejectedValue(new Error('ENOENT'));

  const result = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <CreateAgentDialog />
      </TransportProvider>
    </QueryClientProvider>
  );

  return { ...result, queryClient, transport };
}

/** Open the dialog generically and reach the naming step via design-your-own. */
async function reachNamingViaDesign(user: ReturnType<typeof userEvent.setup>) {
  useAgentCreationStore.getState().open();
  await user.click(await screen.findByTestId('mock-design-your-own'));
  return screen.findByLabelText('Name');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentCreationStore.setState({
      isOpen: false,
      initialMode: 'new',
      seed: null,
      onCreated: null,
    });
    useImportProjectsStore.setState({ isOpen: false });
    useAgentBirthStore.setState({ records: {} });
    __resetFiredKickoffsForTest();
  });

  afterEach(cleanup);

  // ---- Entry routing ----

  it('generic open() lands on the gallery (M2), not a method fork', async () => {
    renderDialog();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    useAgentCreationStore.getState().open();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('agent-gallery-mock')).toBeInTheDocument();
    // Appears in both the visible header and the sr-only live region.
    expect(screen.getAllByText('What will your agent do?').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('arrival-confirm')).not.toBeInTheDocument();
  });

  it('a seed lands on the arrival confirm (M1), never the gallery', async () => {
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor());

    expect(await screen.findByText('Meet Linear Keeper')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-gallery-mock')).not.toBeInTheDocument();
  });

  // ---- Gallery → naming ----

  it('design-your-own opens the naming step with an empty name and honest job line', async () => {
    const user = userEvent.setup();
    renderDialog();
    await reachNamingViaDesign(user);

    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(
      screen.getByText("You'll define the job together in your first conversation.")
    ).toBeInTheDocument();
  });

  it('picking a template opens naming pre-filled with the human name', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('mock-select-template'));
    const nameInput = await screen.findByLabelText('Name');
    expect(nameInput).toHaveValue('Code Reviewer');
  });

  it('the gallery import link leaves for the standalone import dialog', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('mock-import'));

    // Creation dialog closes; the import flow opens in its own dialog.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useImportProjectsStore.getState().isOpen).toBe(true);
  });

  it('Back from naming returns to the gallery', async () => {
    const user = userEvent.setup();
    renderDialog();
    await reachNamingViaDesign(user);

    await user.click(screen.getByTestId('naming-back'));
    expect(await screen.findByTestId('agent-gallery-mock')).toBeInTheDocument();
  });

  // ---- Naming behaviors ----

  it('the live preview updates as the name is typed', async () => {
    const user = userEvent.setup();
    renderDialog();
    const nameInput = await reachNamingViaDesign(user);

    await user.type(nameInput, 'Scout');
    expect(screen.getByTestId('preview-name')).toHaveTextContent('Scout');
  });

  it('applies a name suggestion and rerolls to a fresh set', async () => {
    const user = userEvent.setup();
    renderDialog();
    const nameInput = await reachNamingViaDesign(user);

    // Default pool window: Scout, Sage, Pilot, Beacon.
    await user.click(screen.getByTestId('suggestion-Scout'));
    expect(nameInput).toHaveValue('Scout');

    // The picked name leaves the pool immediately (a chip that does nothing
    // reads as broken) — the window refills from the remaining names.
    expect(screen.queryByTestId('suggestion-Scout')).not.toBeInTheDocument();
    expect(screen.getByTestId('suggestion-Atlas')).toBeInTheDocument();

    // Reroll advances to a fresh window over the deduped pool.
    await user.click(screen.getByTestId('suggestion-reroll'));
    expect(screen.queryByTestId('suggestion-Sage')).not.toBeInTheDocument();
    expect(screen.getByTestId('suggestion-Nova')).toBeInTheDocument();
  });

  // Red when the wizard treats its own placeholder as a choice. It used to seed
  // the field with 🤖 on entering the naming step and submit that, so the
  // server's seeding (DOR-949) never ran and every agent made here wore the
  // same robot. Asserting the KEY IS ABSENT is the point — an assertion on the
  // response, or on some other face value, would pass with 🤖 still going out.
  it('sends no face when the user picked none, leaving the seeding to the server', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'scout',
      _path: '/p',
    } as never);
    renderDialog(transport);
    const nameInput = await reachNamingViaDesign(user);

    await user.type(nameInput, 'Scout');
    await user.click(screen.getByTestId('create-button'));

    await waitFor(() => expect(transport.createAgent).toHaveBeenCalled());
    const payload = vi.mocked(transport.createAgent).mock.calls[0][0];
    // `icon` only. A matching assertion on `color` would read as coverage of a
    // second field, but this wizard has no colour control to send one, so
    // nothing that could change here would ever make it red.
    expect(payload).not.toHaveProperty('icon');
  });

  it('highlights no face in the picker until the user chooses one', async () => {
    const user = userEvent.setup();
    renderDialog();
    await reachNamingViaDesign(user);

    const pressed = screen
      .getAllByRole('button', { name: /^Face / })
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(0);

    await user.click(screen.getByTestId('face-🦊'));
    expect(screen.getByTestId('face-🦊')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a picked face persists to the created agent', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'scout',
      _path: '/p',
    } as never);
    renderDialog(transport);
    const nameInput = await reachNamingViaDesign(user);

    await user.type(nameInput, 'Scout');
    await user.click(screen.getByTestId('face-🦊'));
    await user.click(screen.getByTestId('create-button'));

    await waitFor(() => {
      expect(transport.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'scout', icon: '🦊' })
      );
    });
  });

  it('the folded Details carry the chosen runtime and directory into create', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'scout',
      _path: '/p',
    } as never);
    renderDialog(transport);
    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'Scout');

    await user.click(screen.getByTestId('details-toggle'));
    await user.click(screen.getByTestId('runtime-codex'));
    await user.click(screen.getByTestId('browse-directory-button'));
    await user.click(await screen.findByTestId('picker-select'));

    await user.click(screen.getByTestId('create-button'));
    await waitFor(() => {
      expect(transport.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: 'codex', directory: '/custom/path' })
      );
    });
  });

  it('labels the primary action "Bring {name} to life"', async () => {
    const user = userEvent.setup();
    renderDialog();
    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'Scout');
    expect(screen.getByTestId('create-button')).toHaveTextContent('Bring Scout to life');
  });

  it('disables create until a name is entered', async () => {
    const user = userEvent.setup();
    renderDialog();
    await reachNamingViaDesign(user);
    expect(screen.getByTestId('create-button')).toBeDisabled();
  });

  // ---- Create flow ----

  it('creates a design-your-own agent: celebrates, closes, navigates to a session', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'scout',
      _path: '/home/test/.dork/agents/scout',
    } as never);
    const { queryClient } = renderDialog(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'Scout');
    await user.click(screen.getByTestId('create-button'));

    await waitFor(() => {
      expect(transport.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'scout', displayName: 'Scout', runtime: 'claude-code' })
      );
    });
    await waitFor(() => expect(mockPlayCelebration).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['agents'] }))
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/session',
        search: expect.objectContaining({ dir: '/home/test/.dork/agents/scout' }),
      })
    );
  });

  it('passes the template source through on create', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'code-reviewer',
      _path: '/p',
    } as never);
    renderDialog(transport);
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('mock-select-template'));
    await screen.findByLabelText('Name');
    await user.click(screen.getByTestId('create-button'));

    await waitFor(() => {
      expect(transport.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'github.com/dorkos/code-reviewer',
          icon: '🔍',
        })
      );
    });
  });

  it('shows an error toast on failed creation', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockRejectedValue(new Error('Agent already exists'));
    // The real error policy (`createQueryClientConfig`), not the bare test
    // client — the dialog no longer toasts this itself, `useCreateAgent`'s
    // `meta.errorLabel` routes it through the shared mutation cache instead.
    renderDialog(
      transport,
      new QueryClient({
        ...createQueryClientConfig(),
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      })
    );

    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'Scout');
    await user.click(screen.getByTestId('create-button'));

    const { toast } = await import('sonner');
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't create that agent",
        expect.objectContaining({ description: "Agent already exists" })
      )
    );
  });

  // ---- Birth ceremony (M4) against #356's real onSuccess ----

  it('records a birth on the normal create path, keyed by the navigated session', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'scout',
      displayName: 'Scout',
      runtime: 'claude-code',
      registeredAt: '2026-07-20T00:00:00.000Z',
      _path: '/home/test/.dork/agents/scout',
      capabilities: [],
    } as never);
    renderDialog(transport);

    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'Scout');
    await user.click(screen.getByTestId('create-button'));

    // The navigated session id carries the birth; the record's kickoff is the
    // fenced design-your-own INTERVIEW (not a generic hello) — it routes to the
    // interview origin, so the message carries the write-your-SOUL directive.
    let navigatedSessionId: string | undefined;
    await waitFor(() => {
      const call = mockNavigate.mock.calls.at(-1)?.[0];
      navigatedSessionId = call?.search?.session;
      expect(navigatedSessionId).toBeTruthy();
    });
    const record = useAgentBirthStore.getState().records[navigatedSessionId!];
    expect(record).toBeDefined();
    expect(record.path).toBe('/home/test/.dork/agents/scout');
    expect(record.fired).toBe(false);
    expect(record.kickoffMessage).toContain('<dork-kickoff>');
    expect(record.kickoffMessage).toContain('.dork/SOUL.md');
  });

  it('onboarding (onCreated set): parks a birth without navigating, then the first session claims + fires it once', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'scout',
      displayName: 'Scout',
      runtime: 'claude-code',
      registeredAt: '2026-07-20T00:00:00.000Z',
      _path: '/home/test/.dork/agents/scout',
      capabilities: [],
    } as never);

    // Open the dialog the way onboarding does — with a one-shot onCreated hook
    // that takes over instead of navigating (create-without-navigate).
    const hostOnCreated = vi.fn();
    renderDialog(transport);
    useAgentCreationStore.getState().open('new', { onCreated: hostOnCreated });

    await user.click(await screen.findByTestId('mock-design-your-own'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'Scout');
    await user.click(screen.getByTestId('create-button'));

    // The host hook fired and NO navigation happened — the birth is parked under
    // a session id nobody will ever visit.
    await waitFor(() => expect(hostOnCreated).toHaveBeenCalledTimes(1));
    expect(mockNavigate).not.toHaveBeenCalled();

    const parked = Object.values(useAgentBirthStore.getState().records);
    expect(parked).toHaveLength(1);
    expect(parked[0].path).toBe('/home/test/.dork/agents/scout');
    expect(parked[0].fired).toBe(false);

    // Now the agent's first real session opens in that directory. useAutoKickoff
    // claims the parked record by directory and fires the hello exactly once.
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      (props: { sessionId: string }) =>
        useAutoKickoff({
          sessionId: props.sessionId,
          cwd: '/home/test/.dork/agents/scout',
          status: 'idle',
          messages: [],
          hydrated: true,
          submitKickoff,
          submitContent: vi.fn().mockResolvedValue(undefined),
        }),
      { initialProps: { sessionId: 'first-real-session' } }
    );

    await waitFor(() => expect(submitKickoff).toHaveBeenCalledTimes(1));
    expect(submitKickoff.mock.calls[0][0]).toContain('<dork-kickoff>');
    // Claimed under the real session; the parked key is gone; fired latched.
    const claimed = useAgentBirthStore.getState().records['first-real-session'];
    expect(claimed.fired).toBe(true);
    expect(Object.keys(useAgentBirthStore.getState().records)).toEqual(['first-real-session']);

    // A remount of the first session never re-fires.
    rerender({ sessionId: 'first-real-session' });
    expect(submitKickoff).toHaveBeenCalledTimes(1);
  });

  // ---- Validation (migrated from ConfigureStep) ----

  it('shows the derived folder name in Details', async () => {
    const user = userEvent.setup();
    renderDialog();
    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'My Cool Agent');
    await user.click(screen.getByTestId('details-toggle'));
    expect(screen.getByText('my-cool-agent')).toBeInTheDocument();
  });

  it('offers "Import instead?" when the target folder already holds a project', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();
    vi.mocked(transport.browseDirectory).mockResolvedValue({
      path: '/test',
      entries: [{ name: '.dork', isDirectory: true }],
      parent: null,
    } as never);

    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'taken-agent');

    await waitFor(() =>
      expect(screen.getByTestId('conflict-status')).toHaveTextContent('Existing project detected')
    );
    await user.click(screen.getByTestId('import-instead-link'));
    // "Import instead?" leaves creation for the standalone import dialog.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useImportProjectsStore.getState().isOpen).toBe(true);
  });

  it('reports "Will create new directory" for a fresh path', async () => {
    const user = userEvent.setup();
    renderDialog();
    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'fresh-agent');
    await user.click(screen.getByTestId('details-toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('conflict-status')).toHaveTextContent('Will create new directory')
    );
  });

  // ---- Template reselection (auto-fill provenance) ----

  it('switching templates updates an auto-filled name', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('mock-select-template'));
    expect(await screen.findByLabelText('Name')).toHaveValue('Code Reviewer');

    await user.click(screen.getByTestId('naming-back'));
    await user.click(await screen.findByTestId('mock-select-other-template'));
    expect(await screen.findByLabelText('Name')).toHaveValue('Release Scribe');
  });

  it('switching to design-your-own clears an auto-filled template name', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('mock-select-template'));
    expect(await screen.findByLabelText('Name')).toHaveValue('Code Reviewer');

    await user.click(screen.getByTestId('naming-back'));
    await user.click(await screen.findByTestId('mock-design-your-own'));
    expect(await screen.findByLabelText('Name')).toHaveValue('');
  });

  it('never clobbers a user-typed name on template switch', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('mock-select-template'));
    const nameInput = await screen.findByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Ada');

    await user.click(screen.getByTestId('naming-back'));
    await user.click(await screen.findByTestId('mock-select-other-template'));
    expect(await screen.findByLabelText('Name')).toHaveValue('Ada');
  });

  // ---- Remaining conflict states ----

  it('reports "Directory exists" when the path exists without a project', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();
    vi.mocked(transport.browseDirectory).mockResolvedValue({
      path: '/test',
      entries: [{ name: 'README.md', isDirectory: false }],
      parent: null,
    } as never);

    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'existing-dir');
    await user.click(screen.getByTestId('details-toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('conflict-status')).toHaveTextContent(
        'That folder is already there. The project goes inside it.'
      )
    );
  });

  it('reports "Cannot access this path" on a permission error and blocks create', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();
    vi.mocked(transport.browseDirectory).mockRejectedValue(new Error('EACCES: permission denied'));

    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'restricted-agent');
    await user.click(screen.getByTestId('details-toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('conflict-status')).toHaveTextContent('Cannot access this path')
    );
    expect(screen.getByTestId('create-button')).toBeDisabled();
  });

  // ---- Reset ----

  it('resets to the gallery when closed and reopened', async () => {
    const user = userEvent.setup();
    renderDialog();
    await reachNamingViaDesign(user);

    useAgentCreationStore.getState().close();
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());

    useAgentCreationStore.getState().open();
    expect(await screen.findByTestId('agent-gallery-mock')).toBeInTheDocument();
  });

  // ---- Arrival (M1) — the founder's "Set up X" path ----

  function seedFor(overrides: Record<string, unknown> = {}) {
    return {
      template: {
        displayName: 'Linear Keeper',
        runtime: 'codex' as const,
        persona: 'I keep your Linear board tidy.',
        capabilities: ['linear'],
        skills: ['linear-adapter'],
        ...overrides,
      },
      origin: 'shape-offer' as const,
      sourceLabel: 'Linear Ops',
    };
  }

  it('renders the arrival confirm with an honest ledger (runtime, dir, can, skills)', async () => {
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor());
    await screen.findByText('Meet Linear Keeper');

    expect(screen.getByText('I keep your Linear board tidy.')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('~/.dork/agents/linear-keeper')).toBeInTheDocument();
    expect(screen.getByText('Can')).toBeInTheDocument();
    expect(screen.getByText('linear')).toBeInTheDocument();
    // Skills are listed, never claimed installed.
    expect(screen.getByText('Uses skills')).toBeInTheDocument();
    expect(screen.getByText(/linear-adapter/)).toBeInTheDocument();
  });

  it('shows a schedule line only when the offer declares a cadence', async () => {
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor());
    await screen.findByText('Meet Linear Keeper');
    expect(screen.queryByTestId('arrival-schedule')).not.toBeInTheDocument();

    cleanup();
    useAgentCreationStore.setState({ isOpen: false, initialMode: 'new', seed: null });
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor({ schedule: 'Every weekday at 9am' }));
    await screen.findByText('Meet Linear Keeper');
    expect(screen.getByTestId('arrival-schedule')).toHaveTextContent('Every weekday at 9am');
  });

  it('disables Create and explains when the seed arrives without a usable name', async () => {
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor({ displayName: '' }));

    const createBtn = await screen.findByTestId('arrival-create');
    expect(createBtn).toBeDisabled();
    expect(screen.getByTestId('arrival-needs-name')).toBeInTheDocument();
  });

  it('Customize first opens naming pre-filled from the seed', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor());
    await screen.findByText('Meet Linear Keeper');

    await user.click(screen.getByTestId('arrival-customize'));
    expect(await screen.findByLabelText('Name')).toHaveValue('Linear Keeper');
  });

  it('one-click Create from M1 sends the seed persona, runtime, and capabilities', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'seed-id',
      name: 'linear-keeper',
      _path: '/home/test/.dork/agents/linear-keeper',
    } as never);
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed(seedFor());
    await screen.findByText('Meet Linear Keeper');

    await user.click(screen.getByRole('button', { name: 'Create Linear Keeper' }));
    await waitFor(() => {
      expect(transport.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'linear-keeper',
          displayName: 'Linear Keeper',
          runtime: 'codex',
          persona: 'I keep your Linear board tidy.',
          capabilities: ['linear'],
        })
      );
    });
  });

  it('a marketplace agent seed creates via the standard engine with the package template source', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'mkt-id',
      name: 'code-reviewer',
      _path: '/home/test/.dork/agents/code-reviewer',
    } as never);
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed({
      origin: 'marketplace-agent',
      sourceLabel: 'dork-labs',
      template: {
        displayName: 'Code Reviewer',
        source: 'github:dork-labs/marketplace/plugins/code-reviewer',
        persona: 'Reviews pull requests every weekday.',
        icon: '🔍',
      },
    });
    await screen.findByText('Meet Code Reviewer');

    await user.click(screen.getByRole('button', { name: 'Create Code Reviewer' }));
    await waitFor(() => {
      expect(transport.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'code-reviewer',
          displayName: 'Code Reviewer',
          template: 'github:dork-labs/marketplace/plugins/code-reviewer',
          persona: 'Reviews pull requests every weekday.',
        })
      );
    });
  });

  // ---- What a marketplace agent runs on its own, said before yes (DOR-644) ----

  /**
   * A seed of the shape `agentPackageToCreationSeed` produces: it carries the
   * package name, which is the only thing that lets this card ask the server
   * what lives in the package's own `.dork/tasks` SKILL.md files.
   */
  function packageSeed() {
    return {
      origin: 'marketplace-agent' as const,
      sourceLabel: 'dork-labs',
      packageName: '@dorkos/night-sweeper',
      template: {
        displayName: 'Night Sweeper',
        source: 'github:dork-labs/marketplace/agents/night-sweeper',
        persona: 'I tidy the repo overnight.',
      },
    };
  }

  /** A preview reply carrying one scheduled job, and nothing else. */
  function previewWithSchedule(schedule: Record<string, unknown>) {
    return {
      manifest: { name: '@dorkos/night-sweeper', type: 'agent' },
      packagePath: '/tmp/staged',
      preview: {
        fileChanges: [],
        extensions: [],
        hooks: [],
        unreadableHooks: [],
        schedules: [schedule],
        secrets: [],
        npmDependencies: [],
        externalHosts: [],
        requires: [],
        conflicts: [],
      },
    };
  }

  it('discloses a packaged cron and the mode it actually gets', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewMarketplacePackage).mockResolvedValue(
      // `bypassPermissions` in the SKILL.md; `clampSchedulePermissionMode` has
      // already knocked it down to `acceptEdits` by the time it reaches here.
      previewWithSchedule({
        name: 'overnight-sweep',
        cron: '0 3 * * *',
        permissionMode: 'acceptEdits',
        startsEnabled: true,
      }) as never
    );
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed(packageSeed());

    const row = await screen.findByTestId('arrival-package-schedules');
    expect(row).toHaveTextContent('overnight-sweep');
    expect(row).toHaveTextContent('At 03:00 AM');
    expect(row).toHaveTextContent('can change files on its own');
    expect(transport.previewMarketplacePackage).toHaveBeenCalledWith(
      '@dorkos/night-sweeper',
      undefined
    );
    await waitFor(() => expect(screen.getByTestId('arrival-create')).toBeEnabled());
  });

  it('holds Create until it knows what the package runs on its own', async () => {
    const transport = createMockTransport();
    // Never resolves: the card stays in the state it is in while it waits.
    vi.mocked(transport.previewMarketplacePackage).mockReturnValue(new Promise(() => {}) as never);
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed(packageSeed());

    // This card is the one approval an agent package ever gets, so it must not
    // let a person say yes to something it has not read yet.
    expect(await screen.findByTestId('arrival-checking-offer')).toBeInTheDocument();
    expect(screen.getByTestId('arrival-create')).toBeDisabled();
  });

  it('carries the whole disclosure through "Customize first", not just the gate', async () => {
    // The naming step creates the same agent from the same package, and is one
    // click from the arrival card. A gate that travelled without the ledger let
    // a person wait out the check and then create, having read nothing.
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewMarketplacePackage).mockResolvedValue(
      previewWithSchedule({
        name: 'overnight-sweep',
        cron: '0 3 * * *',
        permissionMode: 'acceptEdits',
        startsEnabled: true,
      }) as never
    );
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed(packageSeed());
    await screen.findByTestId('arrival-package-schedules');

    await user.click(screen.getByTestId('arrival-customize'));
    await screen.findByLabelText('Name');

    const row = await screen.findByTestId('naming-package-schedules');
    expect(row).toHaveTextContent('overnight-sweep');
    expect(row).toHaveTextContent('At 03:00 AM');
    expect(row).toHaveTextContent('can change files on its own');
    expect(screen.getByTestId('create-button')).toBeEnabled();
  });

  it('holds the naming step too while the check is still in flight', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    // Never resolves: the check is still in flight for the whole test.
    vi.mocked(transport.previewMarketplacePackage).mockReturnValue(new Promise(() => {}) as never);
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed(packageSeed());

    await user.click(await screen.findByTestId('arrival-customize'));
    await screen.findByLabelText('Name');

    expect(screen.getByTestId('naming-checking-offer')).toBeInTheDocument();
    expect(screen.getByTestId('create-button')).toBeDisabled();
  });

  it('carries a failed check through to the naming step as well', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewMarketplacePackage).mockRejectedValue(new Error('offline'));
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed(packageSeed());
    await screen.findByTestId('arrival-offer-check-failed');

    await user.click(screen.getByTestId('arrival-customize'));
    await screen.findByLabelText('Name');

    expect(await screen.findByTestId('naming-offer-check-failed')).toBeInTheDocument();
  });

  it('never asks the server about an offer that came from a Shape, not a package', async () => {
    const transport = createMockTransport();
    renderDialog(transport);
    useAgentCreationStore.getState().openWithSeed(seedFor());
    await screen.findByText('Meet Linear Keeper');

    expect(transport.previewMarketplacePackage).not.toHaveBeenCalled();
    expect(screen.queryByTestId('arrival-checking-offer')).not.toBeInTheDocument();
    expect(screen.getByTestId('arrival-create')).toBeEnabled();
  });

  it('a host onCreated hook runs on create instead of navigating away', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'id',
      name: 'scout',
      _path: '/home/test/.dork/agents/scout',
    } as never);
    const onCreated = vi.fn();
    renderDialog(transport);
    useAgentCreationStore.getState().open('new', { onCreated });

    await user.click(await screen.findByTestId('mock-design-your-own'));
    await user.type(await screen.findByLabelText('Name'), 'Scout');
    await user.click(screen.getByTestId('create-button'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    // The host takes over — no navigation to a session.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('Not now closes the dialog and clears the seed', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor());
    await screen.findByText('Meet Linear Keeper');

    await user.click(screen.getByTestId('arrival-not-now'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useAgentCreationStore.getState().seed).toBeNull();
  });

  // ---- The mesh-wide switch, surfaced where the wall gets hit (DOR-1338) ----

  /** A transport whose mesh already holds one of the person's own agents. */
  function transportWithOneOwnAgent(openMesh: boolean) {
    const transport = createMockTransport();
    vi.mocked(transport.listMeshAgents).mockResolvedValue({
      agents: [{ id: 'agent-existing', name: 'scout' }],
    } as never);
    vi.mocked(transport.getMeshTopology).mockResolvedValue({
      callerNamespace: '*',
      namespaces: [],
      accessRules: [],
      openMesh,
    });
    return transport;
  }

  it('warns on the naming step that a new agent cannot reach the existing ones', async () => {
    const user = userEvent.setup();
    renderDialog(transportWithOneOwnAgent(false));
    await reachNamingViaDesign(user);

    expect(
      await screen.findByRole('switch', { name: 'Let all my agents talk to each other' })
    ).toBeInTheDocument();
  });

  it('says nothing on the naming step once the switch is already on', async () => {
    const user = userEvent.setup();
    renderDialog(transportWithOneOwnAgent(true));
    await reachNamingViaDesign(user);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(
      screen.queryByRole('switch', { name: 'Let all my agents talk to each other' })
    ).not.toBeInTheDocument();
  });

  it('says nothing when this is the first agent (nobody to be cut off from)', async () => {
    const user = userEvent.setup();
    renderDialog();
    await reachNamingViaDesign(user);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(
      screen.queryByRole('switch', { name: 'Let all my agents talk to each other' })
    ).not.toBeInTheDocument();
  });

  it('never interrupts the gallery step', async () => {
    renderDialog(transportWithOneOwnAgent(false));
    useAgentCreationStore.getState().open();

    await screen.findByTestId('agent-gallery-mock');
    expect(
      screen.queryByRole('switch', { name: 'Let all my agents talk to each other' })
    ).not.toBeInTheDocument();
  });
});
