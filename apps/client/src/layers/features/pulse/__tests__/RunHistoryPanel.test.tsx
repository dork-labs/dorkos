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
import { RunHistoryPanel } from '../ui/RunHistoryPanel';

const mockSetActiveSession = vi.fn();
const mockSetSelectedCwd = vi.fn();

vi.mock('@/layers/entities/session', () => ({
  useSessionId: vi.fn(() => [null, mockSetActiveSession]),
  useDirectoryState: vi.fn(() => ['/current/dir', mockSetSelectedCwd]),
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

describe('RunHistoryPanel', () => {
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
      listRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
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
      listRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    await waitFor(() => {
      // 65000ms = 1m 5s
      expect(screen.getByText('1m 5s')).toBeTruthy();
    });
  });

  it('shows cancel button only for running jobs', async () => {
    const runs = [
      createMockRun({ id: 'run-1', status: 'running', trigger: 'scheduled' }),
      createMockRun({ id: 'run-2', status: 'completed', trigger: 'manual' }),
    ];
    const transport = createMockTransport({
      listRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByTitle('Running')).toBeTruthy();
    });

    // Only one Cancel button should exist (for the running job)
    const cancelButtons = screen.getAllByText('Cancel');
    expect(cancelButtons).toHaveLength(1);
  });

  it('clicking a run navigates to its session (same cwd)', async () => {
    const runs = [createMockRun({ id: 'run-1', status: 'completed', sessionId: 'session-abc' })];
    const transport = createMockTransport({
      listRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/current/dir" />
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
      listRuns: vi.fn().mockResolvedValue(runs),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/other/dir" />
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
      listRuns: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <RunHistoryPanel scheduleId="sched-1" scheduleCwd="/test/cwd" />
      </Wrapper>
    );

    // Loading state now renders skeleton rows instead of text
    expect(screen.getByLabelText('Loading runs...')).toBeTruthy();
  });
});
