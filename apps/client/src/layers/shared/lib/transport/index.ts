/**
 * Transport implementations — HTTP transport for standalone web clients, and
 * the durable stream sockets (WSConnection + the iterable form) the app's
 * live streams ride.
 *
 * @module shared/lib/transport
 */
export { HttpTransport } from './http-transport';
export { UPLOAD_STALLED_MESSAGE, UPLOAD_CANCELED_MESSAGE } from './upload-contract';
export { RoomStreamHttpError, isFatalStreamError } from './room-methods';
export { type StreamConnectionOptions } from './ws-connection';
export {
  StreamManager,
  streamManager,
  type GenericEventName,
  type DurableStreamConnection,
  type StreamManagerListeners,
} from './stream-manager';
