/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TaskTemplate } from '@dorkos/shared/types';
import { createMockTransport, createMockSchedule } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { queryClient as appQueryClient } from '@/layers/shared/lib/query-client';
import { configKeys } from '@/layers/entities/config';
import { toast } from 'sonner';
import { CreateTaskDialog } from '../ui/CreateTaskDialog';

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#6366f1' },
  { id: 'agent-2', name: 'test-bot', projectPath: '/projects/test', icon: '🧪', color: '#22c55e' },
];

const MOCK_PRESETS: TaskTemplate[] = [
  {
    id: 'health-check',
    name: 'Health Check',
    description: 'Desc',
    prompt: 'Prompt health',
    cron: '0 8 * * 1',
    timezone: 'UTC',
  },
  {
    id: 'docs-sync',
    name: 'Docs Sync',
    description: 'Desc',
    prompt: 'Prompt docs',
    cron: '0 10 * * *',
    timezone: 'UTC',
  },
];

vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return { ...actual, toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) };
});

const mockTaskTemplateDialog = vi.fn().mockReturnValue({
  pendingTemplate: null,
  externalTrigger: false,
  clear: vi.fn(),
});

vi.mock('@/layers/entities/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/tasks')>();
  return {
    ...actual,
    useTaskTemplateDialog: () => mockTaskTemplateDialog(),
    useTaskTemplates: () => ({ data: MOCK_PRESETS, isLoading: false, isError: false }),
  };
});

// Mock PresetGallery to render a simple selectable list — avoids needing full TanStack Query setup
// and lets tests click preset names directly or use "Start from scratch"
vi.mock('../ui/TaskTemplateGallery', () => ({
  TaskTemplateGallery: ({ onSelect }: { onSelect?: (preset: TaskTemplate) => void }) => (
    <div data-testid="preset-gallery">
      {MOCK_PRESETS.map((p) => (
        <button key={p.id} onClick={() => onSelect?.(p)}>
          {p.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('cronstrue', () => ({
  default: {
    toString: (cron: string) => {
      if (cron === '0 9 * * 1-5') return 'At 09:00 AM, Monday through Friday';
      if (cron === '0 9 * * 1,2,3,4,5') return 'At 09:00 AM, Monday through Friday';
      if (cron === 'invalid') throw new Error('Invalid cron');
      return `Cron: ${cron}`;
    },
  },
}));

/**
 * The schedule save confirm says exactly this and nothing else (DOR-3841
 * design review): the stop in the title, the consequence as its description,
 * the line about DorkOS's own actions, and the two buttons. The mode's own
 * sentence and what it covers are already on the form behind it.
 */
function expectScheduleConfirm(confirm: HTMLElement, stop: string, promise: string) {
  expect(within(confirm).getByRole('heading')).toHaveTextContent(`Turn on ${stop}`);
  expect(confirm).toHaveAccessibleDescription(
    'Every run of this schedule acts on its own. Nobody is asked first.'
  );
  expect(confirm).toHaveTextContent(
    'DorkOS’s own actions, like deleting a schedule, follow your Permissions settings.'
  );
  expect(confirm).not.toHaveTextContent(promise);
  expect(confirm).not.toHaveTextContent(/This covers editing files/);
  expect(confirm).not.toHaveTextContent(/To stop an ask/);
  expect(within(confirm).queryByTestId('consent-asks-note')).toBeNull();
  expect(
    within(confirm)
      .getAllByRole('button')
      .map((b) => b.textContent)
  ).toEqual(['Cancel', `Turn on ${stop}`]);
}

function createWrapper(transport: Transport, seed?: (client: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  seed?.(queryClient);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('CreateTaskDialog', () => {
  beforeAll(() => {
    // ResponsiveDialog uses useIsMobile which calls window.matchMedia
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
    // cmdk uses ResizeObserver and scrollIntoView internally
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = vi.fn();
    // Radix Select needs the pointer-capture APIs jsdom lacks before it will
    // open its listbox under userEvent — the same shims the settings rows install.
    const proto = Element.prototype as unknown as Record<string, unknown>;
    if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
    if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskTemplateDialog.mockReturnValue({
      pendingTemplate: null,
      externalTrigger: false,
      clear: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Open the form's Schedule section.
   *
   * It is shut on a new task and open on one that already has a schedule. The
   * shared disclosure card the form now uses unmounts what it hides (DOR-1759),
   * so a case that types a cron opens it first, exactly as a person does.
   */
  function openSchedule() {
    fireEvent.click(screen.getByRole('button', { name: /^Schedule/ }));
  }

  /**
   * Open the form's Advanced settings section, always shut at rest.
   *
   * Awaits the trigger: leaving the template gallery is not synchronous, so a
   * case that opens the section right after "Start from scratch" would reach for
   * a form that has not arrived.
   */
  async function openAdvanced() {
    fireEvent.click(await screen.findByRole('button', { name: /Advanced settings/ }));
  }

  it('submits create with correct payload', async () => {
    const newSchedule = createMockSchedule({ id: 'sched-new' });
    const transport = createMockTransport({
      createTask: vi.fn().mockResolvedValue(newSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateTaskDialog
          open={true}
          onOpenChange={onOpenChange}
          viewerTimezone={() => 'America/Chicago'}
        />
      </Wrapper>
    );

    // Advance past preset-picker step to the form
    fireEvent.click(screen.getByText('Start from scratch'));

    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Nightly build' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings…'),
      { target: { value: 'Run the nightly build' } }
    );

    // ScheduleBuilder starts empty. Switch to cron mode and type a cron expression.
    openSchedule();
    // The picker's default names the zone it will send (DOR-4120).
    expect(screen.getByRole('button', { name: 'Your time zone (America/Chicago)' })).toBeTruthy();
    fireEvent.click(screen.getByText('Use a cron expression'));
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 0 * * *' },
    });

    // Create waits until the runtime's modes are read (DOR-3841).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled());
    fireEvent.click(screen.getByText('Create task'));

    await waitFor(() => {
      expect(transport.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Nightly build',
          prompt: 'Run the nightly build',
          cron: '0 0 * * *',
          timezone: 'America/Chicago',
          permissionMode: 'acceptEdits',
        })
      );
    });
  });

  it('sends sticky when the toggle is on, and omits it otherwise (DOR-1571)', async () => {
    const transport = createMockTransport({
      createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-sticky' })),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    fireEvent.click(screen.getByText('Start from scratch'));
    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Standup digest' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings…'),
      { target: { value: 'Summarise what changed' } }
    );
    openSchedule();
    fireEvent.click(screen.getByText('Use a cron expression'));
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 9 * * *' },
    });

    // Flip the sticky toggle on, then create.
    await openAdvanced();
    fireEvent.click(screen.getByRole('switch', { name: /remember the last run/i }));
    fireEvent.click(screen.getByText('Create task'));

    await waitFor(() => {
      expect(transport.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Standup digest', sticky: true })
      );
    });
  });

  it('keeps an advanced answer after the section is closed again (DOR-1759)', async () => {
    // The disclosure card unmounts what it hides, where the old `<details>` only
    // hid it. A setting a person made and then folded away must still be the one
    // that is saved — the form owns the value, not the field on screen.
    const transport = createMockTransport({
      createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-folded' })),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    fireEvent.click(screen.getByText('Start from scratch'));
    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Folded away' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings…'),
      { target: { value: 'Still sticky' } }
    );

    await openAdvanced();
    fireEvent.click(screen.getByRole('switch', { name: /remember the last run/i }));
    // Close it again — the switch leaves the page entirely.
    await openAdvanced();
    expect(screen.queryByRole('switch', { name: /remember the last run/i })).toBeNull();

    fireEvent.click(screen.getByText('Create task'));

    await waitFor(() => {
      expect(transport.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Folded away', sticky: true })
      );
    });
  });

  it('submits update with correct ID in edit mode', async () => {
    const schedule = createMockSchedule({
      id: 'sched-42',
      name: 'Old Name',
      prompt: 'Old prompt',
      cron: '0 9 * * 1-5',
    });
    const updatedSchedule = createMockSchedule({ id: 'sched-42', name: 'New Name' });
    const transport = createMockTransport({
      updateTask: vi.fn().mockResolvedValue(updatedSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={onOpenChange} editTask={schedule} />
      </Wrapper>
    );

    // Wait for useEffect to populate the form
    await waitFor(() => {
      expect(screen.getByDisplayValue('Old Name')).toBeTruthy();
    });

    fireEvent.change(screen.getByDisplayValue('Old Name'), {
      target: { value: 'New Name' },
    });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(transport.updateTask).toHaveBeenCalledWith(
        'sched-42',
        expect.objectContaining({ name: 'New Name' })
      );
    });
  });

  describe('saving an edit', () => {
    it('sends only the fields the person changed', async () => {
      // Purpose (DOR-2302): the form used to send every field, and the server
      // acts on each one it receives. `maxRuntime` alone made every save look
      // like a file rewrite, so a package's schedule — whose file DorkOS never
      // writes — could not be saved at all, not even to change when it runs.
      const schedule = createMockSchedule({ id: 'sched-7', name: 'nightly', prompt: 'Old prompt' });
      const transport = createMockTransport({
        updateTask: vi.fn().mockResolvedValue(schedule),
      });
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );
      await waitFor(() => expect(screen.getByDisplayValue('Old prompt')).toBeTruthy());

      fireEvent.change(screen.getByDisplayValue('Old prompt'), { target: { value: 'New prompt' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith('sched-7', { prompt: 'New prompt' })
      );
    });

    it('moves a UTC schedule to the person’s zone when they pick “Your time zone” (DOR-4120)', async () => {
      // Purpose: an edit sends a zone only when the field names one, so the
      // default entry must write the real zone, or the save leaves UTC alone.
      const schedule = createMockSchedule({ id: 'sched-9', timezone: 'UTC' });
      const transport = createMockTransport({
        updateTask: vi.fn().mockResolvedValue(schedule),
      });
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog
            open={true}
            onOpenChange={vi.fn()}
            editTask={schedule}
            viewerTimezone={() => 'America/Chicago'}
          />
        </Wrapper>
      );
      await waitFor(() => expect(screen.getByDisplayValue('Review open PRs')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'UTC' }));
      fireEvent.click(screen.getByText('Your time zone (America/Chicago)'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith('sched-9', {
          timezone: 'America/Chicago',
        })
      );
    });

    it('closes without a request when nothing changed', async () => {
      // Purpose: an empty save is not a write; sending one would still wake the
      // server's approval and file logic for nothing.
      const schedule = createMockSchedule({ id: 'sched-8' });
      const transport = createMockTransport({ updateTask: vi.fn() });
      const onOpenChange = vi.fn();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={onOpenChange} editTask={schedule} />
        </Wrapper>
      );
      await waitFor(() => expect(screen.getByDisplayValue('Review open PRs')).toBeTruthy());

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(transport.updateTask).not.toHaveBeenCalled();
    });
  });

  describe('a schedule that came with an installed package (DOR-2272)', () => {
    /** The refusal the server sends, carried the way the HTTP transport throws it. */
    const REFUSAL =
      'This schedule came with the "helper" package, so DorkOS didn\'t change it: the ' +
      "package's next update would put its own version back. You can switch it on or off, " +
      'or change when it runs, here. To change what it does, make your own copy.';
    const refused = (ownedBy: 'record' | 'legacy' = 'record') =>
      Object.assign(new Error(REFUSAL), {
        code: 'schedule_package_owned',
        status: 409,
        body: { error: REFUSAL, code: 'schedule_package_owned', ownedBy },
      });

    /** A package's schedule as the app lists it. */
    const packaged = (packageOwned: 'record' | 'legacy' | null) =>
      createMockSchedule({
        id: 'sched-pkg',
        name: 'nightly-sweep',
        prompt: 'The package sweeps.',
        cron: '0 3 * * *',
        agentId: 'agent-1',
        packageOwned,
      });

    /** Open a schedule in the edit dialog. */
    async function open(transport: Transport, task = packaged('record')) {
      const Wrapper = createWrapper(transport);
      const view = render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={task} />
        </Wrapper>
      );
      await waitFor(() => expect(screen.getByDisplayValue('The package sweeps.')).toBeTruthy());
      return view;
    }

    const transportWith = (overrides: Partial<Transport> = {}) =>
      createMockTransport({
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
        ...overrides,
      });

    it('says so as it opens, and leaves only the switch and the timing editable', async () => {
      // Purpose: the person learns what they can change before they try, not
      // from a refusal after typing (UX decision on the DOR-2272 review).
      await open(transportWith());

      expect(
        screen.getByText(
          'This schedule came with a package. Only the package can change what it does.'
        )
      ).toBeTruthy();
      expect(
        screen.getByText('To change its permission or anything else, make a copy.')
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Make a copy' })).toBeTruthy();
      expect(screen.getByDisplayValue('nightly-sweep')).toBeDisabled();
      expect(screen.getByDisplayValue('The package sweeps.')).toBeDisabled();
      expect(screen.getByLabelText('Disable schedule')).not.toBeDisabled();
      expect(screen.getByRole('combobox', { name: 'Frequency' })).not.toBeDisabled();
    });

    it("leaves a person's own schedule fully editable", async () => {
      // Purpose: only a package's schedule is locked; the over-locking direction.
      await open(transportWith(), packaged(null));

      expect(screen.getByDisplayValue('The package sweeps.')).not.toBeDisabled();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('makes a copy for the same agent and switches the package’s schedule off', async () => {
      // Purpose: the copy is a new schedule the person owns, created only when
      // they press Create, and by default the package's own stops running so
      // the same work does not run twice.
      const transport = transportWith({
        updateTask: vi.fn().mockResolvedValue(packaged('record')),
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-mine' })),
      });
      await open(transport);

      fireEvent.click(screen.getByRole('button', { name: 'Make a copy' }));

      expect(await screen.findByText('New schedule')).toBeTruthy();
      expect(screen.getByDisplayValue('nightly-sweep-copy')).toBeTruthy();
      expect(screen.getByDisplayValue('The package sweeps.')).not.toBeDisabled();
      expect(screen.getByLabelText('Switch off the package’s schedule')).toBeChecked();
      fireEvent.change(screen.getByDisplayValue('The package sweeps.'), {
        target: { value: 'I sweep my way.' },
      });
      expect(transport.createTask).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled()
      );
      fireEvent.click(screen.getByText('Create task'));

      await waitFor(() =>
        expect(transport.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'nightly-sweep-copy',
            prompt: 'I sweep my way.',
            target: 'agent-1',
            cron: '0 3 * * *',
          })
        )
      );
      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith('sched-pkg', { enabled: false })
      );
    });

    it('asks once before creating a copy of a package’s schedule at Full (DOR-3841)', async () => {
      // A copy is a NEW schedule, so its Full mode is a new choice even though
      // the person never touched the dial.
      const transport = transportWith({
        updateTask: vi.fn().mockResolvedValue(packaged('record')),
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-mine' })),
      });
      await open(transport, { ...packaged('record'), permissionMode: 'bypassPermissions' });

      fireEvent.click(screen.getByRole('button', { name: 'Make a copy' }));
      expect(await screen.findByText('New schedule')).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByRole('radio', { name: 'Full autonomy' })).toBeChecked()
      );
      const create = await screen.findByRole('button', { name: 'Create task' });
      await waitFor(() => expect(create).toBeEnabled());
      fireEvent.click(create);

      const confirm = await screen.findByRole('alertdialog');
      expect(transport.createTask).not.toHaveBeenCalled();
      fireEvent.click(within(confirm).getByRole('button', { name: 'Turn on Full autonomy' }));
      await waitFor(() =>
        expect(transport.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'nightly-sweep-copy',
            permissionMode: 'bypassPermissions',
          })
        )
      );
    });

    it('leaves the package’s schedule running when the person unticks it', async () => {
      const transport = transportWith({
        updateTask: vi.fn(),
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-mine' })),
      });
      await open(transport);
      fireEvent.click(screen.getByRole('button', { name: 'Make a copy' }));
      fireEvent.click(await screen.findByLabelText('Switch off the package’s schedule'));

      fireEvent.click(screen.getByText('Create task'));

      await waitFor(() => expect(transport.createTask).toHaveBeenCalled());
      expect(transport.updateTask).not.toHaveBeenCalled();
    });

    /** Render against the app's own query client, whose mutation cache owns the toast. */
    const renderWithAppClient = (transport: Transport) =>
      render(
        <QueryClientProvider client={appQueryClient}>
          <TransportProvider transport={transport}>
            <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={packaged(null)} />
          </TransportProvider>
        </QueryClientProvider>
      );

    /** Change the prompt and save. */
    const save = async () => {
      await waitFor(() => expect(screen.getByDisplayValue('The package sweeps.')).toBeTruthy());
      fireEvent.change(screen.getByDisplayValue('The package sweeps.'), {
        target: { value: 'I sweep my way.' },
      });
      fireEvent.click(screen.getByText('Save'));
    };

    it('toasts the refusal when the dialog closed before the server answered', async () => {
      // Purpose: the inline notice only stands in for the toast while it is on
      // screen; a refusal landing after Cancel would otherwise reach nobody
      // (DOR-2272 review).
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let reject: (err: Error) => void = () => {};
      const transport = transportWith({
        updateTask: vi.fn(
          () =>
            new Promise((_, rej) => {
              reject = rej;
            })
        ) as never,
      });
      const view = renderWithAppClient(transport);
      await save();
      await waitFor(() => expect(transport.updateTask).toHaveBeenCalled());

      view.unmount();
      reject(refused());

      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    });
  });

  describe('an invalid cron expression', () => {
    /** Advance a blank dialog to the form, fill the required fields, and type `cron`. */
    function fillFormWithCron(cron: string) {
      fireEvent.click(screen.getByText('Start from scratch'));
      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Nightly build' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings…'),
        { target: { value: 'Run the nightly build' } }
      );
      openSchedule();
      fireEvent.click(screen.getByText('Use a cron expression'));
      fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), { target: { value: cron } });
    }

    it('blocks the save the form was already calling invalid', async () => {
      // The builder printed "Invalid cron expression" in red and Create stayed
      // live right beside it, so the schedule went to the server anyway.
      const transport = createMockTransport({
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' })),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fillFormWithCron('invalid');

      expect(screen.getByText('Can’t read this timing. Check the format.')).toBeTruthy();
      const create = screen.getByRole('button', { name: 'Create task' });
      expect(create).toBeDisabled();

      // And clicking it anyway sends nothing.
      fireEvent.click(create);
      await waitFor(() => expect(transport.createTask).not.toHaveBeenCalled());
    });

    it('says why Create is dead, outside the section that can hide the warning', async () => {
      // The red cron warning lives inside the collapsible Schedule section. With
      // it collapsed, a disabled Create button had no visible reason at all.
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fillFormWithCron('invalid');

      const note = screen.getByTestId('cron-blocks-save');
      expect(note).toHaveTextContent(/Fix the timing under Schedule/);
      // Outside the disclosure card, so closing the section cannot take it away.
      expect(note.closest('[data-slot="collapsible-field-card"]')).toBeNull();
    });

    it('releases the save once the expression reads back', async () => {
      const transport = createMockTransport({
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' })),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fillFormWithCron('invalid');
      expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();

      fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
        target: { value: '0 0 * * *' },
      });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Create task' })).not.toBeDisabled()
      );
    });
  });

  describe('the enable switch in edit mode', () => {
    /** Render an edit dialog whose schedule starts enabled, with a failing update. */
    async function renderWithFailingToggle() {
      const schedule = createMockSchedule({ id: 'sched-1', name: 'Nightly', enabled: true });
      const transport = createMockTransport({
        updateTask: vi.fn().mockRejectedValue(new Error('Server said no')),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => expect(screen.getByRole('switch', { name: /schedule/i })).toBeChecked());
      return transport;
    }

    it('goes back to where it was when the change did not save', async () => {
      // The switch moves optimistically. It never moved back, so a failed PATCH
      // left the dialog saying a schedule was off while its cron kept firing.
      const transport = await renderWithFailingToggle();

      fireEvent.click(screen.getByRole('switch', { name: /schedule/i }));
      // Optimistic: it reads "off" straight away.
      expect(screen.getByRole('switch', { name: /schedule/i })).not.toBeChecked();

      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith('sched-1', {
          enabled: false,
        })
      );
      await waitFor(() => expect(screen.getByRole('switch', { name: /schedule/i })).toBeChecked());
    });

    it('cannot issue a second change while the first is still in flight', async () => {
      // The rollback race. Two overlapping `mutate()` calls on one observer
      // detach the first, so the FIRST call's `onError` never runs. Off→on with
      // both failing then left the switch reading "off" while the server's
      // schedule was still ON — the exact false-off lie this fix exists to
      // remove, and worse than doing nothing. Two locks hold it shut: the switch
      // is disabled while a change is in flight, and the rollback goes to the
      // server's answer rather than a stale pre-click snapshot.
      const schedule = createMockSchedule({ id: 'sched-1', name: 'Nightly', enabled: true });
      let rejectFirst: (reason: Error) => void = () => {};
      const updateTask = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            })
        )
        .mockRejectedValue(new Error('Server said no'));
      const transport = createMockTransport({ updateTask });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => expect(screen.getByRole('switch', { name: /schedule/i })).toBeChecked());

      // First toggle: off. It hangs, so the change is in flight.
      fireEvent.click(screen.getByRole('switch', { name: /schedule/i }));
      expect(screen.getByRole('switch', { name: /schedule/i })).not.toBeChecked();
      await waitFor(() => expect(screen.getByRole('switch', { name: /schedule/i })).toBeDisabled());

      // Second toggle, mid-flight. The disabled switch must swallow it — this is
      // the click that used to detach the first mutation's observer.
      fireEvent.click(screen.getByRole('switch', { name: /schedule/i }));
      expect(updateTask).toHaveBeenCalledTimes(1);

      // Now let the first one fail.
      rejectFirst(new Error('Server said no'));

      // The switch goes back to what the server actually holds: ON.
      await waitFor(() => expect(screen.getByRole('switch', { name: /schedule/i })).toBeChecked());
      expect(screen.getByRole('switch', { name: /schedule/i })).not.toBeDisabled();
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask).toHaveBeenCalledWith('sched-1', { enabled: false });
    });
  });

  describe('the trust dial', () => {
    it('warns that Accept edits cannot ask on a scheduled run (DOR-3123 A1)', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));

      // `acceptEdits` still asks before commands, and nobody is there to answer.
      // The runtime turns the ask down AT ONCE and the turn CARRIES ON. It does
      // not park until the run's time limit (what this note said first), and it
      // no longer waits ten minutes either (spec
      // `unattended-session-permission-prompts`).
      const note = await screen.findByTestId('task-unattended-warning');
      expect(note).toHaveTextContent(/Nobody is there to approve asks on a scheduled run/);
      expect(note).toHaveTextContent(/Each ask is refused, so the run will need attention/);
      // The way out is Never ask with an allow list — never Full autonomy,
      // which no surface offers as a fix (spec `schedules-failing` SF-18).
      expect(note).toHaveTextContent(/Use Never ask with an allow list for the commands it needs/);
      expect(note).not.toHaveTextContent(/Full autonomy/);
      // A "Run now" is answerable, and the note has to say so or the person
      // reads the whole schedule as one that never asks.
      expect(note).toHaveTextContent(/Run now/);
      expect(note).not.toHaveTextContent(/time limit/);
      expect(note).not.toHaveTextContent(/10 minutes/);
    });

    it('speaks the vocabulary of the runtime the task will actually run on', async () => {
      // This used to be pinned to `claude-code`, because the scheduler's runtime
      // was one object bound at boot. A task carries its own runtime now
      // (DOR-1615), so the dial follows the resolved one: no agent and no
      // override means the registry default, and picking a runtime moves it.
      // Read against the OLD behaviour this fails twice — the opening caption
      // would be Claude Code's, and it would not move.
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockResolvedValue({
          defaultRuntime: 'codex',
          capabilities: {
            'claude-code': {
              type: 'claude-code',
              supportsToolApproval: true,
              supportsCostTracking: false,
              supportsResume: true,
              supportsMcp: true,
              supportsQuestionPrompt: true,
              supportsPlugins: true,
              permissionModes: {
                supported: true,
                values: [
                  {
                    id: 'acceptEdits',
                    label: 'Accept edits',
                    stop: 'act',
                    asks: 'when-risky',
                    reach: 'edit',
                    promise: 'Edits files on its own. Asks before it runs a command.',
                  },
                ],
              },
              features: {},
            },
            codex: {
              type: 'codex',
              supportsToolApproval: true,
              supportsCostTracking: false,
              supportsResume: true,
              supportsMcp: true,
              supportsQuestionPrompt: false,
              supportsPlugins: false,
              permissionModes: {
                supported: true,
                values: [
                  {
                    id: 'acceptEdits',
                    label: 'Workspace write',
                    stop: 'act',
                    asks: 'never',
                    reach: 'workspace',
                    promise:
                      'Edits files and runs commands inside the workspace — Codex can’t pause to ask.',
                  },
                ],
              },
              features: {},
            },
          },
        }),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      await openAdvanced();

      // Nothing overridden and no agent: the run lands on the registry default,
      // and the dial says what THAT runtime promises.
      await waitFor(() =>
        expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(/can’t pause to ask/)
      );
      // Codex never asks, so the note about an ask nobody answers has nothing to
      // warn about — it is gated on the declared `asks`, not on a mode id.
      expect(screen.queryByTestId('task-unattended-warning')).toBeNull();

      // Move the task onto Claude Code and the whole vocabulary moves with it.
      const user = userEvent.setup();
      await user.click(screen.getByTestId('task-runtime-select'));
      await user.click(await screen.findByRole('option', { name: 'Claude Code' }));

      await waitFor(() =>
        expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(
          'Edits files on its own. Asks before it runs a command.'
        )
      );
      expect(screen.getByTestId('task-unattended-warning')).toBeInTheDocument();
    });

    it('never offers planning as a level of trust', async () => {
      // At the Ask stop, where a `plan` that lost its `axis: 'working'` would
      // surface as a refinement SWITCH rather than a fourth radio.
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const schedule = createMockSchedule({ id: 'sched-default', permissionMode: 'default' });

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => expect(screen.getByRole('radio', { name: 'Ask first' })).toBeChecked());
      expect(screen.queryByRole('radio', { name: /plan/i })).toBeNull();
      expect(screen.queryByRole('switch', { name: /plan/i })).toBeNull();
    });
  });

  describe('the level up front, and the one confirm at Full (DOR-3841)', () => {
    /** Fill the two required fields of a blank new schedule. */
    function fillRequired() {
      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Nightly build' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings…'),
        { target: { value: 'Run the nightly build' } }
      );
    }

    it('asks once before creating at Full autonomy, and Cancel saves nothing', async () => {
      const transport = createMockTransport({
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' })),
      });
      const Wrapper = createWrapper(transport);
      const onOpenChange = vi.fn();

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={onOpenChange} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fillRequired();
      await screen.findByRole('radiogroup', { name: /how much/i });
      fireEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));
      // The pick itself takes no confirm.
      expect(screen.queryByRole('alertdialog')).toBeNull();

      fireEvent.click(screen.getByText('Create task'));
      let confirm = await screen.findByRole('alertdialog');
      expectScheduleConfirm(
        confirm,
        'Full autonomy',
        'Runs everything without asking, including outside this project.'
      );
      expect(transport.createTask).not.toHaveBeenCalled();

      fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(transport.createTask).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      // The form is as it was: still at Full, still unsaved.
      expect(screen.getByRole('radio', { name: 'Full autonomy' })).toBeChecked();

      fireEvent.click(screen.getByText('Create task'));
      confirm = await screen.findByRole('alertdialog');
      fireEvent.click(within(confirm).getByRole('button', { name: 'Turn on Full autonomy' }));
      await waitFor(() =>
        expect(transport.createTask).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Nightly build', permissionMode: 'bypassPermissions' })
        )
      );
      expect(transport.createTask).toHaveBeenCalledTimes(1);
    });

    it('creates below Full with no confirm', async () => {
      const transport = createMockTransport({
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' })),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fillRequired();
      await screen.findByRole('radiogroup', { name: /how much/i });
      fireEvent.click(screen.getByRole('radio', { name: 'Ask first' }));

      fireEvent.click(screen.getByText('Create task'));
      await waitFor(() =>
        expect(transport.createTask).toHaveBeenCalledWith(
          expect.objectContaining({ permissionMode: 'default' })
        )
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('asks before an edit moves a schedule into Full autonomy', async () => {
      const schedule = createMockSchedule({ id: 'sched-ae', permissionMode: 'acceptEdits' });
      const transport = createMockTransport({
        updateTask: vi.fn().mockResolvedValue(schedule),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Act' })).toBeChecked());
      fireEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));
      fireEvent.click(screen.getByText('Save'));

      const confirm = await screen.findByRole('alertdialog');
      expect(transport.updateTask).not.toHaveBeenCalled();
      fireEvent.click(within(confirm).getByRole('button', { name: 'Turn on Full autonomy' }));
      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith(
          'sched-ae',
          expect.objectContaining({ permissionMode: 'bypassPermissions' })
        )
      );
    });

    it('asks for a new schedule that opens at Full from the owner’s default, untouched', async () => {
      // Trusted by default: the owner's stop is Full, so a new schedule opens
      // there with nobody touching the dial. Saving it is still a choice.
      const transport = createMockTransport({
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' })),
      });
      const [capabilities, config] = await Promise.all([
        transport.getCapabilities(),
        transport.getConfig(),
      ]);
      const Wrapper = createWrapper(transport, (client) => {
        client.setQueryData(['capabilities'], capabilities);
        client.setQueryData(configKeys.current(), {
          ...config,
          executionDefaults: { trustStop: 'autonomy', perRuntime: [] },
        });
      });

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fillRequired();
      await waitFor(() =>
        expect(screen.getByRole('radio', { name: 'Full autonomy' })).toBeChecked()
      );

      fireEvent.click(screen.getByText('Create task'));
      await screen.findByRole('alertdialog');
      expect(transport.createTask).not.toHaveBeenCalled();
    });

    it('creates once when Create is pressed again while saving', async () => {
      // The button used to read a pending flag from mutations the form never
      // used, so it stayed live while the real save was in flight.
      const transport = createMockTransport({
        createTask: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fillRequired();
      await screen.findByRole('radiogroup', { name: /how much/i });
      fireEvent.click(screen.getByRole('radio', { name: 'Ask first' }));

      fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
      const saving = await screen.findByRole('button', { name: 'Saving…' });
      expect(saving).toBeDisabled();
      fireEvent.click(saving);
      fireEvent.submit(document.getElementById('schedule-form')!);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(transport.createTask).toHaveBeenCalledTimes(1);
    });

    it('holds Create until the modes are known, then asks for a never-asking Act', async () => {
      // Before the runtime list answers, Codex's Act (never asks) and Claude
      // Code's (asks) look alike, so a save then would skip the confirm.
      let answer: (value: unknown) => void = () => {};
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            answer = resolve;
          })
        ),
        createTask: vi.fn().mockResolvedValue(createMockSchedule({ id: 'sched-new' })),
      });
      const codex = (await createMockTransport().getCapabilities()).capabilities.codex!;
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fillRequired();
      const create = screen.getByRole('button', { name: 'Create task' });
      expect(create).toBeDisabled();
      fireEvent.click(create);
      expect(transport.createTask).not.toHaveBeenCalled();

      answer({ defaultRuntime: 'codex', capabilities: { codex } });
      await waitFor(() => expect(create).toBeEnabled());
      fireEvent.click(create);
      const confirm = await screen.findByRole('alertdialog');
      expectScheduleConfirm(confirm, 'Act', codex.permissionModes!.values[1]!.promise);
      expect(transport.createTask).not.toHaveBeenCalled();
    });

    it('never holds Create shut when the runtime list cannot be read', async () => {
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockRejectedValue(new Error('unreachable')),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fillRequired();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled()
      );
    });

    it('does not ask again when a Full schedule is saved still at Full', async () => {
      const schedule = createMockSchedule({
        id: 'sched-full',
        name: 'Old Name',
        permissionMode: 'bypassPermissions',
      });
      const transport = createMockTransport({
        updateTask: vi.fn().mockResolvedValue(schedule),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );
      await waitFor(() =>
        expect(screen.getByRole('radio', { name: 'Full autonomy' })).toBeChecked()
      );
      fireEvent.change(screen.getByDisplayValue('Old Name'), { target: { value: 'New Name' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith(
          'sched-full',
          expect.objectContaining({ name: 'New Name' })
        )
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  describe('a task set to a mode this form does not offer', () => {
    // The form offers the stops its runtime declares. It used to coerce anything
    // else to "Allow file edits" when it loaded the task, so opening a
    // `plan`-mode task to fix a typo in its prompt and pressing Save widened what
    // it may do — silently, and without the person ever touching the setting.

    it('shows the real mode instead of pretending it is one of the stops', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const schedule = createMockSchedule({ id: 'sched-plan', permissionMode: 'plan' });

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      const note = await screen.findByTestId('trust-dial-stranded');
      // The runtime's own word ("Plan"), not the id table's ("Plan Mode").
      expect(note).toHaveTextContent(/“Plan”/);
      expect(note).toHaveTextContent('Saving keeps it.');
      const dial = screen.getByRole('radiogroup', { name: /how much/i });
      expect(within(dial).queryAllByRole('radio', { checked: true })).toHaveLength(0);
    });

    it('keeps it when an unrelated edit is saved', async () => {
      const schedule = createMockSchedule({
        id: 'sched-plan',
        name: 'Old Name',
        prompt: 'Old prompt',
        permissionMode: 'plan',
      });
      const transport = createMockTransport({
        updateTask: vi.fn().mockResolvedValue(schedule),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByDisplayValue('Old Name')).toBeTruthy();
      });
      fireEvent.change(screen.getByDisplayValue('Old Name'), { target: { value: 'New Name' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(transport.updateTask).toHaveBeenCalledWith(
          'sched-plan',
          expect.objectContaining({ name: 'New Name' })
        );
      });
      // Not sent at all: an edit carries only what the person changed, so a
      // mode nobody touched cannot be widened — or even restated — by a save.
      expect(vi.mocked(transport.updateTask).mock.calls[0]?.[1]).not.toHaveProperty(
        'permissionMode'
      );
    });

    it('replaces it when the person picks a stop on purpose', async () => {
      const schedule = createMockSchedule({
        id: 'sched-dontask',
        name: 'Old Name',
        permissionMode: 'dontAsk',
      });
      const transport = createMockTransport({
        updateTask: vi.fn().mockResolvedValue(schedule),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByDisplayValue('Old Name')).toBeTruthy();
      });
      await screen.findByTestId('trust-dial-stranded');
      fireEvent.click(screen.getByRole('radio', { name: 'Act' }));
      expect(screen.queryByTestId('trust-dial-stranded')).toBeNull();

      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(transport.updateTask).toHaveBeenCalledWith(
          'sched-dontask',
          expect.objectContaining({ permissionMode: 'acceptEdits' })
        );
      });
    });
  });

  describe('two-step flow', () => {
    it('advances to form step when a preset card is clicked', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      // PresetGallery mock renders buttons with preset names
      fireEvent.click(screen.getByText('Health Check'));
      await waitFor(() => {
        expect(screen.getByDisplayValue('Health Check')).toBeTruthy();
      });
      expect(screen.getByDisplayValue('Prompt health')).toBeTruthy();
    });

    it('returns to picker step when Back is clicked', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      fireEvent.click(screen.getByLabelText('Back to preset picker'));
      expect(screen.getByText('Start from scratch')).toBeTruthy();
    });

    it('resets to preset-picker step when dialog closes and reopens', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const { rerender } = render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      // Advance to form
      fireEvent.click(screen.getByText('Start from scratch'));
      // Close dialog
      rerender(
        <Wrapper>
          <CreateTaskDialog open={false} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      // Reopen dialog
      rerender(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      expect(screen.getByText('Start from scratch')).toBeTruthy();
    });
  });
});
