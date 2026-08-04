/**
 * The chat bridge: a bound external chat projected into a DorkOS room
 * (chats-as-channels spec). This barrel carries what leaves the package — the
 * inbound path (`ChatBridge.ingest`), the outbound path (`ChatBridgeDelivery`),
 * the catch-up scan (`BridgeCatchUp`), the lifecycle coordinator, and the two
 * stores' public surface.
 *
 * @module server/services/relay/chat-bridge
 */
export {
  ChatBridge,
  INGEST_RATE_CEILING,
  INGEST_RATE_WINDOW_MS,
  type ChatBridgeDeps,
  type ChatBridgeIngest,
  type IngestContext,
  type IngestResult,
  type IngestRefusalReason,
  type IngestRoomOps,
  type IngestLifecycle,
} from './ingest.js';
export {
  BridgeLifecycle,
  type BridgeLifecycleDeps,
  type BridgeRoomOps,
  type BridgeBindingWriter,
  type LifecycleBinding,
  type RebridgeInput,
} from './lifecycle.js';
export {
  BridgeStore,
  type Bridge,
  type NewBridge,
  type ExternalRef,
  type NewInboundRef,
  type NewOutboundRef,
  type PlatformChatType,
  type BridgeVisibility,
  type RefDirection,
} from './bridge-store.js';
export {
  ChatBridgeDelivery,
  type ChatBridgeDeliveryDeps,
  type DeliverOutcome,
  type DeliverEntryReader,
  type DeliverNoticeWriter,
  type DeliverAuthorReader,
  type DeliverPublisher,
  type DeliverLifecycle,
} from './deliver.js';
export { BridgeCatchUp, type BridgeCatchUpDeps, type CatchUpDelivery } from './catch-up.js';
export {
  ChatBridgePresence,
  type ChatBridgePresenceDeps,
  type PresenceSignalPublisher,
} from './presence.js';
