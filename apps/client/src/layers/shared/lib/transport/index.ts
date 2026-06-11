/**
 * Transport implementations — HTTP transport for standalone web clients
 * and SSEConnection for resilient EventSource management.
 *
 * @module shared/lib/transport
 */
export { HttpTransport } from './http-transport';
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
