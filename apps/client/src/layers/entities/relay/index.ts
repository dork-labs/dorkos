/**
 * Relay entity — domain hooks for relay message bus data fetching.
 *
 * @module entities/relay
 */
export { useRelayEnabled } from './model/use-relay-config';
export { useRelayMessages, useSendRelayMessage } from './model/use-relay-messages';
export { useRelayEndpoints } from './model/use-relay-endpoints';
export { useRelayMetrics } from './model/use-relay-metrics';
export { useRelayEventStream } from './model/use-relay-event-stream';

/** @deprecated Use `ConnectionState` from `@dorkos/shared/types` instead. */
export type { ConnectionState as RelayConnectionState } from '@dorkos/shared/types';
export { useRelayAdapters, useToggleAdapter } from './model/use-relay-adapters';
export {
  useAdapterCatalog,
  useAddAdapter,
  useRemoveAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from './model/use-adapter-catalog';
export {
  useExternalAdapterCatalog,
  ADAPTER_CATEGORY_INTERNAL,
} from './model/use-external-adapter-catalog';
export { useMessageTrace } from './model/use-message-trace';
export { useDeliveryMetrics } from './model/use-delivery-metrics';
export {
  useDeadLetters,
  useAggregatedDeadLetters,
  useDismissDeadLetterGroup,
} from './model/use-dead-letters';
export type { DeadLetter, AggregatedDeadLetter } from './model/use-dead-letters';
export { useRelayConversations } from './model/use-relay-conversations';
export { useAdapterEvents } from './model/use-adapter-events';
export type { AdapterEventMetadata } from './model/use-adapter-events';
export { useObservedChats } from './model/use-observed-chats';
