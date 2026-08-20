/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
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
