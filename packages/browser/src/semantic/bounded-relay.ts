import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { SemanticFrameBudget, SemanticWireRefusal } from './frame-budget.js';

/**
 * Private exact-owned endpoint relay. Only the supervisor's original endpoint is
 * supplied here; a request body can never select an upstream or a protocol action.
 * Raw frames are charged before forwarding to a separate semantic SDK connection.
 */
export async function createSemanticRelay(originalEndpoint: string) {
  const endpoint = new URL(originalEndpoint);
  if (
    endpoint.protocol !== 'ws:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    endpoint.pathname.length > 2048
  )
    throw new SemanticWireRefusal('SEMANTIC_ENDPOINT');
  const privatePath = '/semantic/' + randomBytes(16).toString('base64url');
  let closed = false,
    entered = false,
    first: { reason: unknown } | undefined;
  let refuse!: (reason: unknown) => void;
  const failure = new Promise<never>((_a, b) => {
    refuse = b;
  });
  void failure.catch(() => {});
  const record = (reason: unknown) => {
    first ??= { reason };
    refuse(first.reason);
  };
  const sockets = new Map<Duplex, Promise<void>>();
  const requests = new Set<Promise<void>>();
  const releases: (() => void)[] = [];
  let closing: Promise<void> | undefined;
  const retain = (socket: Duplex, cancelled?: unknown) => {
    if (sockets.has(socket)) return;
    const original = new Promise<void>((resolve) => socket.once('close', resolve));
    sockets.set(socket, original);
    void original.then(() => sockets.delete(socket));
    socket.on('error', (reason) => {
      if (!(closed && cancelled !== undefined && Object.is(reason, cancelled))) record(reason);
    });
    if (closed)
      try {
        socket.destroy();
      } catch (reason) {
        record(reason);
      }
  };
  const bridge = (source: Duplex, target: Duplex, masked: boolean, head?: Buffer) => {
    const budget = new SemanticFrameBudget(masked);
    const write = target.write.bind(target),
      pause = source.pause.bind(source),
      resume = source.resume.bind(source);
    const on = source.on.bind(source),
      off = source.off.bind(source);
    const targetOn = target.on.bind(target),
      targetOff = target.off.bind(target);
    const data = (chunk: Buffer) => {
      try {
        if (closed) throw new SemanticWireRefusal('SEMANTIC_RELAY_CLOSED');
        budget.admit(chunk);
        if (!write(chunk)) pause();
      } catch (reason) {
        record(reason);
        void close().catch(() => {});
      }
    };
    const drain = () => {
      if (!closed) resume();
    };
    const end = () => {
      try {
        budget.finish();
        target.end();
      } catch (reason) {
        record(reason);
        void close().catch(() => {});
      }
    };
    // Cleanup is retained before the first original listener can reenter closure.
    releases.push(() => {
      let failure: { reason: unknown } | undefined;
      for (const remove of [
        () => off('data', data),
        () => off('end', end),
        () => targetOff('drain', drain),
      ])
        try {
          remove();
        } catch (reason) {
          failure ??= { reason };
        }
      if (failure) throw failure.reason;
    });
    targetOn('drain', drain);
    on('end', end);
    if (head?.length) data(head);
    if (!closed) on('data', data);
  };
  const server = createServer({ maxHeaderSize: 8192 }, (_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  // Exactly one semantic SDK connection. Stop accepting on its original TCP birth;
  // rejected clients cannot accumulate an unbounded retained socket bank.
  server.maxConnections = 1;
  const serverClose = server.close.bind(server);
  let listenerClosing: Promise<void> | undefined;
  const stopListening = (): Promise<void> => {
    if (listenerClosing) return listenerClosing;
    if (!server.listening) return Promise.resolve();
    let accept!: () => void;
    const original = new Promise<void>((resolve) => {
      accept = resolve;
    });
    listenerClosing = original;
    try {
      serverClose((reason) => {
        if (reason) record(reason);
        accept();
      });
    } catch (reason) {
      record(reason);
      accept();
    }
    return original;
  };
  const close = (): Promise<void> => {
    closed = true;
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      for (const release of releases.splice(0))
        try {
          release();
        } catch (reason) {
          record(reason);
        }
      for (const socket of sockets.keys())
        try {
          socket.destroy();
        } catch (reason) {
          record(reason);
        }
      await Promise.allSettled([...requests, ...sockets.values()]);
      await stopListening();
      // Request close is not upgraded-socket return. Preserve late original
      // sockets until their captured close callbacks have actually settled.
      while (sockets.size || requests.size)
        await Promise.allSettled([...requests, ...sockets.values()]);
      if (first) throw first.reason;
    });
    return closing;
  };
  server.on('connection', (socket: Socket) => {
    retain(socket);
    void stopListening();
    if (closed || sockets.size > 2) socket.destroy();
  });
  server.on('upgrade', (incoming, downstream, head) => {
    retain(downstream);
    if (closed || entered || incoming.url !== privatePath || head.length) {
      downstream.destroy();
      return;
    }
    entered = true;
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: Number(endpoint.port),
      path: endpoint.pathname,
      method: 'GET',
      maxHeaderSize: 8192,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': incoming.headers['sec-websocket-key'] ?? '',
      },
    });
    let settle!: () => void;
    const original = new Promise<void>((resolve) => {
      settle = resolve;
    });
    requests.add(original);
    upstream.once('close', () => {
      settle();
      requests.delete(original);
    });
    const cancelled = new SemanticWireRefusal('SEMANTIC_RELAY_CANCELLED');
    upstream.on('socket', (socket) => retain(socket, cancelled));
    upstream.on('error', (reason) => {
      if (!(closed && reason === cancelled)) record(reason);
      downstream.destroy();
    });
    upstream.on('response', (response) => {
      record(new SemanticWireRefusal('SEMANTIC_UPGRADE'));
      response.destroy();
      downstream.destroy();
    });
    upstream.on('upgrade', (response, socket, upstreamHead) => {
      retain(socket);
      if (closed || response.statusCode !== 101 || response.headers['sec-websocket-extensions']) {
        socket.destroy();
        downstream.destroy();
        return;
      }
      const accept = response.headers['sec-websocket-accept'];
      if (typeof accept !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(accept)) {
        socket.destroy();
        downstream.destroy();
        return;
      }
      downstream.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n'
      );
      bridge(downstream, socket, true);
      bridge(socket, downstream, false, upstreamHead);
    });
    releases.push(() => upstream.destroy(cancelled));
    upstream.end();
  });
  let accept!: () => void, reject!: (reason: unknown) => void;
  const listening = new Promise<void>((a, b) => {
    accept = a;
    reject = b;
  });
  server.on('error', (reason) => {
    record(reason);
    reject(reason);
    void close().catch(() => {});
  });
  server.listen(0, '127.0.0.1', accept);
  try {
    await listening;
    const address = server.address();
    if (closed || !address || typeof address === 'string')
      throw new SemanticWireRefusal('SEMANTIC_LISTENER');
    return Object.freeze({
      endpoint: 'ws://127.0.0.1:' + address.port + privatePath,
      close,
      failure,
    });
  } catch (reason) {
    record(reason);
    await close();
    throw reason;
  }
}
