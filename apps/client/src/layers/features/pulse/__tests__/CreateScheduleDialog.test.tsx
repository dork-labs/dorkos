/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { createMockSchedule } from '@dorkos/test-utils';
import { CreateScheduleDialog } from '../ui/CreateScheduleDialog';

vi.mock('cronstrue', () => ({
  default: {
    toString: (cron: string) => {
      if (cron === '0 9 * * 1-5') return 'At 09:00 AM, Monday through Friday';
      if (cron === 'invalid') throw new Error('Invalid cron');
      return `Cron: ${cron}`;
    },
  },
}));

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

function createMockTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    denyTool: vi.fn(),
    submitAnswers: vi.fn().mockResolvedValue({ ok: true }),
    getCommands: vi.fn(),
    health: vi.fn(),
    updateSession: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ path: '/test', entries: [], parent: null }),
    getDefaultCwd: vi.fn().mockResolvedValue({ path: '/test/cwd' }),
    listFiles: vi.fn().mockResolvedValue({ files: [], truncated: false, total: 0 }),
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      claudeCliPath: null,
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
    }),
    getGitStatus: vi.fn().mockResolvedValue({ error: 'not_git_repo' as const }),
    startTunnel: vi.fn().mockResolvedValue({ url: 'https://test.ngrok.io' }),
    stopTunnel: vi.fn().mockResolvedValue(undefined),
    listSchedules: vi.fn().mockResolvedValue([]),
    createSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn().mockResolvedValue({ success: true }),
    triggerSchedule: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    listRuns: vi.fn().mockResolvedValue([]),
    getRun: vi.fn(),
    cancelRun: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

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

describe('CreateScheduleDialog', () => {
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
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows "New Schedule" title in create mode', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
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
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} editSchedule={schedule} />
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
      cwd: '/projects/app',
      permissionMode: 'bypassPermissions',
      maxRuntime: 300_000,
    });

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} editSchedule={schedule} />
      </Wrapper>
    );

    // useEffect populates fields after initial render
    await waitFor(() => {
      expect(screen.getByDisplayValue('Daily review')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('Review open PRs')).toBeTruthy();
    expect(screen.getByDisplayValue('0 9 * * 1-5')).toBeTruthy();
    expect(screen.getByText('/projects/app')).toBeTruthy();
    // maxRuntime: 300_000ms = 5 minutes
    expect(screen.getByDisplayValue('5')).toBeTruthy();
  });

  it('submits create with correct payload', async () => {
    const newSchedule = createMockSchedule({ id: 'sched-new' });
    const transport = createMockTransport({
      createSchedule: vi.fn().mockResolvedValue(newSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={onOpenChange} />
      </Wrapper>
    );

    fireEvent.change(screen.getByPlaceholderText('Daily code review'), {
      target: { value: 'Nightly build' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('Review all pending PRs and summarize findings...'),
      { target: { value: 'Run the nightly build' } }
    );
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 0 * * *' },
    });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(transport.createSchedule).toHaveBeenCalledWith(
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
      updateSchedule: vi.fn().mockResolvedValue(updatedSchedule),
    });
    const Wrapper = createWrapper(transport);
    const onOpenChange = vi.fn();

    render(
      <Wrapper>
        <CreateScheduleDialog
          open={true}
          onOpenChange={onOpenChange}
          editSchedule={schedule}
        />
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
      expect(transport.updateSchedule).toHaveBeenCalledWith(
        'sched-42',
        expect.objectContaining({ name: 'New Name' })
      );
    });
  });

  it('shows cron human-readable preview', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), {
      target: { value: '0 9 * * 1-5' },
    });

    expect(screen.getByText('At 09:00 AM, Monday through Friday')).toBeTruthy();
  });

  it('shows permission mode warning for bypassPermissions', () => {
    const transport = createMockTransport();
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <CreateScheduleDialog open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    fireEvent.click(screen.getByLabelText('Full autonomy'));

    expect(
      screen.getByText(
        'Warning: This allows the agent to execute any tool without approval.'
      )
    ).toBeTruthy();
  });
});
