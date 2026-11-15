/**
 * @vitest-environment jsdom
 *
 * A stop on a row that outlived its turn may not land (DOR-2065); the person
 * is told rather than left with a row that silently did nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';
import { useStopTask } from '../use-stop-task';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

describe('useStopTask', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('tells the person when the stop fails', async () => {
    const transport = {
      stopTask: vi.fn().mockRejectedValue(new Error('TASK_NOT_RUNNING')),
    } as unknown as Transport;
    const { result } = renderHook(() => useStopTask('s1', transport));

    await result.current('mon-1');

    expect(transport.stopTask).toHaveBeenCalledWith('s1', 'mon-1');
    expect(toast.error).toHaveBeenCalledWith('Couldn’t stop that task. Try again.');
  });

  it('says nothing when the stop lands', async () => {
    const transport = {
      stopTask: vi.fn().mockResolvedValue({ taskId: 'mon-1', receipt: { outcome: 'acked' } }),
    } as unknown as Transport;
    const { result } = renderHook(() => useStopTask('s1', transport));

    await result.current('mon-1');

    expect(toast.error).not.toHaveBeenCalled();
  });
});
