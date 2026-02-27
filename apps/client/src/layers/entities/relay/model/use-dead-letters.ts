import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Shape of a dead-letter entry as returned by the server relay endpoint. */
export interface DeadLetter {
  /** Hash of the endpoint that could not be delivered to. */
  endpointHash: string;
  /** Original message ID. */
  messageId: string;
  /** Rejection reason code (hop_limit, ttl_expired, cycle_detected, budget_exhausted, etc.). */
  reason: string;
  /** Original message envelope. */
  envelope: Record<string, unknown>;
  /** ISO timestamp of when the message was dead-lettered. */
  failedAt: string;
}

const DEAD_LETTERS_KEY = ['relay', 'dead-letters'] as const;

/**
 * Fetch relay dead-letter messages with 30-second polling.
 *
 * @param filters - Optional filters (endpointHash) to scope results.
 * @param enabled - When false, the query is skipped entirely (Relay feature gate).
 */
export function useDeadLetters(
  filters?: { endpointHash?: string },
  enabled = true,
) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...DEAD_LETTERS_KEY, filters],
    queryFn: async () => {
      const data = await transport.listRelayDeadLetters(filters);
      return data as DeadLetter[];
    },
    enabled,
    refetchInterval: 30_000,
  });
}
