/**
 * @vitest-environment jsdom
 *
 * A stop on a row that outlived its turn may not land (DOR-2065); the person
 * is told rather than left with a row that silently did nothing. A task that
 * had already finished is not a failure: its row goes, and "try again" is
 * never said about it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';
import { useStopTask } from '../use-stop-task';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

/** The error `fetchJSON` throws for a refusal: the server's code rides on it. */
function refusal(code: string): Error {
  return Object.assign(new Error('Task not found or already stopped'), { code, status: 409 });
}

describe('useStopTask', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('tells the person when the stop fails', async () => {
    const transport = {
      stopTask: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as Transport;
    const { result } = renderHook(() => useStopTask('s1', transport));

    await act(() => result.current.stopTask('mon-1'));

    expect(transport.stopTask).toHaveBeenCalledWith('s1', 'mon-1');
    expect(toast.error).toHaveBeenCalledWith('Couldn’t stop that task. Try again.');
    expect(result.current.finishedTaskIds.has('mon-1')).toBe(false);
  });

  it('drops the row quietly when the task had already finished', async () => {
    const transport = {
      stopTask: vi.fn().mockRejectedValue(refusal('TASK_NOT_RUNNING')),
    } as unknown as Transport;
    const { result } = renderHook(() => useStopTask('s1', transport));

    await act(() => result.current.stopTask('mon-1'));

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('That task had already finished.');
    expect(result.current.finishedTaskIds.has('mon-1')).toBe(true);
  });

  it('says nothing when the stop lands', async () => {
    const transport = {
      stopTask: vi.fn().mockResolvedValue({ taskId: 'mon-1', receipt: { outcome: 'acked' } }),
    } as unknown as Transport;
    const { result } = renderHook(() => useStopTask('s1', transport));

    await act(() => result.current.stopTask('mon-1'));

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(result.current.finishedTaskIds.size).toBe(0);
  });
});
