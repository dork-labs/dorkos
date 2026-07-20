/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
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

vi.mock('@/layers/features/mesh', () => ({
  DiscoveryView: () => <div data-testid="discovery-view">DiscoveryView</div>,
}));

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

function renderDialog(transport = createMockTransport()) {
  const queryClient = createTestQueryClient();

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
    useAgentCreationStore.setState({ isOpen: false, initialMode: 'new', seed: null });
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

  it('open("import") jumps straight to the import scan', async () => {
    renderDialog();
    useAgentCreationStore.getState().open('import');

    await screen.findByRole('dialog');
    expect(await screen.findByTestId('discovery-view')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-gallery-mock')).not.toBeInTheDocument();
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

  it('the gallery import link routes to the import scan', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('mock-import'));
    expect(await screen.findByTestId('discovery-view')).toBeInTheDocument();
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

    // Reroll advances the window; Scout drops out, Atlas comes in.
    await user.click(screen.getByTestId('suggestion-reroll'));
    expect(screen.queryByTestId('suggestion-Scout')).not.toBeInTheDocument();
    expect(screen.getByTestId('suggestion-Atlas')).toBeInTheDocument();
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
    renderDialog(transport);

    const nameInput = await reachNamingViaDesign(user);
    await user.type(nameInput, 'Scout');
    await user.click(screen.getByTestId('create-button'));

    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Agent already exists'));
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
    expect(await screen.findByTestId('discovery-view')).toBeInTheDocument();
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
    expect(screen.getByText('Brings its skills')).toBeInTheDocument();
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

  it('Not now closes the dialog and clears the seed', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().openWithSeed(seedFor());
    await screen.findByText('Meet Linear Keeper');

    await user.click(screen.getByTestId('arrival-not-now'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useAgentCreationStore.getState().seed).toBeNull();
  });
});
