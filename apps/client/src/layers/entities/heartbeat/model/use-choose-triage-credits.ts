import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { heartbeatKeys } from './heartbeat-keys';

/**
 * Answer the one-time offer to run cheap checks on DorkOS credits (spec
 * `heartbeats` §6.3): `true` is **Use credits**, `false` is **Not now**. Every
 * agent's heartbeat is re-read after, since the answer is the whole server's.
 *
 * @returns The TanStack mutation for `PUT /api/heartbeats/triage-credits`.
 */
export function useChooseTriageCredits() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (useCredits: boolean) => transport.chooseTriageCredits(useCredits),
    onSettled: () => queryClient.invalidateQueries({ queryKey: heartbeatKeys.all }),
  });
}
