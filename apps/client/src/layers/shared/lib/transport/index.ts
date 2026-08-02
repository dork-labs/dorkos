/**
 * Transport implementations — HTTP transport for standalone web clients
 * and SSEConnection for resilient EventSource management.
 *
 * @module shared/lib/transport
 */
export { HttpTransport } from './http-transport';
export {
  UPLOAD_STALL_TIMEOUT_MS,
  UPLOAD_STALLED_MESSAGE,
  UPLOAD_CANCELED_MESSAGE,
  UPLOAD_UNREADABLE_MESSAGE,
} from './upload-contract';
export { RoomStreamHttpError, isFatalStreamError } from './room-methods';
export { SSEConnection, type SSEConnectionOptions } from './sse-connection';
export {
  StreamManager,
  streamManager,
  GENERIC_EVENTS,
  type GenericEventName,
  type SSEConnectionLike,
  type CreateConnection,
  type StreamManagerListeners,
} from './stream-manager';
export {
  TransportSessionStreamPump,
  TransportListStreamPump,
  type TransportStreams,
} from './transport-stream-pump';
