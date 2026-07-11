/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type SessionEventHandler = (sessionId: string, event: Record<string, unknown>) => void;

const mocks = vi.hoisted(() => ({
  handler: { current: null as SessionEventHandler | null },
}));

vi.mock('@/layers/shared/lib', () => ({
  streamManager: {
    subscribeSessionEvent: (handler: SessionEventHandler) => {
      mocks.handler.current = handler;
      return () => {
        mocks.handler.current = null;
      };
    },
  },
}));

import { useAgentEditRefresh } from '../model/use-agent-edit-refresh';

/** A completed edit-family tool_call event carrying a file path input. */
function editEvent(filePath: string, toolName = 'Edit') {
  return {
    type: 'tool_call',
    status: 'complete',
    toolName,
    input: JSON.stringify({ file_path: filePath }),
  };
}

const fire = (event: Record<string, unknown>) => mocks.handler.current!('sess-1', event);

describe('useAgentEditRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.handler.current = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the refresh (debounced) when the agent edits the open file again', () => {
    const onAgentEdit = vi.fn();
    renderHook(() => useAgentEditRefresh('/work', 'assets/logo.png', onAgentEdit));

    fire(editEvent('assets/logo.png'));
    expect(onAgentEdit).not.toHaveBeenCalled(); // debounced, not immediate

    vi.advanceTimersByTime(450);
    expect(onAgentEdit).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of edits into ONE refresh', () => {
    const onAgentEdit = vi.fn();
    renderHook(() => useAgentEditRefresh('/work', 'assets/logo.png', onAgentEdit));

    fire(editEvent('assets/logo.png'));
    vi.advanceTimersByTime(200);
    fire(editEvent('assets/logo.png', 'MultiEdit'));
    vi.advanceTimersByTime(200);
    fire(editEvent('assets/logo.png', 'Write'));
    vi.advanceTimersByTime(450);

    expect(onAgentEdit).toHaveBeenCalledTimes(1);
  });

  it('matches an absolute event path against a relative sourcePath (and vice versa)', () => {
    const onAgentEdit = vi.fn();
    renderHook(() => useAgentEditRefresh('/work', 'assets/logo.png', onAgentEdit));

    fire(editEvent('/work/assets/logo.png'));
    vi.advanceTimersByTime(450);
    expect(onAgentEdit).toHaveBeenCalledTimes(1);
  });

  it('ignores edits to a different file', () => {
    const onAgentEdit = vi.fn();
    renderHook(() => useAgentEditRefresh('/work', 'assets/logo.png', onAgentEdit));

    fire(editEvent('assets/other.png'));
    fire(editEvent('/work/src/App.tsx'));
    vi.advanceTimersByTime(450);

    expect(onAgentEdit).not.toHaveBeenCalled();
  });

  it('ignores non-edit tools and incomplete tool calls', () => {
    const onAgentEdit = vi.fn();
    renderHook(() => useAgentEditRefresh('/work', 'assets/logo.png', onAgentEdit));

    fire({
      type: 'tool_call',
      status: 'complete',
      toolName: 'Read',
      input: JSON.stringify({ file_path: 'assets/logo.png' }),
    });
    fire({ ...editEvent('assets/logo.png'), status: 'running' });
    vi.advanceTimersByTime(450);

    expect(onAgentEdit).not.toHaveBeenCalled();
  });

  it('unsubscribes and cancels a pending refresh on unmount', () => {
    const onAgentEdit = vi.fn();
    const { unmount } = renderHook(() =>
      useAgentEditRefresh('/work', 'assets/logo.png', onAgentEdit)
    );

    fire(editEvent('assets/logo.png'));
    unmount();
    expect(mocks.handler.current).toBeNull();
    vi.advanceTimersByTime(450);
    expect(onAgentEdit).not.toHaveBeenCalled();
  });
});
