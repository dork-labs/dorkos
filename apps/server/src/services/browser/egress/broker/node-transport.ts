import { createServer as createNetServer, Socket, isIP, type Server as NetServer } from 'node:net';
import {
  Agent,
  createServer as createHTTPServer,
  request as httpRequest,
  type IncomingMessage,
  type ClientRequest,
} from 'node:http';
import type {
  RequestBody,
  BrokerTransport,
  OwnedListener,
  OwnedSocket,
  OriginResponse,
} from './transport.js';
import { BrokerError } from './errors.js';
import { ownNodeSocket, originalNodeSocket } from './node-transport-socket.js';
import { forwardFlow } from './flow.js';

type IntakeOwner = {
  server: NetServer;
  sockets: Set<Socket>;
  stopped: boolean;
  nativeClosed: boolean;
  closed: boolean;
  callbacks: Set<() => void>;
};
const retainedIntakes = new Set<IntakeOwner>();
const retainedMessages = new Set<IncomingMessage | ClientRequest>();
function ownMessage<T extends IncomingMessage | ClientRequest>(message: T, upgraded = false): T {
  retainedMessages.add(message);
  message.once('close', () => retainedMessages.delete(message));
  if (upgraded) {
    // CONNECT/upgrade hands native IO to the raw original; Node does not emit
    // IncomingMessage close for this header-only view. Its original socket's
    // real close retires that view without fabricating a body EOF/close event.
    (message as IncomingMessage).socket.once('close', () => retainedMessages.delete(message));
  }
  return message;
}
function body(message: IncomingMessage): RequestBody {
  message.pause();
  return Object.freeze({
    onData(callback: (bytes: Uint8Array) => void) {
      message.on('data', callback);
      return () => {
        message.off('data', callback);
      };
    },
    onEnd(callback: () => void) {
      if (message.readableEnded) queueMicrotask(callback);
      else message.on('end', callback);
      return () => {
        message.off('end', callback);
      };
    },
    pause() {
      message.pause();
    },
    resume() {
      message.resume();
    },
  });
}
/** Public Node exposes accept only afterward. This private composition owns the
 * listener/intake BEFORE listen, and every delivered original before callbacks.
 * Callback-time quota registration is not represented as native preaccept proof.
 * Overflow stops the whole pre-owned intake; it never uses internal unobserved drops.
 */
export function createNodeBrokerTransport(): BrokerTransport {
  return Object.freeze<BrokerTransport>({
    intake: 'listener-owned' as const,
    scope: 'fixture-only' as const,
    listen(options: Parameters<BrokerTransport['listen']>[0]): Promise<OwnedListener> {
      if (
        !Number.isSafeInteger(options.maxConnections) ||
        options.maxConnections < 1 ||
        !Number.isSafeInteger(options.headerBytes) ||
        options.headerBytes < 1 ||
        options.headerBytes > 16384 ||
        !Number.isSafeInteger(options.headerMs) ||
        options.headerMs < 1 ||
        options.headerMs > 5000
      )
        throw new BrokerError('UNAVAILABLE');
      const parser = createHTTPServer({
        maxHeaderSize: options.headerBytes,
        insecureHTTPParser: false,
      });
      parser.maxHeadersCount = 0; // No silent header truncation; bounded raw bytes reach broker validation.
      parser.headersTimeout = options.headerMs;
      parser.requestTimeout = 0; // Broker owns the bounded request/body operation.
      const owner: IntakeOwner = {
        server: createNetServer({ pauseOnConnect: true }),
        sockets: new Set(),
        stopped: false,
        nativeClosed: false,
        closed: false,
        callbacks: new Set(),
      };
      retainedIntakes.add(owner); // Before listen/acquisition, not a postaccept rescue.
      const wrappers = new WeakMap<Socket, OwnedSocket>();
      const headerTimers = new Map<Socket, ReturnType<typeof setTimeout>>();
      const started = new WeakSet<Socket>();
      const settle = () => {
        if (owner.closed || !owner.nativeClosed || owner.sockets.size) return;
        owner.closed = true;
        retainedIntakes.delete(owner);
        for (const callback of owner.callbacks) {
          try {
            callback();
          } catch {
            /* Continue actual receipts. */
          }
        }
        owner.callbacks.clear();
      };
      const stop = () => {
        owner.stopped = true;
        for (const socket of owner.sockets) {
          try {
            socket.destroy();
          } catch {
            /* Keep exact original. */
          }
        }
        try {
          owner.server.close();
        } catch {
          /* Only native close can settle intake. */
        }
      };
      owner.server.once('close', () => {
        owner.nativeClosed = true;
        settle();
      });
      const listener: OwnedListener = Object.freeze({
        address: '127.0.0.1' as const,
        get port() {
          const address = owner.server.address();
          return address && typeof address !== 'string' ? address.port : 0;
        },
        identity: owner.server,
        onClose(callback: () => void) {
          if (owner.closed)
            queueMicrotask(() => {
              try {
                callback();
              } catch {
                /* Continue actual late receipts. */
              }
            });
          else owner.callbacks.add(callback);
          return () => {
            owner.callbacks.delete(callback);
          };
        },
        close: stop,
      });
      const receive = (request: IncomingMessage, head = new Uint8Array(), upgraded = false) => {
        ownMessage(request, upgraded);
        const original = request.socket,
          wrapper = wrappers.get(original);
        if (!wrapper || owner.stopped) {
          stop();
          return;
        }
        const timer = headerTimers.get(original);
        if (timer) clearTimeout(timer);
        headerTimers.delete(original);
        if (started.has(original)) {
          options.onPipeline(wrapper);
          return;
        }
        started.add(original);
        request.on('error', () => {
          original.destroy();
        });
        try {
          options.onRequest({
            client: wrapper,
            body: body(request),
            raw: {
              method: request.method ?? '',
              target: request.url ?? '',
              rawHeaders: request.rawHeaders,
              head,
            },
          });
        } catch {
          stop();
        }
      };
      parser.on('request', (request) => receive(request));
      parser.on('connect', (request, _socket, head) => receive(request, head, true));
      parser.on('upgrade', (request, _socket, head) => receive(request, head, true));
      parser.on('clientError', (_error, socket) => {
        socket.destroy();
      });
      owner.server.on('connection', (original) => {
        // First operation: bind exact original to the already-retained intake.
        owner.sockets.add(original);
        const wrapper = ownNodeSocket(original, () => {
          owner.sockets.delete(original);
          const timer = headerTimers.get(original);
          if (timer) clearTimeout(timer);
          headerTimers.delete(original);
          settle();
        });
        wrappers.set(original, wrapper);
        if (owner.stopped || owner.sockets.size > options.maxConnections) {
          stop();
          return;
        }
        try {
          const slot = options.reserveSocket();
          if (!slot || !options.onSocket(slot, wrapper) || owner.stopped) {
            stop();
            return;
          }
          headerTimers.set(
            original,
            setTimeout(() => {
              original.destroy();
            }, options.headerMs)
          );
          // Node HTTP's parser is attached only AFTER original custody/quota callbacks.
          parser.emit('connection', original);
          original.resume();
        } catch {
          stop();
        }
      });
      return new Promise<OwnedListener>((resolve, reject) => {
        owner.server.on('error', (error) => {
          stop();
          reject(error);
        });
        try {
          if (!options.onListener(listener) || owner.stopped) {
            stop();
            reject(new BrokerError('CLOSED'));
            return;
          }
          owner.server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
            if (owner.stopped) {
              stop();
              reject(new BrokerError('CLOSED'));
            } else resolve(listener);
          });
        } catch (error) {
          stop();
          reject(error);
        }
      });
    },
    async dial(endpoint, options) {
      if (
        isIP(endpoint.address) !== endpoint.family ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535 ||
        options.autoSelectFamily !== false
      )
        throw new BrokerError('PEER_REFUSED');
      const original = new Socket(); // No network acquisition yet.
      const socket = ownNodeSocket(original);
      let admitted = false;
      try {
        admitted = options.onSocket(socket);
      } catch {
        original.destroy();
      }
      if (!admitted || options.signal.aborted) {
        original.destroy();
        return { socket, outcome: 'failed' as const };
      }
      return new Promise<Awaited<ReturnType<BrokerTransport['dial']>>>((resolve) => {
        let settled = false;
        const settle = (outcome: 'connected' | 'failed') => {
          if (!settled) {
            settled = true;
            resolve({ socket, outcome });
          }
        };
        const abort = () => {
          original.destroy();
          settle('failed');
        };
        options.signal.addEventListener('abort', abort, { once: true });
        original.once('close', () => {
          options.signal.removeEventListener('abort', abort);
          settle('failed');
        });
        original.once('error', () => settle('failed'));
        original.once('connect', () => {
          original.pause();
          settle('connected');
        });
        try {
          original.connect({
            host: endpoint.address,
            port: endpoint.port,
            family: endpoint.family,
            autoSelectFamily: false,
            lookup: options.lookup,
          });
        } catch {
          original.destroy();
          settle('failed');
        }
      });
    },
    exchange(socket, framed, input, guard) {
      const original = originalNodeSocket(socket);
      guard.check();
      if (socket.observedClosed || !socket.peer) return Promise.reject(new BrokerError('CLOSED'));
      const agent = new Agent({ keepAlive: false, maxSockets: 1 });
      let supplied = false;
      agent.createConnection = () => {
        if (supplied) throw new BrokerError('PEER_REFUSED');
        supplied = true;
        guard.check();
        return original;
      };
      return new Promise<OriginResponse>((resolve, reject) => {
        const forwarding: { flow?: ReturnType<typeof forwardFlow> } = {};
        const headers = { ...framed.headers };
        if (framed.kind === 'http' && framed.contentLength === undefined)
          headers['transfer-encoding'] = 'chunked';
        let request: ClientRequest;
        try {
          guard.check();
          request = ownMessage(
            httpRequest({
              host: socket.peer!.address,
              port: socket.peer!.port,
              method: framed.method,
              path: framed.path,
              headers,
              agent,
              maxHeaderSize: 16384,
              insecureHTTPParser: false,
              lookup: () => {
                throw new BrokerError('PEER_REFUSED');
              },
            })
          );
        } catch (error) {
          agent.destroy();
          reject(error);
          return;
        }
        request.once('socket', () => {
          try {
            guard.check();
            original.resume();
          } catch (error) {
            reject(error);
            original.destroy();
          }
        });
        request.once('close', () => {
          forwarding.flow?.stop();
          agent.destroy();
        });
        request.once('error', (error) => {
          forwarding.flow?.stop();
          reject(error);
        });
        const response = (message: IncomingMessage, head = new Uint8Array(), upgraded = false) => {
          ownMessage(message, upgraded);
          message.on('error', (error) => {
            reject(error);
            original.destroy();
          });
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(message.headers))
            if (value !== undefined && name !== 'set-cookie')
              responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
          resolve({
            status: message.statusCode ?? 0,
            headers: responseHeaders,
            setCookies: message.headers['set-cookie'],
            websocketAccept: responseHeaders['sec-websocket-accept'],
            body: body(message),
            head,
          });
        };
        request.once('response', (message) => response(message));
        request.once('upgrade', (message, upgraded, head) => {
          if (upgraded !== original) {
            original.destroy();
            reject(new BrokerError('PEER_REFUSED'));
            return;
          }
          response(message, head, true);
        });
        if (framed.kind === 'websocket') {
          try {
            guard.check();
            request.end();
          } catch (error) {
            reject(error);
            original.destroy();
          }
          return;
        }
        const target: OwnedSocket = {
          identity: request,
          get observedClosed() {
            return request.destroyed;
          },
          get writableBytes() {
            return request.writableLength;
          },
          onClose(callback) {
            request.on('close', callback);
            return () => {
              request.off('close', callback);
            };
          },
          onError(callback) {
            request.on('error', callback);
            return () => {
              request.off('error', callback);
            };
          },
          onData() {
            throw new BrokerError('UNAVAILABLE');
          },
          onDrain(callback) {
            request.on('drain', callback);
            return () => {
              request.off('drain', callback);
            };
          },
          write(bytes) {
            return request.write(bytes);
          },
          pause() {},
          resume() {},
          end() {
            request.end();
          },
          destroy() {
            original.destroy();
          },
        };
        forwarding.flow = forwardFlow({
          source: input,
          target,
          check: guard.check,
          limit: guard.bodyLimit,
          queueLimit: guard.queueLimit,
          resumeOnStart: true,
          endOnSourceEOF: true,
          onFailure: (error) => {
            reject(error);
            original.destroy();
          },
        });
      });
    },
  });
}
