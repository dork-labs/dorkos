/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ListTaskRunsQuery, TaskRun } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { createMockRun } from '@dorkos/test-utils';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TaskRunHistoryPanel } from '../ui/TaskRunHistoryPanel';
import { toast } from 'sonner';

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { toast };
});

const mockSetActiveSession = vi.fn();
const mockSetSelectedCwd = vi.fn();

vi.mock('@/layers/entities/session', () => ({
  useSessionId: vi.fn(() => [null, mockSetActiveSession]),
  useDirectoryState: vi.fn(() => ['/current/dir', mockSetSelectedCwd]),
}));

/** A wrapper that hands back the query client, so a test can invalidate like the app does. */
function createWrapperWithClient(transport: Transport) {
  const queryClient = new QueryClient({
    ...createQueryClientConfig(),
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

function createWrapper(transport: Transport) {
  // The real error policy (`createQueryClientConfig`), not a hand-rolled one —
  // a failed cancel is reported by the shared mutation cache now
  // (`useCancelTaskRun`'s `meta.errorLabel`), not the panel's own `onError`,
  // and a re-declared config would quietly stop asserting that.
  const queryClient = new QueryClient({
    ...createQueryClientConfig(),
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

// Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent —
// the same shim `ClaudeAccountsSection.test.tsx` installs.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
});

describe('TaskRunHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders run list with status indicators', async () => {
    const runs = [
      createMockRun({ id: 'run-1', status: 'completed', trigger: 'scheduled' }),
      createMockRun({ id: 'run-2', status: 'failed', trigger: 'manual' }),
      createMockRun({ id: 'run-3', status: 'running', trigger: 'scheduled' }),
    ];
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTitle('Completed')).toBeTruthy();
      expect(screen.getByTitle('Failed')).toBeTruthy();
      expect(screen.getByTitle('Running')).toBeTruthy();
    });
  });

  it('shows duration for completed runs', async () => {
    const runs = [createMockRun({ id: 'run-1', status: 'completed', durationMs: 65000 })];
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    await waitFor(() => {
      // 65000ms = 1m 5s
      expect(screen.getByText('1m 5s')).toBeTruthy();
    });
  });

  it('shows the stop button only for running jobs', async () => {
    const runs = [
      createMockRun({ id: 'run-1', status: 'running', trigger: 'scheduled' }),
      createMockRun({ id: 'run-2', status: 'completed', trigger: 'manual' }),
    ];
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTitle('Running')).toBeTruthy();
    });

    // Only one Stop button should exist (for the running job)
    const stopButtons = screen.getAllByText('Stop');
    expect(stopButtons).toHaveLength(1);
  });

  describe('pressing Stop', () => {
    /** Render one running job and press its Stop button. */
    async function pressStop(cancelTaskRun: Transport['cancelTaskRun']) {
      const transport = createMockTransport({
        listTaskRuns: vi
          .fn()
          .mockResolvedValue([createMockRun({ id: 'run-1', status: 'running' })]),
        cancelTaskRun: cancelTaskRun as never,
      });
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
        </Wrapper>
      );
      await waitFor(() => {
        expect(screen.getByText('Stop')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('Stop'));
    }

    it('says the run is stopping when a runner took the request', async () => {
      await pressStop(vi.fn().mockResolvedValue({ success: true, state: 'stopping' }));

      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith('Stopping the run');
      });
    });

    it('says so when the run had already finished, rather than claiming a stop', async () => {
      await pressStop(vi.fn().mockResolvedValue({ success: true, state: 'already_finished' }));

      await waitFor(() => {
        expect(toast).toHaveBeenCalledWith('That run had already finished');
      });
    });

    it('never claims success when the stop could not be confirmed', async () => {
      // The server answers 502 for a stop nothing acknowledged, and the run may
      // still be going. "Run cancelled" here would be the visible half of the
      // lie (DOR-808).
      await pressStop(vi.fn().mockRejectedValue(new Error('Nothing picked up the stop request')));

      // The panel no longer reports this itself — the shared mutation toast
      // (`useCancelTaskRun`'s `meta.errorLabel`) does, composed with the
      // server's own sentence, same as every other failed mutation.
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          "Couldn't stop the run — Nothing picked up the stop request",
          expect.anything()
        );
      });
      expect(toast).not.toHaveBeenCalled();
    });
  });

  it('clicking a run navigates to its session (same cwd)', async () => {
    const runs = [createMockRun({ id: 'run-1', status: 'completed', sessionId: 'session-abc' })];
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/current/dir" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTitle('Completed')).toBeTruthy();
    });

    // Click the run row
    const row = screen.getByTitle('Completed').closest('[class*="cursor-pointer"]');
    expect(row).toBeTruthy();
    fireEvent.click(row!);

    // Same cwd — should set session directly without changing directory
    expect(mockSetActiveSession).toHaveBeenCalledWith('session-abc');
    expect(mockSetSelectedCwd).not.toHaveBeenCalled();
  });

  it('clicking a run with different cwd navigates to directory first', async () => {
    const runs = [createMockRun({ id: 'run-1', status: 'completed', sessionId: 'session-xyz' })];
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/other/dir" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTitle('Completed')).toBeTruthy();
    });

    const row = screen.getByTitle('Completed').closest('[class*="cursor-pointer"]');
    fireEvent.click(row!);

    // Different cwd — should set directory first (with preserveSession option)
    expect(mockSetSelectedCwd).toHaveBeenCalledWith('/other/dir', { preserveSession: true });
    expect(mockSetActiveSession).toHaveBeenCalledWith('session-xyz');
  });

  describe('after Load more', () => {
    const PAGE_SIZE = 20;

    /**
     * A server whose run list the test can rewrite mid-flight, paginated the way
     * the real endpoint is.
     */
    function paginatedTransport(runs: TaskRun[]) {
      const store = { runs };
      const listTaskRuns = vi.fn((opts?: Partial<ListTaskRunsQuery>) => {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 50;
        return Promise.resolve(store.runs.slice(offset, offset + limit));
      });
      return { transport: createMockTransport({ listTaskRuns }), store, listTaskRuns };
    }

    /** One still-running run on page one, a full page behind it, one run on page two. */
    function twoPagesWithRunningFirst(): TaskRun[] {
      const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
        createMockRun({
          id: `run-${i}`,
          status: i === 0 ? 'running' : 'completed',
          sessionId: null,
        })
      );
      return [
        ...firstPage,
        createMockRun({ id: 'run-page-2', status: 'completed', sessionId: null }),
      ];
    }

    it('keeps loading pages appended', async () => {
      const { transport } = paginatedTransport(twoPagesWithRunningFirst());
      const { Wrapper } = createWrapperWithClient(transport);

      render(
        <Wrapper>
          <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
        </Wrapper>
      );

      await waitFor(() =>
        expect(screen.getAllByTitle(/Completed|Running/)).toHaveLength(PAGE_SIZE)
      );

      fireEvent.click(screen.getByText('Load more'));

      await waitFor(() =>
        expect(screen.getAllByTitle(/Completed|Running/)).toHaveLength(PAGE_SIZE + 1)
      );
      // Page two was short, so there is nothing left to ask for.
      expect(screen.queryByText('Load more')).toBeNull();
    });

    it('updates an earlier page in place when its run finishes', async () => {
      // The panel used to freeze each loaded page into component state and
      // concatenate. A run's status is not a fixed fact — `run-0` goes
      // `running` → `completed` while you are looking at it — so once page two
      // was loaded, page one's spinner span forever for a run that had finished.
      const { transport, store } = paginatedTransport(twoPagesWithRunningFirst());
      const { Wrapper, queryClient } = createWrapperWithClient(transport);

      render(
        <Wrapper>
          <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
        </Wrapper>
      );

      await waitFor(() => expect(screen.getByTitle('Running')).toBeTruthy());

      fireEvent.click(screen.getByText('Load more'));
      await waitFor(() =>
        expect(screen.getAllByTitle(/Completed|Running/)).toHaveLength(PAGE_SIZE + 1)
      );
      // Still running at this point — the change has not happened yet.
      expect(screen.getByTitle('Running')).toBeTruthy();

      // The run finishes server-side, and something tells the client to look
      // again — exactly what `useCancelTaskRun` and `useTriggerTask` do.
      store.runs = store.runs.map((run) =>
        run.id === 'run-0' ? { ...run, status: 'completed' as const } : run
      );
      await queryClient.invalidateQueries({ queryKey: ['tasks', 'runs'] });

      await waitFor(() => expect(screen.queryByTitle('Running')).toBeNull());
      expect(screen.getAllByTitle('Completed')).toHaveLength(PAGE_SIZE + 1);
    });
  });

  it('says it could not load, rather than claiming there are no runs', async () => {
    // "No runs yet" for a fetch that failed is the panel inventing an answer it
    // does not have — a schedule with a long history reads as never having run.
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    await waitFor(() => expect(screen.getByText(/Couldn’t load this run history/)).toBeTruthy());
    expect(screen.queryByText('No runs yet')).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('retries the fetch when Try again is pressed', async () => {
    const listTaskRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([createMockRun({ id: 'run-1', status: 'completed' })]);
    const transport = createMockTransport({ listTaskRuns });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
    fireEvent.click(screen.getByText('Try again'));

    await waitFor(() => expect(screen.getByTitle('Completed')).toBeTruthy());
  });

  describe('a run DorkOS skipped because it was busy (DOR-1482)', () => {
    const SKIP_REASON = 'DorkOS was already running 4 tasks at once, which is its limit';

    /** Render one skipped run, as the scheduler writes it. */
    async function renderSkipped() {
      const transport = createMockTransport({
        listTaskRuns: vi.fn().mockResolvedValue([
          createMockRun({
            id: 'run-skipped',
            status: 'skipped',
            trigger: 'scheduled',
            sessionId: null,
            durationMs: 0,
            error: SKIP_REASON,
            outputSummary: null,
          }),
        ]),
      });
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
        </Wrapper>
      );
      await waitFor(() => expect(screen.getByTitle(/Skipped/)).toBeTruthy());
      return transport;
    }

    it('says WHY it was skipped', async () => {
      // The row is the only place a person ever learns the occurrence was passed
      // over. Without this the row read "scheduled · Just now · < 1s" — no
      // reason, and a duration implying it had run.
      await renderSkipped();

      expect(screen.getByTitle(SKIP_REASON)).toBeTruthy();
      expect(screen.getByText(SKIP_REASON)).toBeTruthy();
    });

    it('shows no duration for a run that never started', async () => {
      await renderSkipped();

      expect(screen.queryByText('< 1s')).toBeNull();
      expect(screen.queryByText('0s')).toBeNull();
    });

    it('offers no Stop button — there is nothing to stop', async () => {
      await renderSkipped();

      expect(screen.queryByText('Stop')).toBeNull();
    });

    it('can be filtered for on its own', async () => {
      const user = userEvent.setup();
      const listTaskRuns = vi.fn().mockResolvedValue([]);
      const transport = createMockTransport({ listTaskRuns });
      const Wrapper = createWrapper(transport);
      render(
        <Wrapper>
          <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
        </Wrapper>
      );
      await screen.findByText('No runs yet');
      listTaskRuns.mockClear();

      await user.click(screen.getByRole('combobox'));
      const listbox = await screen.findByRole('listbox');
      await user.click(within(listbox).getByRole('option', { name: 'Skipped' }));

      await waitFor(() => {
        expect(listTaskRuns).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'skipped' } as Partial<ListTaskRunsQuery>)
        );
      });
      expect(screen.getByText('No skipped runs')).toBeTruthy();
    });
  });

  it('shows loading state', () => {
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <TaskRunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    // Loading state now renders skeleton rows instead of text
    expect(screen.getByLabelText('Loading runs...')).toBeTruthy();
  });
});
