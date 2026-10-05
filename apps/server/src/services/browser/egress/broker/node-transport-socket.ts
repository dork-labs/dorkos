import { Socket } from 'node:net';
import type { OwnedSocket } from './transport.js';
import type { PinnedEndpoint } from '../policy.js';

// The actual original survives callbacks and failed cleanup, independently of DTOs.
const originals = new Set<Socket>();
const rawSockets = new WeakMap<OwnedSocket, Socket>();
/** Capture before invoking broker/user callbacks; destroy is never a close receipt. */
export function ownNodeSocket(original: Socket, returned?: () => void): OwnedSocket {
  originals.add(original);
  let closed = false;
  let failed = false;
  const closes = new Set<() => void>(),
    errors = new Set<() => void>();
  original.on('error', () => {
    failed = true;
    for (const callback of errors) {
      try {
        callback();
      } catch {
        failed = true;
        original.destroy();
      }
    }
  });
  original.once('close', () => {
    closed = true;
    originals.delete(original);
    try {
      returned?.();
    } finally {
      for (const callback of closes) {
        try {
          callback();
        } catch {
          /* Continue actual receipts. */
        }
      }
      closes.clear();
      errors.clear();
    }
  });
  const subscribe = (event: 'data' | 'drain', callback: (...args: unknown[]) => void) => {
    const listener = (...args: unknown[]) => {
      try {
        callback(...args);
      } catch {
        failed = true;
        original.destroy();
      }
    };
    original.on(event, listener);
    return () => {
      original.off(event, listener);
    };
  };
  const wrapper: OwnedSocket = Object.freeze({
    identity: original,
    isCustodyKnown() {
      return !closed && !failed && originals.has(original);
    },
    get peer(): PinnedEndpoint | undefined {
      const family =
        original.remoteFamily === 'IPv4' ? 4 : original.remoteFamily === 'IPv6' ? 6 : undefined;
      return family && original.remoteAddress && original.remotePort
        ? { address: original.remoteAddress, port: original.remotePort, family }
        : undefined;
    },
    get observedClosed() {
      return closed;
    },
    get writableBytes() {
      return original.writableLength;
    },
    onClose(callback: () => void) {
      if (closed)
        queueMicrotask(() => {
          try {
            callback();
          } catch {
            /* Same actual receipt policy as ordinary notification. */
          }
        });
      else closes.add(callback);
      return () => {
        closes.delete(callback);
      };
    },
    onError(callback: () => void) {
      errors.add(callback);
      return () => {
        errors.delete(callback);
      };
    },
    onData(callback: (bytes: Uint8Array) => void) {
      return subscribe('data', (bytes) => callback(bytes as Uint8Array));
    },
    onDrain(callback: () => void) {
      return subscribe('drain', callback);
    },
    write(bytes: Uint8Array) {
      return original.write(bytes);
    },
    pause() {
      original.pause();
    },
    resume() {
      original.resume();
    },
    end() {
      original.end();
    },
    destroy() {
      original.destroy();
    },
  });
  rawSockets.set(wrapper, original);
  return wrapper;
}
/** Private adapter correspondence; a copied OwnedSocket cannot select an original. */
export function originalNodeSocket(socket: OwnedSocket): Socket {
  const original = rawSockets.get(socket);
  if (!original) throw new Error('NODE_SOCKET_UNAVAILABLE');
  return original;
}
