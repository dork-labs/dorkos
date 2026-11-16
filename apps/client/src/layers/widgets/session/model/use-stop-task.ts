import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';

/** Stable empty set, so a session with no finished stops keeps one identity. */
const NONE: ReadonlySet<string> = new Set();

/**
 * The strip's Stop for one background task.
 *
 * A row can outlive its turn (DOR-2065), so a stop that does not land leaves
 * the row on screen: the person is told, not only the console. A task the
 * server says is no longer running (`TASK_NOT_RUNNING`) had already finished,
 * so trying again cannot help: its row is dropped and a quiet note says so,
 * and the "try again" error is kept for stops that really failed.
 *
 * @param sessionId - The session the task runs under, or empty before one exists
 * @param transport - The transport that sends the stop
 * @returns `stopTask`, and `finishedTaskIds`: the rows to drop from the strip
 */
export function useStopTask(sessionId: string, transport: Transport) {
  const [finishedTaskIds, setFinishedTaskIds] = useState<ReadonlySet<string>>(NONE);
  const stopTask = useCallback(
    async (taskId: string) => {
      if (!sessionId) return;
      try {
        await transport.stopTask(sessionId, taskId);
      } catch (err) {
        if ((err as { code?: unknown }).code === 'TASK_NOT_RUNNING') {
          setFinishedTaskIds((prev) => new Set(prev).add(taskId));
          toast.info('That task had already finished.');
          return;
        }
        console.error('[chat] Failed to stop task:', err);
        toast.error('Couldn’t stop that task. Try again.');
      }
    },
    [sessionId, transport]
  );
  return { stopTask, finishedTaskIds };
}
