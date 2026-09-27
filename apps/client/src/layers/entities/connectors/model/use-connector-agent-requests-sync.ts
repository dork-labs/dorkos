/**
 * Keep every window's agent requests honest the moment an agent asks for an app
 * or a request is answered, expires or fails.
 *
 * @module entities/connectors/model/use-connector-agent-requests-sync
 */
import {
  useEventSubscription,
  useCoalescedInvalidation,
  type QueryInvalidation,
} from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Every cache a request's state lives in: the owner lists, each conversation's
 * list, and each request's own read, all under one prefix. Invalidation marks
 * them stale and refetches; nothing is cleared, so a card never blinks empty.
 */
const AGENT_REQUEST_CACHES: readonly QueryInvalidation[] = [
  { queryKey: connectorKeys.agentRequests() },
];

/**
 * Trailing-edge coalescing window (ms). A request's answer often lands as two
 * changes a moment apart (the decision, then the held call resuming); one
 * refetch covers both.
 */
const COALESCE_MS = 250;

/**
 * Follow `connector_agent_requests_changed` on the unified `/api/events`
 * stream, so a request answered in one window, on the Connections page or in a
 * room, retires its card in every other window rather than on the next focus
 * refetch. The event carries only a stamp; each window re-reads its own
 * owner-scoped lists.
 *
 * @param coalesceMs - Debounce window in milliseconds; parameterised for tests.
 */
export function useConnectorAgentRequestsSync(coalesceMs: number = COALESCE_MS): void {
  const schedule = useCoalescedInvalidation({ coalesceMs });

  useEventSubscription('connector_agent_requests_changed', () => schedule(AGENT_REQUEST_CACHES));
}
