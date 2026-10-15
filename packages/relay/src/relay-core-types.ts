export type { FSWatcher } from 'chokidar';
export type { RelayReceiptReadContext } from './delivery-receipt-store.js';
export type { RelayGcSweepOptions } from './relay-gc.js';
export type { ChatNoticeTargetResolver } from './chat-notice.js';
export type { ServerDocumentRelayOrigin, ServerDocumentRelayAccess } from './document-delivery.js';
export type {
  BackpressureConfig,
  RelayOptions,
  PublishOptions,
  PrivateNotificationOptions,
  PrivateNotificationResult,
  MessageHandler,
  SignalHandler,
  Unsubscribe,
  EndpointInfo,
  RelayMetrics,
  AdapterRegistryLike,
  AdapterContext,
  InitiateConsentGate,
  RelayLogger,
} from './types.js';
export type { DeadLetterEntry, ListDeadOptions } from './dead-letter-queue.js';
export type { IndexedMessage } from './sqlite-index.js';
export type { PublishResult } from './relay-publish.js';
export type { SubscriptionDeps } from './relay-subscriptions.js';
export type {
  EndpointManagementDeps,
  InboxMessage,
  MessageDetail,
  ReadInboxOptions,
  RegisterEndpointOptions,
} from './relay-endpoint-management.js';

import type { PublishResult } from './relay-publish.js';
import type { ServerDocumentRelayOrigin } from './document-delivery.js';
import type { RelayCore } from './relay-core.js';

/** Result of the original fresh-bus constructor. */
export interface ServerDocumentRelay {
  relay: RelayCore;
  origin: ServerDocumentRelayOrigin;
}
/** Bound original document wake callable retained by the constructor. */
export type PublishDocumentWake = (
  wake: import('./document-delivery.js').OriginalDocumentRelayWake
) => Promise<PublishResult>;

/** Original adapter-context callback signature, unchanged through its erased alias. */
export type AdapterContextBuilder = (
  subject: string
) => import('./types.js').AdapterContext | undefined;
