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

vi.mock('sonner', () => {
  const errorFn = vi.fn();
  return {
    toast: Object.assign(vi.fn(), { error: errorFn }),
  };
});

vi.mock('@/layers/features/mesh', () => ({
  DiscoveryView: () => <div data-testid="discovery-view">DiscoveryView</div>,
}));

vi.mock('../ui/TemplatePicker', () => ({
  TemplatePicker: ({
    selectedTemplate,
    onSelect,
  }: {
    selectedTemplate: string | null;
    onSelect: (source: string | null, name?: string) => void;
  }) => (
    <div data-testid="template-picker">
      <button
        data-testid="select-template"
        onClick={() => onSelect('github.com/dorkos/code-reviewer', '@dorkos/code-reviewer')}
      >
        Pick Template
      </button>
      {selectedTemplate && <span data-testid="selected-template">{selectedTemplate}</span>}
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

  // Radix Collapsible uses ResizeObserver internally
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

  // Provide default config response
  if (!vi.isMockFunction(transport.getConfig)) {
    transport.getConfig = vi.fn();
  }
  vi.mocked(transport.getConfig).mockResolvedValue({
    version: 1,
    agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
  } as never);

  // Default browseDirectory mock — path does not exist (ENOENT)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateAgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentCreationStore.setState({ isOpen: false, initialMode: 'new' });
  });

  afterEach(cleanup);

  // ---- Open / Close ----

  it('opens via store.open() and shows method selection cards', async () => {
    renderDialog();

    // Dialog should not be visible initially
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Open via store
    useAgentCreationStore.getState().open();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // Verify three method cards are present
    expect(screen.getByTestId('method-new')).toBeInTheDocument();
    expect(screen.getByTestId('method-template')).toBeInTheDocument();
    expect(screen.getByTestId('method-import')).toBeInTheDocument();
  });

  it('shows "How do you want to start?" description on choose step', async () => {
    renderDialog();
    useAgentCreationStore.getState().open();

    // The text appears in both DialogDescription and the sr-only aria-live region.
    // Query specifically for the visible paragraph element.
    const matches = await screen.findAllByText('How do you want to start?');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Entry-point routing ----

  it('defaults to choose step when opened without argument', async () => {
    renderDialog();
    useAgentCreationStore.getState().open();

    await screen.findByRole('dialog');
    expect(screen.getByTestId('method-new')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('opens on import step when store.open("import") is called', async () => {
    renderDialog();
    useAgentCreationStore.getState().open('import');

    await screen.findByRole('dialog');
    expect(await screen.findByTestId('discovery-view')).toBeInTheDocument();
    expect(screen.queryByTestId('method-new')).not.toBeInTheDocument();
  });

  it('opens on pick-template step when store.open("template") is called', async () => {
    renderDialog();
    useAgentCreationStore.getState().open('template');

    await screen.findByRole('dialog');
    expect(await screen.findByTestId('template-picker')).toBeInTheDocument();
    expect(screen.queryByTestId('method-new')).not.toBeInTheDocument();
  });

  // ---- Method card navigation ----

  it('clicking Start Blank card transitions to configure step', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    expect(screen.queryByTestId('method-new')).not.toBeInTheDocument();
  });

  it('clicking From Template card transitions to pick-template step', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-template'));
    expect(await screen.findByTestId('template-picker')).toBeInTheDocument();
  });

  it('clicking Import Project card transitions to import step', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-import'));
    expect(await screen.findByTestId('discovery-view')).toBeInTheDocument();
  });

  // ---- Back navigation ----

  it('Back button on configure (blank) returns to choose step', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    await screen.findByLabelText('Name');

    await user.click(screen.getByTestId('back-button'));
    expect(await screen.findByTestId('method-new')).toBeInTheDocument();
  });

  it('Back button on pick-template returns to choose step', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-template'));
    await screen.findByTestId('template-picker');

    await user.click(screen.getByTestId('back-button'));
    expect(await screen.findByTestId('method-new')).toBeInTheDocument();
  });

  it('Back button on import step returns to choose step', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-import'));
    await screen.findByTestId('discovery-view');

    await user.click(screen.getByTestId('back-button'));
    expect(await screen.findByTestId('method-new')).toBeInTheDocument();
  });

  it('selecting a template in pick-template transitions to configure and shows Change button', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-template'));
    await user.click(await screen.findByTestId('select-template'));

    // Should advance to configure step
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    // Template indicator with Change link
    expect(screen.getByTestId('change-template')).toBeInTheDocument();
  });

  it('Change link on configure navigates back to pick-template', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-template'));
    await user.click(await screen.findByTestId('select-template'));
    await screen.findByTestId('change-template');

    await user.click(screen.getByTestId('change-template'));
    expect(await screen.findByTestId('template-picker')).toBeInTheDocument();
  });

  // ---- Footer visibility ----

  it('no footer (no Back or Create Agent) on choose step', async () => {
    renderDialog();
    useAgentCreationStore.getState().open();

    await screen.findByTestId('method-new');
    expect(screen.queryByTestId('back-button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Agent' })).not.toBeInTheDocument();
  });

  it('shows only Back button on import step (no Create Agent)', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-import'));
    await screen.findByTestId('discovery-view');

    expect(screen.getByTestId('back-button')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Agent' })).not.toBeInTheDocument();
  });

  it('shows Back and Create Agent buttons on configure step', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    await screen.findByLabelText('Name');

    expect(screen.getByTestId('back-button')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Agent' })).toBeInTheDocument();
  });

  // ---- Name validation ----

  it('shows inline validation error for invalid name', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'INVALID_NAME');

    expect(
      screen.getByText('Lowercase letters, numbers, and hyphens only. Must start with a letter.')
    ).toBeInTheDocument();
  });

  it('does not show error for valid kebab-case name', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'my-agent');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ---- Create button state ----

  it('disables Create Agent button when name is empty', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const createBtn = await screen.findByRole('button', { name: 'Create Agent' });
    expect(createBtn).toBeDisabled();
  });

  it('disables Create Agent button when name is invalid', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, '123bad');

    const createBtn = screen.getByRole('button', { name: 'Create Agent' });
    expect(createBtn).toBeDisabled();
  });

  it('enables Create Agent button when name is valid', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'my-agent');

    const createBtn = screen.getByRole('button', { name: 'Create Agent' });
    expect(createBtn).toBeEnabled();
  });

  // ---- Creation flow ----

  it('successful creation closes dialog, invalidates queries, and plays celebration', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockResolvedValue({
      id: 'test-id',
      name: 'my-agent',
    } as never);

    const { queryClient } = renderDialog(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'my-agent');
    await user.click(screen.getByRole('button', { name: 'Create Agent' }));

    await waitFor(() => {
      expect(transport.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'my-agent' })
      );
    });

    await waitFor(() => {
      expect(mockPlayCelebration).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['agents'] }));
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows error toast on failed creation', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.createAgent).mockRejectedValue(new Error('Agent already exists'));

    renderDialog(transport);
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'my-agent');
    await user.click(screen.getByRole('button', { name: 'Create Agent' }));

    const { toast } = await import('sonner');
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Agent already exists');
    });
  });

  // ---- Directory preview ----

  it('displays auto-generated directory path based on name', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByLabelText('Name');
    await user.type(nameInput, 'scout');

    expect(screen.getByTestId('directory-preview')).toHaveTextContent('~/.dork/agents/scout');
  });

  // ---- Back on configure (template path) ----

  it('Back on configure (template path) returns to pick-template', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    // Navigate: choose → pick-template → select template → configure
    await user.click(await screen.findByTestId('method-template'));
    await waitFor(() => expect(screen.getByTestId('template-picker')).toBeInTheDocument());
    await user.click(screen.getByTestId('select-template'));
    await waitFor(() => expect(screen.getByPlaceholderText('my-agent')).toBeInTheDocument());

    // Back should go to pick-template, not choose
    await user.click(screen.getByTestId('back-button'));
    await waitFor(() => {
      expect(screen.getByTestId('template-picker')).toBeInTheDocument();
    });
  });

  // ---- Template auto-fill ----

  it('pre-fills name from selected template', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-template'));
    await waitFor(() => expect(screen.getByTestId('template-picker')).toBeInTheDocument());
    await user.click(screen.getByTestId('select-template'));

    // Name should be auto-filled — the handler extracts last segment from the source URL
    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText('my-agent');
      expect(nameInput).toHaveValue('code-reviewer');
    });
  });

  it('shows auto-fill hint text when name was pre-filled from template', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-template'));
    await waitFor(() => expect(screen.getByTestId('template-picker')).toBeInTheDocument());
    await user.click(screen.getByTestId('select-template'));

    await waitFor(() => {
      expect(screen.getByTestId('auto-fill-hint')).toBeInTheDocument();
      expect(screen.getByText('Pre-filled from template — edit freely')).toBeInTheDocument();
    });
  });

  it('clears auto-fill hint when user edits the pre-filled name', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-template'));
    await waitFor(() => expect(screen.getByTestId('template-picker')).toBeInTheDocument());
    await user.click(screen.getByTestId('select-template'));

    await waitFor(() => expect(screen.getByTestId('auto-fill-hint')).toBeInTheDocument());

    // Edit the name — hint should disappear
    const nameInput = screen.getByPlaceholderText('my-agent');
    await user.type(nameInput, '-custom');

    await waitFor(() => {
      expect(screen.queryByTestId('auto-fill-hint')).not.toBeInTheDocument();
    });
  });

  // ---- Directory browser button ----

  it('shows directory picker when browse button is clicked', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    await screen.findByLabelText('Name');

    // Open the Advanced directory section
    await user.click(screen.getByTestId('directory-advanced-toggle'));

    // Click the browse button
    await user.click(await screen.findByTestId('browse-directory-button'));

    // Directory picker should appear
    expect(screen.getByTestId('directory-picker')).toBeInTheDocument();
  });

  it('sets directory override when a path is selected from the picker', async () => {
    const user = userEvent.setup();
    renderDialog();
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    await screen.findByLabelText('Name');

    // Open the Advanced directory section
    await user.click(screen.getByTestId('directory-advanced-toggle'));
    await user.click(await screen.findByTestId('browse-directory-button'));

    // Select a directory from the mock picker
    await user.click(screen.getByTestId('picker-select'));

    // The directory input should reflect the selected path
    await waitFor(() => {
      expect(screen.queryByTestId('directory-picker')).not.toBeInTheDocument();
    });
  });

  // ---- Conflict detection ----

  it('shows "Will create new directory" when path does not exist', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.browseDirectory).mockRejectedValue(new Error('ENOENT'));

    renderDialog(transport);
    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByPlaceholderText('my-agent');
    await user.type(nameInput, 'new-agent');

    await waitFor(() => {
      expect(screen.getByTestId('conflict-status')).toHaveTextContent('Will create new directory');
    });
  });

  it('shows "Directory exists" when path exists without .dork', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();

    // Override the default ENOENT mock after renderDialog sets it
    vi.mocked(transport.browseDirectory).mockResolvedValue({
      path: '/test',
      entries: [{ name: 'README.md', isDirectory: false }],
      parent: null,
    } as never);

    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByPlaceholderText('my-agent');
    await user.type(nameInput, 'existing-dir');

    await waitFor(() => {
      expect(screen.getByTestId('conflict-status')).toHaveTextContent(
        'Directory exists — will create project inside'
      );
    });
  });

  it('shows "Existing project detected" when path has .dork directory', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();

    vi.mocked(transport.browseDirectory).mockResolvedValue({
      path: '/test',
      entries: [{ name: '.dork', isDirectory: true }],
      parent: null,
    } as never);

    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByPlaceholderText('my-agent');
    await user.type(nameInput, 'taken-agent');

    await waitFor(() => {
      expect(screen.getByTestId('conflict-status')).toHaveTextContent('Existing project detected');
    });
  });

  it('shows "Cannot access this path" on permission error', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();

    vi.mocked(transport.browseDirectory).mockRejectedValue(new Error('EACCES: permission denied'));

    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByPlaceholderText('my-agent');
    await user.type(nameInput, 'restricted-agent');

    await waitFor(() => {
      expect(screen.getByTestId('conflict-status')).toHaveTextContent('Cannot access this path');
    });
  });

  it('shows "Import instead?" link when .dork conflict detected', async () => {
    const user = userEvent.setup();
    const { transport } = renderDialog();

    vi.mocked(transport.browseDirectory).mockResolvedValue({
      path: '/test',
      entries: [{ name: '.dork', isDirectory: true }],
      parent: null,
    } as never);

    useAgentCreationStore.getState().open();

    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByPlaceholderText('my-agent');
    await user.type(nameInput, 'taken-agent');

    await waitFor(() => {
      expect(screen.getByTestId('import-instead-link')).toBeInTheDocument();
    });

    // Clicking "Import instead?" should switch to import step
    await user.click(screen.getByTestId('import-instead-link'));
    await waitFor(() => {
      expect(screen.getByTestId('discovery-view')).toBeInTheDocument();
    });
  });

  // ---- Reset on close/reopen ----

  it('resets to choose step when dialog is closed and reopened', async () => {
    renderDialog();

    // Open on import step
    useAgentCreationStore.getState().open('import');
    await screen.findByTestId('discovery-view');

    // Close via store
    useAgentCreationStore.getState().close();
    await waitFor(() => {
      expect(screen.queryByTestId('discovery-view')).not.toBeInTheDocument();
    });

    // Reopen without argument — should show choose step
    useAgentCreationStore.getState().open();
    expect(await screen.findByTestId('method-new')).toBeInTheDocument();
  });

  it('resets form fields when dialog is closed via close button and reopened', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Open, navigate to configure, type a name
    useAgentCreationStore.getState().open();
    await user.click(await screen.findByTestId('method-new'));
    const nameInput = await screen.findByPlaceholderText('my-agent');
    await user.type(nameInput, 'some-agent');

    // Close via the dialog close button (triggers handleOpenChange → resetForm)
    const closeButton = screen.getByRole('button', { name: /close/i });
    await user.click(closeButton);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Reopen and go back to configure — name should be empty
    useAgentCreationStore.getState().open();
    await user.click(await screen.findByTestId('method-new'));
    const freshInput = await screen.findByPlaceholderText('my-agent');
    expect(freshInput).toHaveValue('');
  });
});
