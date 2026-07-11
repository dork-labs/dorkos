/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type SessionEventHandler = (sessionId: string, event: Record<string, unknown>) => void;

const mocks = vi.hoisted(() => ({
  executeUiCommand: vi.fn(),
  getConfig: vi.fn(),
  handler: { current: null as SessionEventHandler | null },
}));
const { executeUiCommand, getConfig } = mocks;
const capturedHandler = () => mocks.handler.current;

vi.mock('@/layers/shared/lib', () => ({
  streamManager: {
    subscribeSessionEvent: (handler: SessionEventHandler) => {
      mocks.handler.current = handler;
      return () => {
        mocks.handler.current = null;
      };
    },
  },
  executeUiCommand: mocks.executeUiCommand,
}));

vi.mock('@/layers/shared/model', () => ({
  useAppStore: { getState: () => ({}) },
  useTransport: () => ({ getConfig: mocks.getConfig }),
}));

import { useAutoOpenDiff } from '../model/use-auto-open-diff';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A completed edit-family tool_call event carrying a file_path input. */
function editEvent(filePath: string, toolName = 'Edit') {
  return {
    type: 'tool_call',
    status: 'complete',
    toolName,
    input: JSON.stringify({ file_path: filePath }),
  };
}

describe('useAutoOpenDiff', () => {
  beforeEach(() => {
    mocks.handler.current = null;
    executeUiCommand.mockReset();
    getConfig.mockReset().mockResolvedValue({ workbench: { autoOpenDiff: true } });
  });

  it('dispatches open_diff at origin "agent" on a completed edit tool_call', async () => {
    renderHook(() => useAutoOpenDiff(), { wrapper });
    await waitFor(() => expect(capturedHandler()).not.toBeNull());

    capturedHandler()!('sess-1', editEvent('src/App.tsx'));

    expect(executeUiCommand).toHaveBeenCalledWith(
      expect.anything(),
      { action: 'open_diff', sourcePath: 'src/App.tsx' },
      'agent'
    );
  });

  it('ignores a non-edit tool (Bash)', async () => {
    renderHook(() => useAutoOpenDiff(), { wrapper });
    await waitFor(() => expect(capturedHandler()).not.toBeNull());

    capturedHandler()!('sess-1', {
      type: 'tool_call',
      status: 'complete',
      toolName: 'Bash',
      input: JSON.stringify({ command: 'ls' }),
    });

    expect(executeUiCommand).not.toHaveBeenCalled();
  });

  it('ignores an edit that has not completed yet (status running)', async () => {
    renderHook(() => useAutoOpenDiff(), { wrapper });
    await waitFor(() => expect(capturedHandler()).not.toBeNull());

    capturedHandler()!('sess-1', {
      type: 'tool_call',
      status: 'running',
      toolName: 'Edit',
      input: JSON.stringify({ file_path: 'src/App.tsx' }),
    });

    expect(executeUiCommand).not.toHaveBeenCalled();
  });

  it('re-dispatches for repeated edits of the same file (store coalesces, hook does not suppress)', async () => {
    renderHook(() => useAutoOpenDiff(), { wrapper });
    await waitFor(() => expect(capturedHandler()).not.toBeNull());

    capturedHandler()!('sess-1', editEvent('src/App.tsx'));
    capturedHandler()!('sess-1', editEvent('src/App.tsx', 'MultiEdit'));

    expect(executeUiCommand).toHaveBeenCalledTimes(2);
    for (const call of executeUiCommand.mock.calls) {
      expect(call[1]).toEqual({ action: 'open_diff', sourcePath: 'src/App.tsx' });
      expect(call[2]).toBe('agent');
    }
  });

  it('does not subscribe when workbench.autoOpenDiff is disabled', async () => {
    getConfig.mockResolvedValue({ workbench: { autoOpenDiff: false } });
    renderHook(() => useAutoOpenDiff(), { wrapper });
    // Once the disabled flag resolves, the subscription is torn down (handler
    // cleared) so no edit event can ever reach the dispatcher.
    await waitFor(() => expect(capturedHandler()).toBeNull());
    expect(executeUiCommand).not.toHaveBeenCalled();
  });
});
