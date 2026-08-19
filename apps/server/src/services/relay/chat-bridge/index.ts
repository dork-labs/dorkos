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
  type BridgeCreateInput,
} from './lifecycle.js';
export {
  BridgeSessionAdopter,
  type BridgeSessionAdopterDeps,
  type TranscriptProbe,
  type AdoptRoomOps,
  type AdoptInput,
  type AdoptResult,
} from './adopt-session.js';
export {
  BridgeStore,
  type Bridge,
  type NewBridge,
  type ExternalRef,
  type NewInboundRef,
  type NewOutboundRef,
  type BridgeablePlatformChatType,
  type BridgeVisibility,
  type RefDirection,
} from './bridge-store.js';
export {
  ChatBridgeDelivery,
  STRANDED_OUTBOUND_REF_THRESHOLD_MS,
  type ChatBridgeDeliveryDeps,
  type DeliverOutcome,
  type DeliverEntryReader,
  type DeliverNoticeWriter,
  type DeliverAuthorReader,
  type DeliverPublisher,
  type DeliverLifecycle,
  type StandingAskCards,
} from './deliver.js';
export { BridgeCatchUp, type BridgeCatchUpDeps, type CatchUpDelivery } from './catch-up.js';
export { bridgedAskIsActionable, type ExternalChatAuthor } from './ask-audience.js';
export {
  BridgedAskDelivery,
  type BridgedAskDeliveryDeps,
  type AskRoomBindings,
  type AskRosterReader,
  type AskAuthorReader,
  type AskCardPublisher,
} from './ask-card.js';
export {
  bridgedRoomFraming,
  topicNamesForEntries,
  reportsVisibility,
  type BridgedRoomFraming,
  type VisibilityReportingAdapter,
} from './room-context-framing.js';
export {
  ChatBridgePresence,
  type ChatBridgePresenceDeps,
  type PresenceSignalPublisher,
} from './presence.js';
