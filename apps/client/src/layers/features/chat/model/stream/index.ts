/**
 * Stream projection — SessionEvent → render-state derivation, history
 * reconstruction, and error classification.
 *
 * @module features/chat/model/stream
 */
export { deriveFromParts } from './stream-event-helpers';
export { mapHistoryMessage, reconcileTaggedMessages } from './stream-history-helpers';
export { classifyTransportError } from './classify-transport-error';
