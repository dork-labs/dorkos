import { describe, expect, it, vi } from 'vitest';
import { createCustodyBroker } from './broker.js';
import {
  MAX_METADATA_BYTES,
  decodeReply,
  decodeWorker,
  encodeMetadata,
  type RunDescriptor,
  type WorkerMetadata,
} from './metadata.js';

const id = (n: number) => n.toString(16).padStart(32, '0');
const run: RunDescriptor = {
  version: 1,
  runId: id(1),
  generation: id(2),
  capability: '4a'.repeat(32),
};
const acquire = (request: number, scope = request, deadline: number | null = null) => ({
  kind: 'acquire' as const,
  requestId: id(request),
  scopeId: id(scope),
  deadline,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function endpoint(index: number) {
  const scope = deferred<void>();
  const connected = deferred<void>();
  const main = vi.fn();
  const join = vi.fn(async (_deadline: number) => 'closed' as const);
  return {
    scope,
    connected,
    endpoint: {
      connection: { endpointId: id(index), token: 'fa'.repeat(32) },
      scopeEnded: scope.promise,
      scopeConnected: connected.promise,
      closeMain: main,
      join,
    },
  };
}

type IO = Parameters<typeof createCustodyBroker>[1];

function fixture(createEndpoint: IO['open']) {
  let clock = 100;
  const timers = new Map<() => void, number>();
  const replies = new Map<string, Uint8Array>();
  const open = vi.fn(createEndpoint);
  const publish = vi.fn<IO['publish']>(async (request, bytes, signal, expectedReady) => {
    if (signal.aborted) return;
    const previous = replies.get(request.requestId);
    if (expectedReady ? previous !== expectedReady : previous !== undefined)
      throw new Error('Unexpected fixture reply replacement');
    replies.set(request.requestId, bytes);
  });
  const withdraw = vi.fn<IO['withdraw']>(async (request) => {
    replies.delete(request.requestId);
  });
  const broker = createCustodyBroker(
    run,
    {
      now: () => clock,
      at(deadline, callback) {
        timers.set(callback, deadline);
        return () => {
          timers.delete(callback);
        };
      },
      open,
      publish,
      withdraw,
    },
    50
  );
  return {
    broker,
    open,
    publish,
    withdraw,
    replies,
    timers,
    offer: (metadata: WorkerMetadata) => broker.offer(encodeMetadata(run, metadata)),
    advance(deadline: number) {
      clock = deadline;
      for (const [fire, time] of timers) {
        if (time <= clock) {
          timers.delete(fire);
          fire();
        }
      }
    },
  };
}

async function flush() {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}

describe('test custody metadata', () => {
  it('authenticates strict bounded records and excludes private command inputs', () => {
    const request = acquire(11, 20, 400);
    const bytes = encodeMetadata(run, {
      ...request,
      ...{ argv: ['secret-argv'], env: { TOKEN: 'secret-env' } },
    });
    expect(decodeWorker(run, bytes)).toEqual(request);
    expect(Buffer.from(bytes).toString()).not.toMatch(/secret-|capability|argv|env/);
    expect(decodeWorker({ ...run, generation: id(55) }, bytes)).toBeUndefined();
    expect(decodeWorker({ ...run, runId: id(55) }, bytes)).toBeUndefined();
    expect(decodeWorker({ ...run, capability: '33'.repeat(32) }, bytes)).toBeUndefined();
    expect(decodeWorker(run, new Uint8Array(MAX_METADATA_BYTES + 1))).toBeUndefined();
    expect(decodeWorker(run, new Uint8Array([0xff]))).toBeUndefined();
    const badDeadline = encodeMetadata(run, { ...request, deadline: 1.5 });
    expect(decodeWorker(run, badDeadline)).toBeUndefined();
    const raw = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>;
    expect(decodeWorker(run, Buffer.from(JSON.stringify({ ...raw, env: {} })))).toBeUndefined();
    expect(
      decodeWorker(run, Buffer.from(JSON.stringify({ ...raw, fields: [401] })))
    ).toBeUndefined();
    expect(
      decodeWorker(run, Buffer.from(JSON.stringify({ ...raw, scopeId: id(42) })))
    ).toBeUndefined();
  });

  it('matches replies to the exact run, scope and request and forbids reverse direction', () => {
    const request = acquire(10);
    const ready = {
      ...request,
      kind: 'ready' as const,
      connection: endpoint(4).endpoint.connection,
    };
    const bytes = encodeMetadata(run, ready);
    expect(decodeReply(run, request, bytes)).toMatchObject({
      kind: 'ready',
      requestId: request.requestId,
      scopeId: request.scopeId,
      connection: ready.connection,
    });
    expect(decodeReply(run, { ...request, requestId: id(24) }, bytes)).toBeUndefined();
    expect(decodeReply(run, { ...request, scopeId: id(25) }, bytes)).toBeUndefined();
    expect(decodeReply({ ...run, generation: id(99) }, request, bytes)).toBeUndefined();
    expect(decodeWorker(run, bytes)).toBeUndefined();
  });
  it('binds the POSIX route and canonical short directory into ready metadata', () => {
    const request = acquire(10);
    const connection = {
      ...endpoint(30).endpoint.connection,
      transport: 'posix' as const,
      directory: '/tmp/owned-posix',
    };
    const ready = { ...request, kind: 'ready' as const, connection };
    const bytes = encodeMetadata(run, ready);
    expect(decodeReply(run, request, bytes)).toMatchObject({ kind: 'ready', connection });
    const raw = JSON.parse(Buffer.from(bytes).toString()) as { fields: string[] };
    for (const fields of [
      raw.fields.slice(0, 2),
      [...raw.fields.slice(0, 3), '/tmp/replacement'],
      [...raw.fields.slice(0, 2), 'another-transport', connection.directory],
    ]) {
      expect(
        decodeReply(run, request, Buffer.from(JSON.stringify({ ...raw, fields })))
      ).toBeUndefined();
    }
    for (const directory of ['/tmp/../owned', 'relative', '/' + 'x'.repeat(100)]) {
      expect(
        decodeReply(
          run,
          request,
          encodeMetadata(run, {
            ...ready,
            connection: { ...connection, directory },
          })
        )
      ).toBeUndefined();
    }
  });
});

describe('test custody broker', () => {
  it('queues fairly under a per-sweep limit without a worker ceiling or slow-open blockage', async () => {
    const first = deferred<ReturnType<typeof endpoint>['endpoint']>();
    const endpoints = Array.from({ length: 7 }, (_, index) => endpoint(100 + index));
    const f = fixture((request) => {
      const number = Number.parseInt(request.requestId, 16);
      return number === 10 ? first.promise : Promise.resolve(endpoints[number - 10]!.endpoint);
    });
    for (let i = 10; i < 17; i++) expect(f.offer(acquire(i))).toBe(true);
    for (const expected of [2, 2, 2, 1, 0]) {
      expect(f.broker.sweep(2)).toBe(expected);
      await flush();
    }
    expect(f.open.mock.calls.map(([request]) => request.requestId)).toEqual(
      Array.from({ length: 7 }, (_, index) => id(10 + index))
    );
    expect(f.replies.size).toBe(6);
    for (const entry of endpoints) entry.connected.resolve();
    first.resolve(endpoints[0]!.endpoint);
    await flush();
    const stop = f.broker.close();
    for (const entry of endpoints) expect(entry.endpoint.closeMain).toHaveBeenCalledTimes(1);
    await expect(stop).resolves.toBe('closed');
    expect(f.replies.size).toBe(0);
  });

  it('refuses newly authenticated busy and expired requests without opening an endpoint', async () => {
    const peer = endpoint(50);
    const f = fixture(async () => peer.endpoint);
    const one = acquire(10, 55);
    const busy = acquire(11, 55);
    const expired = acquire(12, 99, 100);
    expect(f.offer(one)).toBe(true);
    expect(f.offer(one)).toBe(false);
    expect(f.offer(busy)).toBe(true);
    expect(f.offer(expired)).toBe(true);
    expect(f.offer(busy)).toBe(false);
    expect(f.offer(expired)).toBe(false);
    const cancelled = acquire(14, 78);
    expect(f.offer({ ...cancelled, kind: 'cancel' })).toBe(true);
    expect(f.offer(cancelled)).toBe(false);
    expect(f.offer({ ...one, kind: 'cancel' })).toBe(true);
    expect(f.broker.sweep(9)).toBe(2);
    await flush();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(decodeReply(run, busy, f.replies.get(busy.requestId)!)).toEqual({
      kind: 'refused',
      requestId: busy.requestId,
      scopeId: busy.scopeId,
      reason: 'busy',
    });
    expect(decodeReply(run, expired, f.replies.get(expired.requestId)!)).toEqual({
      kind: 'refused',
      requestId: expired.requestId,
      scopeId: expired.scopeId,
      reason: 'expired',
    });
    expect(decodeReply(run, one, f.replies.get(busy.requestId)!)).toBeUndefined();
    await expect(f.broker.close()).resolves.toBe('closed');
    expect(f.replies.size).toBe(0);
  });

  it('cancels queued and in-flight refusals and never emits a refusal for a forged request', async () => {
    const f = fixture(async () => endpoint(70).endpoint);
    const forged = encodeMetadata({ ...run, capability: '01'.repeat(32) }, acquire(10, 55, 95));
    expect(f.broker.offer(forged)).toBe(false);
    const queued = acquire(11, 56, 95);
    expect(f.offer(queued)).toBe(true);
    expect(f.offer({ ...queued, kind: 'cancel' })).toBe(true);
    expect(f.broker.sweep(1)).toBe(0);
    const paused = deferred<void>();
    f.publish.mockImplementation(async (request, reply, signal) => {
      await paused.promise;
      if (!signal.aborted) f.replies.set(request.requestId, reply);
    });
    const inFlight = acquire(12, 57, 95);
    expect(f.offer(inFlight)).toBe(true);
    expect(f.broker.sweep(1)).toBe(1);
    await flush();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.offer({ ...inFlight, kind: 'cancel' })).toBe(true);
    expect(f.publish.mock.calls[0]![2].aborted).toBe(true);
    const closing = f.broker.close();
    paused.resolve();
    await expect(closing).resolves.toBe('closed');
    expect(f.replies.size).toBe(0);
    expect(f.open).not.toHaveBeenCalled();
  });

  it('keeps the original deadline active until the scope connects and prevents late admission', async () => {
    const peer = endpoint(60);
    const f = fixture(async () => peer.endpoint);
    const request = acquire(10, 55, 140);
    f.offer(request);
    expect(f.broker.sweep(1)).toBe(1);
    await flush();
    expect(decodeReply(run, request, f.replies.get(request.requestId)!)).toMatchObject({
      kind: 'ready',
    });
    expect(f.open.mock.calls[0]![0].deadline).toBe(140);
    f.advance(140);
    expect(f.open.mock.calls[0]![1].aborted).toBe(true);
    expect(peer.endpoint.closeMain).toHaveBeenCalledTimes(1);
    peer.connected.resolve();
    await flush();
    expect(f.replies.size).toBe(0);
    expect(peer.endpoint.join).toHaveBeenCalledExactlyOnceWith(190);
    expect(f.offer(request)).toBe(false);
    await expect(f.broker.close()).resolves.toBe('closed');
  });

  it('closes a single worker endpoint independently and leaves another scope admitted', async () => {
    const a = endpoint(60);
    const b = endpoint(61);
    const f = fixture(async (request) => (request.requestId === id(10) ? a.endpoint : b.endpoint));
    f.offer(acquire(10));
    f.offer(acquire(11));
    f.broker.sweep(2);
    a.connected.resolve();
    b.connected.resolve();
    await flush();
    a.scope.resolve();
    await flush();
    expect(a.endpoint.closeMain).toHaveBeenCalledTimes(1);
    expect(b.endpoint.closeMain).not.toHaveBeenCalled();
    expect(f.replies.has(id(11))).toBe(true);
    await expect(f.broker.close()).resolves.toBe('closed');
    expect(b.endpoint.closeMain).toHaveBeenCalledTimes(1);
  });

  it('rejects late work and reports uncertainty while retiring a delayed endpoint', async () => {
    const pending = deferred<ReturnType<typeof endpoint>['endpoint']>();
    const peer = endpoint(77);
    const f = fixture(() => pending.promise);
    f.offer(acquire(10));
    f.broker.sweep(1);
    await flush();
    const closing = f.broker.close();
    expect(f.broker.close()).toBe(closing);
    expect(f.open.mock.calls[0]![1].aborted).toBe(true);
    expect(f.offer(acquire(11))).toBe(false);
    expect(f.broker.sweep(10)).toBe(0);
    f.advance(150);
    await expect(closing).resolves.toBe('cleanup-uncertain');
    pending.resolve(peer.endpoint);
    await flush();
    expect(peer.endpoint.closeMain).toHaveBeenCalledTimes(1);
    expect(peer.endpoint.join).toHaveBeenCalledExactlyOnceWith(150);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('closes the main writer before a blocked publisher settles and withdraws the reply', async () => {
    const peer = endpoint(90);
    const paused = deferred<void>();
    const f = fixture(async () => peer.endpoint);
    f.publish.mockImplementation(async (request, reply, signal) => {
      await paused.promise;
      if (!signal.aborted) f.replies.set(request.requestId, reply);
    });
    const scopeEnded = vi.fn();
    void peer.scope.promise.then(scopeEnded);
    f.offer(acquire(10));
    f.broker.sweep(1);
    await flush();
    expect(f.publish).toHaveBeenCalledTimes(1);
    const retiring = f.broker.close();
    expect(peer.endpoint.closeMain).toHaveBeenCalledTimes(1);
    expect(scopeEnded).not.toHaveBeenCalled();
    expect(f.publish.mock.calls[0]![2].aborted).toBe(true);
    paused.resolve();
    await expect(retiring).resolves.toBe('closed');
    expect(f.replies.size).toBe(0);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid and pre-authentication terminal endpoints while joining ownership', async () => {
    const bad = endpoint(80);
    const late = endpoint(81);
    const f = fixture(async (request) =>
      request.requestId === id(10)
        ? { ...bad.endpoint, connection: { endpointId: '', token: '' } }
        : late.endpoint
    );
    const invalid = acquire(10);
    const ended = acquire(11);
    f.offer(invalid);
    f.offer(ended);
    f.broker.sweep(2);
    await flush();
    expect(decodeReply(run, ended, f.replies.get(ended.requestId)!)).toMatchObject({
      kind: 'ready',
    });
    late.scope.resolve();
    await flush();
    for (const [request, owned] of [
      [invalid, bad],
      [ended, late],
    ] as const) {
      expect(decodeReply(run, request, f.replies.get(request.requestId)!)).toMatchObject({
        kind: 'refused',
        reason: 'unavailable',
      });
      expect(owned.endpoint.closeMain).toHaveBeenCalledOnce();
      expect(owned.endpoint.join).toHaveBeenCalledOnce();
      expect(f.offer(request)).toBe(false);
    }
    await expect(f.broker.close()).resolves.toBe('closed');
    expect(f.replies.size).toBe(0);
  });

  it.each(['cancel', 'expiry'] as const)(
    'fences a pending pre-authentication terminal on %s without losing the owned join',
    async (loss) => {
      const peer = endpoint(85);
      const paused = deferred<void>();
      const f = fixture(async () => peer.endpoint);
      f.publish.mockImplementation(async (request, bytes, signal) => {
        if (decodeReply(run, request, bytes)?.kind === 'refused') await paused.promise;
        if (!signal.aborted) f.replies.set(request.requestId, bytes);
      });
      const request = acquire(10, 55, 150);
      f.offer(request);
      f.broker.sweep(1);
      await flush();
      peer.scope.resolve();
      await flush();
      expect(f.publish).toHaveBeenCalledTimes(2);
      if (loss === 'expiry') f.advance(150);
      else expect(f.offer({ ...request, kind: 'cancel' })).toBe(true);
      expect(peer.endpoint.closeMain).toHaveBeenCalledOnce();
      paused.resolve();
      await expect(f.broker.close()).resolves.toBe('closed');
      expect(peer.endpoint.join).toHaveBeenCalledExactlyOnceWith(loss === 'expiry' ? 200 : 150);
      expect(f.replies.size).toBe(0);
    }
  );

  it('reports an authenticated refusal without exposing private backend details', async () => {
    const f = fixture(async () => {
      throw new Error('private-provider-secret');
    });
    const request = acquire(10);
    f.offer(request);
    f.broker.sweep(1);
    await flush();
    const bytes = f.replies.get(request.requestId)!;
    expect(decodeReply(run, request, bytes)).toMatchObject({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(Buffer.from(bytes).toString()).not.toContain('private-provider-secret');
    await expect(f.broker.close()).resolves.toBe('closed');
    expect(f.replies.size).toBe(0);
  });

  it('keeps construction and empty or rejected sweeps inert', async () => {
    const f = fixture(async () => endpoint(10).endpoint);
    expect(f.broker.offer(encodeMetadata({ ...run, generation: id(88) }, acquire(10)))).toBe(false);
    expect(f.broker.sweep(5)).toBe(0);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    await expect(f.broker.close()).resolves.toBe('closed');
  });
});
