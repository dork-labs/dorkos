/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TaskTemplate } from '@dorkos/shared/types';
import { createMockTransport, createMockSchedule } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
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

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
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

  it('shows "New Schedule" title in create mode', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByText('New Schedule')).toBeTruthy();
  });

  it('shows "Edit Schedule" title when editSchedule is provided', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);
    const schedule = createMockSchedule({ id: 'sched-1', name: 'My Schedule' });

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
      </Wrapper>
    );

    expect(screen.getByText('Edit Schedule')).toBeTruthy();
  });

  it('pre-fills form fields in edit mode', async () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);
    const schedule = createMockSchedule({
      id: 'sched-1',
      name: 'Daily review',
      prompt: 'Review open PRs',
      cron: '0 9 * * 1-5',
      permissionMode: 'bypassPermissions',
      maxRuntime: 300_000,
    });

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
      </Wrapper>
    );

    // useEffect populates fields after initial render
    await waitFor(() => {
      expect(screen.getByDisplayValue('Daily review')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('Review open PRs')).toBeTruthy();
    // ScheduleBuilder parses the cron and shows weekly preview
    expect(screen.getByText(/every weekday/i)).toBeTruthy();
  });

  it('submits create with correct payload', async () => {
    const newSchedule = createMockSchedule({ id: 'sched-new' });
    const transport = createMockTransport({
      createTask: vi.fn().mockResolvedValue(newSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={onOpenChange} />
      </Wrapper>
    );

    // Advance past preset-picker step to the form
    fireEvent.click(screen.getByText('Start from scratch'));

    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Nightly build' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
      { target: { value: 'Run the nightly build' } }
    );

    // ScheduleBuilder starts empty. Switch to cron mode and type a cron expression.
    fireEvent.click(screen.getByText('Use a cron expression'));
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 0 * * *' },
    });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(transport.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Nightly build',
          prompt: 'Run the nightly build',
          cron: '0 0 * * *',
          permissionMode: 'acceptEdits',
        })
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

  describe('an invalid cron expression', () => {
    /** Advance a blank dialog to the form, fill the required fields, and type `cron`. */
    function fillFormWithCron(cron: string) {
      fireEvent.click(screen.getByText('Start from scratch'));
      fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
        target: { value: 'Nightly build' },
      });
      fireEvent.change(
        screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
        { target: { value: 'Run the nightly build' } }
      );
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

      expect(screen.getByText('Invalid cron expression')).toBeTruthy();
      const create = screen.getByRole('button', { name: 'Create' });
      expect(create).toBeDisabled();

      // And clicking it anyway sends nothing.
      fireEvent.click(create);
      await waitFor(() => expect(transport.createTask).not.toHaveBeenCalled());
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
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

      fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
        target: { value: '0 0 * * *' },
      });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled()
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

      await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
      return transport;
    }

    it('goes back to where it was when the change did not save', async () => {
      // The switch moves optimistically. It never moved back, so a failed PATCH
      // left the dialog saying a schedule was off while its cron kept firing.
      const transport = await renderWithFailingToggle();

      fireEvent.click(screen.getByRole('switch'));
      // Optimistic: it reads "off" straight away.
      expect(screen.getByRole('switch')).not.toBeChecked();

      await waitFor(() =>
        expect(transport.updateTask).toHaveBeenCalledWith('sched-1', {
          enabled: false,
        })
      );
      await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
    });

    it('stays where the click put it when the change did save', async () => {
      const schedule = createMockSchedule({ id: 'sched-1', name: 'Nightly', enabled: true });
      const transport = createMockTransport({
        updateTask: vi
          .fn()
          .mockResolvedValue(createMockSchedule({ id: 'sched-1', enabled: false })),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
      fireEvent.click(screen.getByRole('switch'));

      await waitFor(() => expect(transport.updateTask).toHaveBeenCalled());
      expect(screen.getByRole('switch')).not.toBeChecked();
    });
  });

  it('shows schedule preview in ScheduleBuilder', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);
    const schedule = createMockSchedule({
      id: 'sched-1',
      name: 'Test',
      prompt: 'Test',
      cron: '0 9 * * 1-5',
    });

    render(
      <Wrapper>
        <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
      </Wrapper>
    );

    // ScheduleBuilder parses weekly cron and shows human-readable preview
    expect(screen.getByText(/every weekday at 9:00 AM/i)).toBeTruthy();
  });

  describe('the trust dial', () => {
    // The form used to ask this question with two hand-written radios ("Allow
    // file edits", "Full autonomy") whose words described Claude Code and no
    // other runtime. It is now the same dial every other picker shows, built
    // from what the runtime declared (spec `trust-dial`).

    it('offers the runtime’s own stops instead of two hand-written radios', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));

      const dial = await screen.findByRole('radiogroup', { name: /how much/i });
      expect(
        within(dial)
          .getAllByRole('radio')
          .map((s) => s.textContent)
      ).toEqual(['Ask first', 'Act', 'Full autonomy']);
      expect(screen.queryByLabelText('Allow file edits')).toBeNull();
    });

    it('says what actually happens to an ask nobody answers', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));

      // `acceptEdits` still asks before commands, and nobody is there to answer.
      // The runtime refuses it after ten minutes and the turn CARRIES ON — it
      // does not park until the run's time limit, which is what this said first
      // and is not what `interactive-handlers.ts` does.
      const note = await screen.findByTestId('task-unattended-note');
      expect(note).toHaveTextContent(/nobody is watching/i);
      expect(note).toHaveTextContent(/refused after 10 minutes/);
      expect(note).toHaveTextContent(/carries on/);
      expect(note).not.toHaveTextContent(/time limit/);
    });

    it('shows the runtime that actually runs the task, not the registry default', async () => {
      // `schedulerAgentManager` is bound to ClaudeCodeRuntime at boot
      // (apps/server/src/index.ts) — `runtimes.default` moves the registry's
      // default and never touches the scheduler. Dialling the default would
      // caption a Claude Code run with Codex's promises.
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
                      "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
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

      await waitFor(() =>
        expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(
          'Edits files on its own. Asks before it runs a command.'
        )
      );
      expect(screen.getByTestId('trust-dial-caption')).not.toHaveTextContent(/can't pause to ask/);
      // And the stall note survives: gated on the declared `asks`, it would have
      // been suppressed by Codex's `never` for a run Codex is not doing.
      expect(screen.getByTestId('task-unattended-note')).toBeInTheDocument();
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

    it('names the stored mode when the runtime has said nothing yet', async () => {
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockResolvedValue({
          defaultRuntime: 'test-mode',
          capabilities: {},
        }),
      });
      const Wrapper = createWrapper(transport);
      const schedule = createMockSchedule({
        id: 'sched-bypass',
        permissionMode: 'bypassPermissions',
      });

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      const note = await screen.findByTestId('trust-dial-unavailable');
      expect(note).toHaveTextContent(/Bypass All/);
      expect(note).toHaveTextContent(/saving keeps it as it is/i);
      expect(screen.queryByRole('radiogroup', { name: /how much/i })).toBeNull();
      expect(screen.queryByText(/This covers tools inside the session/)).toBeNull();
    });

    it('asks before it turns on full autonomy, and says what an unattended run does', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));

      await screen.findByRole('radiogroup', { name: /how much/i });
      fireEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));

      const alert = await screen.findByRole('alertdialog');
      expect(alert).toHaveTextContent(/Turn on Full autonomy/);
      expect(alert).toHaveTextContent(/never stops to ask|nothing is asked|no approval/i);

      // Not applied until the person says so.
      fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(screen.getByRole('radio', { name: 'Act' })).toBeChecked();
    });

    it('applies full autonomy once confirmed', async () => {
      const newSchedule = createMockSchedule({ id: 'sched-new' });
      const transport = createMockTransport({
        createTask: vi.fn().mockResolvedValue(newSchedule),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));

      await screen.findByRole('radiogroup', { name: /how much/i });
      fireEvent.click(screen.getByRole('radio', { name: 'Full autonomy' }));
      fireEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', {
          name: 'Turn on Full autonomy',
        })
      );

      await waitFor(() =>
        expect(screen.getByRole('radio', { name: 'Full autonomy' })).toBeChecked()
      );
    });

    it('asks before a middle stop that never asks, too (DOR-816)', async () => {
      // The scheduler's runtime declares Codex's shape: its Act stop runs
      // commands and cannot pause to ask. A run nobody is watching is exactly
      // where that has to be said out loud rather than left to the caption.
      const transport = createMockTransport({
        getCapabilities: vi.fn().mockResolvedValue({
          defaultRuntime: 'claude-code',
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
                    id: 'default',
                    label: 'Read only',
                    stop: 'ask',
                    asks: 'never',
                    reach: 'read',
                    promise: 'Reads files and answers questions. Nothing changes.',
                  },
                  {
                    id: 'acceptEdits',
                    label: 'Workspace write',
                    stop: 'act',
                    asks: 'never',
                    reach: 'workspace',
                    promise: 'Edits files and runs commands inside the workspace.',
                  },
                ],
              },
              features: {},
            },
          },
        }),
      });
      const Wrapper = createWrapper(transport);
      // Opened on a task that sits at Ask first, so pressing Act is a change.
      const schedule = createMockSchedule({ id: 'sched-read-only', permissionMode: 'default' });

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await screen.findByRole('radiogroup', { name: /how much/i });
      fireEvent.click(screen.getByRole('radio', { name: 'Act' }));

      const alert = await screen.findByRole('alertdialog');
      // The dial's own word for what they pressed — not "Full autonomy", which
      // this mode is not.
      expect(alert).toHaveTextContent('Turn on Act');
      expect(alert).not.toHaveTextContent(/Full autonomy/);
      expect(within(alert).getByTestId('consent-asks-note')).toHaveTextContent(
        /never pauses to ask/i
      );
      // And the unattended consequence the form has always carried.
      expect(alert).toHaveTextContent(/nobody to ask/i);

      fireEvent.click(within(alert).getByRole('button', { name: 'Turn on Act' }));
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Act' })).toBeChecked());
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
      expect(note).toHaveTextContent('Saving keeps it as it is');
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
          expect.objectContaining({ name: 'New Name', permissionMode: 'plan' })
        );
      });
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

    it('falls back to the mode id when nobody has written plain words for it', async () => {
      // `auto` and `dontAsk` are carried through the task schema without a
      // description. Making one up would be worse than showing the id: the
      // person would trust a sentence nothing in the codebase stands behind.
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const schedule = createMockSchedule({ id: 'sched-auto', permissionMode: 'auto' });

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      expect(await screen.findByTestId('trust-dial-stranded')).toHaveTextContent(/Auto/);
    });

    it('says nothing at all for a task already sitting on a stop', async () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const schedule = createMockSchedule({ id: 'sched-ae', permissionMode: 'acceptEdits' });

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole('radio', { name: 'Act' })).toBeChecked();
      });
      expect(screen.queryByTestId('trust-dial-stranded')).toBeNull();
    });
  });

  describe('agent picker', () => {
    it('shows agent combobox when agents exist', async () => {
      const transport = createMockTransport({
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );

      fireEvent.click(screen.getByText('Start from scratch'));

      await waitFor(() => {
        expect(screen.getByText('Select an agent...')).toBeTruthy();
      });
    });

    it('pre-selects agent in combobox trigger when editing agent-linked schedule', async () => {
      const schedule = createMockSchedule({
        id: 'sched-1',
        name: 'Agent schedule',
        prompt: 'Do things',
        cron: '0 9 * * 1-5',
        agentId: 'agent-1',
      });
      const transport = createMockTransport({
        listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: MOCK_AGENTS }),
      });
      const Wrapper = createWrapper(transport);

      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('api-bot')).toBeTruthy();
      });
    });
  });

  describe('two-step flow', () => {
    it('opens at preset-picker step by default (create mode)', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      expect(screen.getByText('Start from scratch')).toBeTruthy();
    });

    it('opens directly at form step in edit mode', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      const schedule = createMockSchedule({ id: 's1', name: 'My Schedule' });
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} editTask={schedule} />
        </Wrapper>
      );
      expect(screen.queryByText('Start from scratch')).toBeNull();
      expect(screen.getByText('Edit Schedule')).toBeTruthy();
    });

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

    it('advances to empty form when "Start from scratch" is clicked', () => {
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      fireEvent.click(screen.getByText('Start from scratch'));
      expect(screen.getByPlaceholderText('Daily code review')).toBeTruthy();
      expect((screen.getByPlaceholderText('Daily code review') as HTMLInputElement).value).toBe('');
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

    it('opens at form step when externalTrigger fires with pendingPreset', async () => {
      const clearMock = vi.fn();
      mockTaskTemplateDialog.mockReturnValue({
        pendingTemplate: MOCK_PRESETS[0],
        externalTrigger: true,
        clear: clearMock,
      });
      const transport = createMockTransport();
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <CreateTaskDialog open={true} onOpenChange={vi.fn()} />
        </Wrapper>
      );
      await waitFor(() => {
        expect(screen.getByDisplayValue('Health Check')).toBeTruthy();
      });
      expect(clearMock).toHaveBeenCalled();
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
