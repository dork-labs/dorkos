/**
 * Transport implementations — HTTP transport for standalone web clients, and
 * the durable stream sockets (WSConnection + the iterable form) the cockpit's
 * live streams ride.
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
export {
  WSConnection,
  StreamRefusedError,
  toStreamSocketUrl,
  type StreamConnectionOptions,
} from './ws-connection';
export {
  streamSocketFrames,
  type StreamSocketClosed,
  type StreamSocketOptions,
} from './stream-socket-iterator';
export {
  StreamManager,
  streamManager,
  GENERIC_EVENTS,
  type GenericEventName,
  type DurableStreamConnection,
  type CreateConnection,
  type StreamManagerListeners,
} from './stream-manager';
export {
  TransportSessionStreamPump,
  TransportListStreamPump,
  type TransportStreams,
} from './transport-stream-pump';
