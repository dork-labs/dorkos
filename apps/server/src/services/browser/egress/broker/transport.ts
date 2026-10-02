import { classifyAddress } from '../addresses.js';
import { BrokerError } from './errors.js';
import type { PinnedEndpoint } from '../policy.js';
import type { SocketAdmission } from './intake.js';
import type { FramedRequest, RawRequest } from './framing.js';
/** Exact owned sockets expose observed close separately from a destroy request. */
export interface OwnedSocket {
  readonly identity: object;
  readonly peer?: PinnedEndpoint;
  readonly observedClosed: boolean;
  readonly writableBytes: number;
  onClose(callback: () => void): () => void;
  onError(callback: () => void): () => void;
  onData(callback: (bytes: Uint8Array) => void): () => void;
  onDrain(callback: () => void): () => void;
  write(bytes: Uint8Array): boolean;
  pause(): void;
  resume(): void;
  end(): void;
  destroy(): void;
}
/** Request bodies are distinct from the parsed client connection, which may become a tunnel. */
export interface RequestBody {
  onData(callback: (bytes: Uint8Array) => void): () => void;
  onEnd(callback: () => void): () => void;
  pause(): void;
  resume(): void;
}
/** Strict parser results carry only privately owned IO, never a hostname lookup port. */
export interface AcceptedRequest {
  readonly client: OwnedSocket;
  readonly raw: RawRequest;
  readonly body: RequestBody;
}
/** Listener custody must report actual close, including every upgraded socket held elsewhere. */
export interface OwnedListener {
  readonly address: '127.0.0.1';
  readonly port: number;
  readonly identity: object;
  onClose(callback: () => void): () => void;
  close(): void;
}
/** Origin HTTP uses a previously peer-verified numeric socket, with no fallback agent or retry. */
export interface OriginResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly websocketAccept?: string;
  readonly body: RequestBody;
  readonly head: Uint8Array;
}
/** Dormant private fixture plumbing. Production adapters require separate capability review. */
/** A settled connect can still own an unclosed socket; failed connect is not absence. */
export interface DialObservation {
  readonly socket: OwnedSocket;
  readonly outcome: 'connected' | 'failed';
}
export interface BrokerTransport {
  readonly scope: 'fixture-only';
  listen(options: {
    maxConnections: number;
    headerBytes: number;
    headerMs: number;
    reserveSocket: () => SocketAdmission | undefined;
    onSocket: (slot: SocketAdmission, socket: OwnedSocket) => boolean;
    onListener: (listener: OwnedListener) => boolean;
    onRequest: (request: AcceptedRequest) => void;
    onPipeline: (socket: OwnedSocket) => void;
  }): Promise<OwnedListener>;
  dial(
    endpoint: PinnedEndpoint,
    options: {
      signal: AbortSignal;
      autoSelectFamily: false;
      lookup: () => never;
      onSocket: (socket: OwnedSocket) => boolean;
    }
  ): Promise<DialObservation>;
  exchange(
    socket: OwnedSocket,
    request: FramedRequest,
    body: RequestBody,
    guard: { check: () => void; bodyLimit: number; queueLimit: number }
  ): Promise<OriginResponse>;
}

/** Compare the observed connected peer with the exact policy-pinned numeric endpoint. */
export function verifyPeer(socket: OwnedSocket, selected: PinnedEndpoint) {
  const actual = socket.peer;
  if (
    !actual ||
    classifyAddress(actual.address).address !== selected.address ||
    actual.family !== selected.family ||
    actual.port !== selected.port
  )
    throw new BrokerError('PEER_REFUSED');
}
