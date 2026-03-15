import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Number of consecutive errors before the connection is considered fully disconnected. */
const DISCONNECTED_THRESHOLD = 3;

export type RelayConnectionState = 'connected' | 'reconnecting' | 'disconnected';

/**
 * Connect to the Relay SSE event stream and inject incoming messages into the query cache.
 *
 * @param enabled - Whether to connect (typically tied to relay feature flag).
 * @param pattern - Optional subject pattern for server-side filtering.
 * @returns Connection state and failed attempt count for UI status display.
 */
export function useRelayEventStream(
  enabled: boolean,
  pattern?: string,
): { connectionState: RelayConnectionState; failedAttempts: number } {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<RelayConnectionState>('connected');
  const [failedAttempts, setFailedAttempts] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const params = pattern ? `?subject=${encodeURIComponent(pattern)}` : '';
    const source = new EventSource(`/api/relay/stream${params}`);

    source.onopen = () => {
      setConnectionState('connected');
      setFailedAttempts(0);
    };

    source.onerror = () => {
      setFailedAttempts((prev) => {
        const next = prev + 1;
        setConnectionState(next >= DISCONNECTED_THRESHOLD ? 'disconnected' : 'reconnecting');
        return next;
      });
    };

    source.addEventListener('relay_message', (e) => {
      try {
        JSON.parse(e.data); // validate parseable
        // Invalidate conversations — the buildConversations() server function
        // handles grouping, so we let TanStack Query refetch the structured data
        queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
      } catch {
        console.warn('[Relay] Failed to parse relay_message event:', e.data);
      }
    });

    source.addEventListener('relay_delivery', (e) => {
      try {
        JSON.parse(e.data); // validate parseable
        queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
      } catch {
        console.warn('[Relay] Failed to parse relay_delivery event:', e.data);
      }
    });

    return () => source.close();
  }, [enabled, pattern, queryClient]);

  return { connectionState, failedAttempts };
}
