import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConnectionState } from '@dorkos/shared/types';
import { useSSEConnection } from '@/layers/shared/model';

/**
 * Connect to the Relay SSE event stream and inject incoming messages into the query cache.
 *
 * @param enabled - Whether to connect (typically tied to relay feature flag).
 * @param pattern - Optional subject pattern for server-side filtering.
 * @returns Connection state and failed attempt count for UI status display.
 */
export function useRelayEventStream(
  enabled: boolean,
  pattern?: string
): { connectionState: ConnectionState; failedAttempts: number } {
  const queryClient = useQueryClient();

  const eventHandlers = useMemo(
    () => ({
      relay_message: () => {
        queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
      },
      relay_delivery: () => {
        queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
      },
    }),
    [queryClient]
  );

  const url = enabled
    ? `/api/relay/stream${pattern ? `?subject=${encodeURIComponent(pattern)}` : ''}`
    : null;

  const { connectionState, failedAttempts } = useSSEConnection(url, { eventHandlers });

  return { connectionState, failedAttempts };
}
