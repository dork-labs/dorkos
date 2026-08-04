/**
 * The chat bridge: a bound external chat projected into a DorkOS room
 * (chats-as-channels spec). This barrel carries what leaves the package — the
 * inbound path (`ChatBridge.ingest`), the lifecycle coordinator, and the two
 * stores' public surface. The outbound path (`deliver`) and the catch-up scan
 * are later tasks and are not exported here yet.
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
