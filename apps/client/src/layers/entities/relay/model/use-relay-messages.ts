import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

const MESSAGES_KEY = ['relay', 'messages'] as const;

/**
 * Fetch relay messages with optional filters and cursor-based pagination.
 *
 * @param filters - Optional query filters (subject, status, from, cursor, limit).
 * @param enabled - When false, the query is skipped entirely (Relay feature gate).
 */
export function useRelayMessages(
  filters?: { subject?: string; status?: string; from?: string; cursor?: string; limit?: number },
  enabled = true
) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...MESSAGES_KEY, filters],
    queryFn: () => transport.listRelayMessages(filters),
    enabled,
    refetchInterval: 10_000,
  });
}

/** Send a relay message. */
export function useSendRelayMessage() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (opts: { subject: string; payload: unknown; from: string; replyTo?: string }) =>
      transport.sendRelayMessage(opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...MESSAGES_KEY] });
    },
  });
}
