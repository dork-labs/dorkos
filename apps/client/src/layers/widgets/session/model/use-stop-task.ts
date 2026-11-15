import { useCallback } from 'react';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';

/**
 * The strip's Stop for one background task.
 *
 * A row can outlive its turn (DOR-2065), so a stop that does not land leaves
 * the row on screen: the person is told, not only the console.
 *
 * @param sessionId - The session the task runs under, or empty before one exists
 * @param transport - The transport that sends the stop
 */
export function useStopTask(sessionId: string, transport: Transport) {
  return useCallback(
    async (taskId: string) => {
      if (!sessionId) return;
      try {
        await transport.stopTask(sessionId, taskId);
      } catch (err) {
        console.error('[chat] Failed to stop task:', err);
        toast.error('Couldn’t stop that task. Try again.');
      }
    },
    [sessionId, transport]
  );
}
