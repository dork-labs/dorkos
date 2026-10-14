import { useQuery } from '@tanstack/react-query';
import type { RelayConversation } from '@dorkos/shared/relay-schemas';
import {
  useCoalescedInvalidation,
  useEventSubscription,
  useTransport,
} from '@/layers/shared/model';

export const RELAY_CONVERSATIONS_KEY = ['relay', 'conversations'] as const;

/**
 * Trailing-edge window for message bursts: a busy chat app delivering ten
 * messages at once re-reads the list once, not ten times.
 */
const CONVERSATIONS_COALESCE_MS = 500;

/**
 * How often the list checks again with no event. Agent-to-agent sends and task
 * dispatches land in this list without an event of their own, so the safety net
 * is tighter here than the shared one-minute backstop.
 */
const CONVERSATIONS_BACKSTOP_MS = 15_000;

/**
 * Fetch grouped relay conversations with human-readable labels.
 *
 * Kept current by the event stream wherever it is shown: a console message or
 * signal, a delivery across a chat-app binding, and a dead letter each re-read
 * the list. It used to re-read every five seconds whether anything had arrived
 * or not (DOR-2909).
 *
 * @param enabled - When false, nothing is fetched and events are ignored.
 */
export function useRelayConversations(enabled = true) {
  const transport = useTransport();
  const schedule = useCoalescedInvalidation({ coalesceMs: CONVERSATIONS_COALESCE_MS });
  const refresh = () => {
    if (enabled) schedule([{ queryKey: [...RELAY_CONVERSATIONS_KEY] }]);
  };
  useEventSubscription('relay_message', refresh);
  useEventSubscription('relay_signal', refresh);
  useEventSubscription('relay_flow', refresh);
  useEventSubscription('relay_dead_letter', refresh);
  return useQuery<{ conversations: RelayConversation[] }>({
    queryKey: [...RELAY_CONVERSATIONS_KEY],
    queryFn: () => transport.listRelayConversations(),
    enabled,
    refetchInterval: CONVERSATIONS_BACKSTOP_MS,
  });
}
