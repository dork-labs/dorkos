/**
 * The one place this adapter touches a network.
 *
 * `BuzzSocket` is a two-method seam — send a text frame, close — over which the
 * whole relay client is written. It exists so the protocol code above it is
 * exercised for real by tests that never open a port: a fake relay implements
 * this interface and speaks genuine NIP-01 frames in-process, so what a test
 * proves about the handshake, the subscription multiplexing and the history walk
 * is a property of the shipped code rather than of a mock's return values.
 *
 * The seam is deliberately at the socket and not at the adapter. A fake adapter
 * would assert nothing; a fake socket leaves every line of protocol handling in
 * the path.
 *
 * @module server/services/communities/buzz/buzz-socket
 */
import WebSocket from 'ws';

/** What a socket tells its owner. Every callback is optional to implement, none to call. */
export interface BuzzSocketHandlers {
  /** The socket is open and frames may be sent. */
  onOpen(): void;
  /**
   * One text frame arrived.
   *
   * @param raw - The frame, as received.
   */
  onFrame(raw: string): void;
  /**
   * The socket is gone, for any reason including a clean close.
   *
   * @param reason - Plain-language detail for the log.
   */
  onClose(reason: string): void;
}

/** A connected (or connecting) relay socket. */
export interface BuzzSocket {
  /**
   * Send one text frame. A send on a closed socket is dropped, not thrown: the
   * caller learns about the close from `onClose`, and a race between the two is
   * normal rather than exceptional.
   *
   * @param raw - The frame to send.
   */
  send(raw: string): void;
  /** Close the socket. Idempotent. */
  close(): void;
}

/**
 * Open a socket to a relay.
 *
 * @param url - The relay's WebSocket URL.
 * @param handlers - Where its events go.
 */
export type BuzzSocketFactory = (url: string, handlers: BuzzSocketHandlers) => BuzzSocket;

/**
 * The production factory: a real WebSocket, via `ws`.
 *
 * Every failure mode — a refused connection, a DNS miss, a mid-stream error —
 * arrives as `onClose` with a reason, because the relay client has exactly one
 * thing to do about any of them (report `'unreachable'`, or end the streams) and
 * a second error channel would only be a second place to forget.
 *
 * @param url - The relay's WebSocket URL.
 * @param handlers - Where its events go.
 */
export const webSocketBuzzSocket: BuzzSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data) => handlers.onFrame(data.toString()));
  socket.on('error', (err: Error) => handlers.onClose(err.message));
  socket.on('close', (code, reason) =>
    handlers.onClose(reason.toString() || `socket closed with code ${code}`)
  );
  return {
    send(raw) {
      if (socket.readyState === WebSocket.OPEN) socket.send(raw);
    },
    close() {
      socket.close();
    },
  };
};
