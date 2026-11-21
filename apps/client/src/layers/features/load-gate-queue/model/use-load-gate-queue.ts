/**
 * The load gate's waiting line, read and changed (DOR-4209).
 *
 * @module features/load-gate-queue/model/use-load-gate-queue
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoadGateJobAction, LoadGateWaitingLine } from '@dorkos/shared/load-gate-queue';
import { useTransport } from '@/layers/shared/model';

/** How often the line is read again while the page is on screen. */
const POLL_MS = 5_000;

/** The waiting line's cache key. */
const loadGateKeys = {
  waiting: () => ['load-gate', 'waiting'] as const,
};

/**
 * Whether a read was refused rather than failed: the line is shown only to a
 * person at the computer running DorkOS, so a phone is refused every time and
 * asking again changes nothing. The HTTP status rides on the thrown error.
 */
function wasRefused(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * The heavy jobs waiting their turn, read again every 5 seconds while the page
 * is visible. A refusal stops the reads; any other failure is tried again on
 * the next beat.
 */
export function useLoadGateWaitingLine() {
  const transport = useTransport();
  return useQuery<LoadGateWaitingLine>({
    queryKey: loadGateKeys.waiting(),
    queryFn: () => transport.getLoadGateWaitingLine(),
    refetchInterval: (query) => (wasRefused(query.state.error) ? false : POLL_MS),
    retry: false,
  });
}

/**
 * Let one job through, mark it urgent, or move it to the front. The answer is
 * the line after the change, so it replaces the cache; only a failure reads
 * the line again.
 */
export function useLoadGateJobAction() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: LoadGateJobAction }) =>
      transport.actOnLoadGateJob(id, action),
    onSuccess: (line) => queryClient.setQueryData(loadGateKeys.waiting(), line),
    onError: () => queryClient.invalidateQueries({ queryKey: loadGateKeys.waiting() }),
  });
}
