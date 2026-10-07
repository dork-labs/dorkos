import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { createSemanticRelay } from '../bounded-relay.js';
const observedUpgrade = vi.hoisted(() => ({
  armed: false,
  originals: new Set<Promise<void>>(),
  delayed: [] as Array<() => void>,
  closed: [] as Array<() => void>,
  requestClosed: undefined as (() => void) | undefined,
  socketClosed: undefined as (() => void) | undefined,
}));
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return {
    ...actual,
    request(...args: Parameters<typeof actual.request>) {
      const incoming = actual.request(...args);
      if (
        !observedUpgrade.armed ||
        typeof args[0] !== 'object' ||
        args[0] === null ||
        !('path' in args[0]) ||
        args[0].path !== '/devtools/browser/held-original-upgrade'
      )
        return incoming;
      incoming.once('close', () => observedUpgrade.requestClosed?.());
      incoming.once('socket', (socket) => {
        const once = socket.once.bind(socket);
        const returned = new Promise<void>((resolve) =>
          once('close', () => {
            observedUpgrade.socketClosed?.();
            resolve();
          })
        );
        observedUpgrade.originals.add(returned);
        void returned.then(() => observedUpgrade.originals.delete(returned));
        socket.once = ((event: string, listener: (...values: unknown[]) => void) => {
          if (event !== 'close') return Reflect.apply(once, socket, [event, listener]);
          return once('close', (...values: unknown[]) => {
            observedUpgrade.closed.push(() => Reflect.apply(listener, socket, values));
          });
        }) as typeof socket.once;
      });
      const on = incoming.on.bind(incoming);
      incoming.on = ((event: string, listener: (...values: unknown[]) => void) => {
        if (event !== 'upgrade') return Reflect.apply(on, incoming, [event, listener]);
        return on('upgrade', (...values: unknown[]) => {
          observedUpgrade.delayed.push(() => Reflect.apply(listener, incoming, values));
        });
      }) as typeof incoming.on;
      return incoming;
    },
  };
});
const finalizers: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(finalizers.splice(0).map((close) => close()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});
it('joins the actual pending original upstream upgrade on relay close without a fake socket return', async () => {
  const bank: {
    downstream?: ReturnType<typeof request>;
    acquired?: Promise<void>;
  } = {};
  let relay: Awaited<ReturnType<typeof createSemanticRelay>> | undefined,
    closed = false;
  const held = new Set<Duplex>(),
    returns: Promise<void>[] = [],
    pending = new Set<Promise<unknown>>();
  const server = createServer();
  let closing: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    closed = true;
    closing ??= Promise.resolve().then(async () => {
      let first: { reason: unknown } | undefined;
      const original = async (effect: () => unknown) => {
        try {
          await effect();
        } catch (reason) {
          first ??= { reason };
        }
      };
      await original(() => bank.acquired);
      await Promise.allSettled([...pending]);
      await original(() => bank.downstream?.destroy());
      for (const socket of held) await original(() => socket.destroy());
      await original(() => relay?.close());
      await Promise.allSettled(returns);
      await original(() =>
        server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : undefined
      );
      if (first) throw first.reason;
    });
    return closing;
  };
  finalizers.push(finish);
  server.on('connection', (socket) => {
    held.add(socket);
    returns.push(new Promise<void>((resolve) => socket.once('close', resolve)));
    if (closed) socket.destroy();
  });
  let entered!: () => void;
  const upstreamEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.on('upgrade', (_req, socket) => {
    held.add(socket);
    entered();
  });
  bank.acquired = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await bank.acquired;
  if (closed) throw new Error('FIXTURE_CLOSED');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const acquiring = createSemanticRelay(
    'ws://127.0.0.1:' + address.port + '/devtools/browser/exact-owned'
  ).then((value) => {
    relay = value;
    return value;
  });
  pending.add(acquiring);
  relay = await acquiring;
  pending.delete(acquiring);
  if (closed) {
    await relay.close();
    throw new Error('FIXTURE_CLOSED');
  }
  bank.downstream = request(relay.endpoint.replace('ws:', 'http:'), {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'Sec-WebSocket-Version': '13',
    },
  });
  bank.downstream.on('error', () => {});
  bank.downstream.end();
  await upstreamEntered;
  await relay.close();
  expect(server.listening).toBe(true);
  expect(held.size).toBeGreaterThan(0);
});
it('refuses an actual oversized server frame before any payload reaches the semantic client', async () => {
  const bank: { expected?: { reason: unknown } } = {};
  let relay: Awaited<ReturnType<typeof createSemanticRelay>> | undefined,
    client: ReturnType<typeof request> | undefined,
    closed = false;
  const sockets = new Set<Duplex>(),
    returns: Promise<void>[] = [],
    pending = new Set<Promise<unknown>>();
  const server = createServer();
  let closing: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    closed = true;
    closing ??= Promise.resolve().then(async () => {
      let first: { reason: unknown } | undefined;
      const original = async (effect: () => unknown) => {
        try {
          await effect();
        } catch (reason) {
          first ??= { reason };
        }
      };
      await Promise.allSettled([...pending]);
      await original(() => client?.destroy());
      for (const socket of sockets) await original(() => socket.destroy());
      await original(async () => {
        try {
          await relay?.close();
        } catch (reason) {
          if (!bank.expected || !Object.is(bank.expected.reason, reason)) throw reason;
        }
      });
      await Promise.allSettled(returns);
      await original(() =>
        server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : undefined
      );
      if (first) throw first.reason;
    });
    return closing;
  };
  finalizers.push(finish);
  server.on('connection', (socket) => {
    sockets.add(socket);
    returns.push(new Promise<void>((resolve) => socket.once('close', resolve)));
  });
  server.on('upgrade', (incoming, socket) => {
    const accept = createHash('sha1')
      .update(
        String(incoming.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
      )
      .digest('base64');
    socket.write(
      Buffer.concat([
        Buffer.from(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
            accept +
            '\r\n\r\n'
        ),
        Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 16, 0, 1]),
      ])
    );
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  pending.add(listening);
  await listening;
  pending.delete(listening);
  if (closed) throw new Error('FIXTURE_CLOSED');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const acquiring = createSemanticRelay(
    'ws://127.0.0.1:' + address.port + '/devtools/browser/exact-owned'
  ).then((value) => {
    relay = value;
    return value;
  });
  pending.add(acquiring);
  relay = await acquiring;
  pending.delete(acquiring);
  if (closed) throw new Error('FIXTURE_CLOSED');
  let bytes = 0;
  const originalClosed = new Promise<void>((resolve) => {
    client = request(relay!.endpoint.replace('ws:', 'http:'), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
        'Sec-WebSocket-Version': '13',
      },
    });
    client.on('error', () => resolve());
    client.on('upgrade', (_response, socket) => {
      sockets.add(socket);
      socket.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      socket.once('close', resolve);
    });
    client.end();
  });
  await originalClosed;
  expect(bytes).toBe(0);
  let observed: { reason: unknown } | undefined;
  try {
    await relay.close();
  } catch (reason) {
    observed = { reason };
  }
  expect(observed?.reason).toBeInstanceOf(Error);
  expect((observed!.reason as Error).message).toBe('SEMANTIC_WIRE_EXCEEDED');
  bank.expected = observed;
});

it('admits a bounded frame coalesced with genuine upgrade headers and accepts no later TCP clients', async () => {
  let relay: Awaited<ReturnType<typeof createSemanticRelay>> | undefined;
  let closed = false,
    closing: Promise<void> | undefined,
    client: ReturnType<typeof request> | undefined;
  const sockets = new Set<Duplex>(),
    returns: Promise<void>[] = [],
    pending = new Set<Promise<unknown>>();
  const server = createServer();
  let upgrades = 0;
  finalizers.push(() => {
    closed = true;
    return (closing ??= Promise.resolve().then(async () => {
      let first: { reason: unknown } | undefined;
      try {
        client?.destroy();
      } catch (reason) {
        first ??= { reason };
      }
      for (const socket of sockets)
        try {
          socket.destroy();
        } catch (reason) {
          first ??= { reason };
        }
      await Promise.allSettled([...pending]);
      try {
        await relay?.close();
      } catch (reason) {
        first = { reason };
      }
      for (const socket of sockets)
        try {
          socket.destroy();
        } catch (reason) {
          first ??= { reason };
        }
      await Promise.allSettled(returns);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (first) throw first.reason;
    }));
  });
  const retain = (socket: Duplex) => {
    sockets.add(socket);
    returns.push(new Promise<void>((resolve) => socket.once('close', resolve)));
    socket.on('error', () => {});
    if (closed) socket.destroy();
  };
  server.on('connection', retain);
  const frame = Buffer.from([0x81, 2, 123, 125]);
  server.on('upgrade', (incoming, socket) => {
    upgrades++;
    const accept = createHash('sha1')
      .update(
        String(incoming.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
      )
      .digest('base64');
    socket.write(
      Buffer.concat([
        Buffer.from(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
            accept +
            '\r\n\r\n'
        ),
        frame,
      ])
    );
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  pending.add(listening);
  await listening;
  pending.delete(listening);
  if (closed) throw new Error('FIXTURE_CLOSED');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const acquiring = createSemanticRelay(
    'ws://127.0.0.1:' + address.port + '/devtools/browser/original-owned'
  ).then((value) => {
    relay = value;
    return value;
  });
  pending.add(acquiring);
  relay = await acquiring;
  pending.delete(acquiring);
  if (closed) throw new Error('FIXTURE_CLOSED');
  let payload = Buffer.alloc(0);
  const received = new Promise<void>((resolve, reject) => {
    client = request(relay!.endpoint.replace('ws:', 'http:'), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
        'Sec-WebSocket-Version': '13',
      },
    });
    client.once('error', reject);
    client.once('close', () => reject(new Error('FIXTURE_ORIGINAL_REQUEST_CLOSED')));
    returns.push(new Promise<void>((resolve) => client!.once('close', resolve)));
    client.once('upgrade', (_response, socket, head) => {
      retain(socket);
      payload = Buffer.concat([payload, head]);
      if (payload.length >= frame.length) resolve();
      socket.on('data', (bytes: Buffer) => {
        payload = Buffer.concat([payload, bytes]);
        if (payload.length >= frame.length) resolve();
      });
    });
    client.end();
  });
  pending.add(received);
  await received;
  pending.delete(received);
  expect(payload).toEqual(frame);
  const endpoint = new URL(relay.endpoint);
  for (let attempt = 0; attempt < 8; attempt++) {
    const refused = new Promise<string>((resolve, reject) => {
      const socket = createConnection({
        host: '127.0.0.1',
        port: Number(endpoint.port),
      });
      retain(socket);
      socket.once('error', (reason: NodeJS.ErrnoException) => resolve(reason.code ?? 'UNKNOWN'));
      socket.once('connect', () => reject(new Error('UNEXPECTED_LATE_RELAY_CONNECTION')));
    });
    pending.add(refused);
    expect(await refused).toBe('ECONNREFUSED');
    pending.delete(refused);
  }
  expect(upgrades).toBe(1);
  await relay.close();
});

it('joins a real upstream socket even after request close and delayed upgrade delivery', async () => {
  const bank: { client?: ReturnType<typeof request> } = {};
  let relay: Awaited<ReturnType<typeof createSemanticRelay>> | undefined;
  let stopping = false,
    finished: Promise<void> | undefined,
    acquiring: Promise<unknown> | undefined;
  const sockets = new Set<Duplex>(),
    receipts: Promise<void>[] = [];
  const server = createServer();
  const release = () => {
    for (const original of observedUpgrade.delayed.splice(0)) original();
    for (const original of observedUpgrade.closed.splice(0)) original();
  };
  const finish = (): Promise<void> => {
    stopping = true;
    release();
    return (finished ??= Promise.resolve().then(async () => {
      let first: { reason: unknown } | undefined;
      try {
        await acquiring;
      } catch (reason) {
        first ??= { reason };
      }
      bank.client?.destroy();
      for (const socket of sockets) socket.destroy();
      const originalClose = relay?.close();
      release();
      // The genuine socket event may enqueue its captured callback after destruction.
      await Promise.allSettled([...receipts, ...observedUpgrade.originals]);
      release();
      try {
        await originalClose;
      } catch (reason) {
        first ??= { reason };
      }
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      observedUpgrade.armed = false;
      observedUpgrade.requestClosed = observedUpgrade.socketClosed = undefined;
      if (first) throw first.reason;
    }));
  };
  finalizers.push(finish);
  server.on('connection', (socket) => {
    sockets.add(socket);
    receipts.push(new Promise<void>((resolve) => socket.once('close', resolve)));
    if (stopping) socket.destroy();
  });
  server.on('upgrade', (incoming, socket) => {
    const accept = createHash('sha1')
      .update(
        String(incoming.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
      )
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n'
    );
  });
  acquiring = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await acquiring;
  if (stopping) throw new Error('FIXTURE_CLOSED');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  acquiring = createSemanticRelay(
    'ws://127.0.0.1:' + address.port + '/devtools/browser/held-original-upgrade'
  ).then((value) => {
    relay = value;
  });
  await acquiring;
  if (stopping || !relay) throw new Error('FIXTURE_CLOSED');
  const requestClosed = new Promise<void>((resolve) => {
    observedUpgrade.requestClosed = resolve;
  });
  const socketClosed = new Promise<void>((resolve) => {
    observedUpgrade.socketClosed = resolve;
  });
  observedUpgrade.armed = true;
  bank.client = request(relay.endpoint.replace('ws:', 'http:'), {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==',
      'Sec-WebSocket-Version': '13',
    },
  });
  bank.client.on('error', () => {});
  receipts.push(new Promise<void>((resolve) => bank.client!.once('close', resolve)));
  bank.client.end();
  await requestClosed;
  expect(observedUpgrade.delayed).toHaveLength(1);
  let returned = false;
  const close = relay.close().then(() => {
    returned = true;
  });
  await socketClosed;
  expect(returned).toBe(false);
  expect(observedUpgrade.closed.length).toBeGreaterThan(0);
  release();
  await close;
  expect(returned).toBe(true);
});
