import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import {
  lifetimeWorkerScripts,
  LifetimeWorkerObservationSchema,
  lifetimeServiceRequest,
} from './lifetime-worker-scripts.js';
import { ownLifetimeHttps, ownLifetimeOperations } from './lifetime-fixture-custody.js';

it('actual generated shared worker waits its original gate before the post-detach request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [],
    messages: unknown[] = [];
  const context: { onconnect?: (event: unknown) => void } = {};
  const port: {
    onmessage?: (event: unknown) => Promise<void>;
    postMessage: (value: unknown) => void;
    start: () => void;
    close: () => void;
  } = { postMessage: (value) => messages.push(value), start: () => {}, close: () => {} };
  runInNewContext(lifetimeWorkerScripts(1).shared, {
    self: context,
    crypto: { randomUUID },
    navigator: { userAgent: 'native-control', appVersion: 'control', platform: 'control' },
    fetch: async (url: string) => {
      calls.push(url);
      return {
        text: async () => {
          if (url.startsWith('/gate')) await gate;
        },
      };
    },
  });
  context.onconnect!({ ports: [port] });
  const original = port.onmessage!({ data: 'arm' });
  expect(messages).toHaveLength(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('/gate?kind=shared');
  release();
  await original;
  expect(calls[1]).toContain('/after-detach?kind=shared');
});

it('actual service worker registers its original waitUntil job and preserves worker identity after gate release', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers = new Map<string, (event: unknown) => void>(),
    calls: string[] = [],
    messages: unknown[] = [];
  let held: Promise<unknown> | undefined;
  runInNewContext(lifetimeWorkerScripts(2).service, {
    self: {
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      isSecureContext: true,
    },
    crypto: { randomUUID },
    navigator: { userAgent: 'native-control', appVersion: 'control', platform: 'control' },
    fetch: async (url: string, options?: { body?: string }) => {
      calls.push(url);
      if (options?.body) messages.push(JSON.parse(options.body));
      return {
        text: async () => {
          if (url.startsWith('/gate')) await gate;
        },
      };
    },
  });
  handlers.get('message')!({
    data: 'arm',
    ports: [{ postMessage: (value: unknown) => messages.push(value) }],
    waitUntil: (original: Promise<unknown>) => {
      held = original;
    },
  });
  expect(held).toBeDefined();
  expect(calls).toHaveLength(1);
  release();
  await held;
  const worker = LifetimeWorkerObservationSchema.parse(messages[1]);
  expect(worker).toMatchObject({
    kind: 'service',
    phase: 'after-detach',
    version: 2,
    identity: { metadata: null },
  });
  expect(calls[1]).toContain('/after-detach?kind=service');
});

it('a timed-out original remains charged and a late return cannot reopen admission', async () => {
  const owner = ownLifetimeOperations();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  await expect(
    owner.operation(async () => {
      entered++;
      await gate;
    }, 5)
  ).rejects.toThrow('LIFETIME_ORIGINAL_EXPIRED');
  expect(await owner.finish(5)).toEqual({ state: 'held', pending: 1 });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(owner.snapshot()).toEqual({ state: 'held', pending: 0 });
  expect(await owner.finish(5)).toEqual({ state: 'held', pending: 1 });
  await expect(
    owner.operation(async () => {
      entered++;
    })
  ).rejects.toThrow('LIFETIME_ADMISSION_CLOSED');
  expect(entered).toBe(1);
});

it('the original channel attempts both closes and preserves a falsy ready rejection over close failure', async () => {
  const closes: number[] = [];
  class Channel {
    port1 = {
      close() {
        closes.push(1);
        throw new Error('secondary close');
      },
    };
    port2 = {
      close() {
        closes.push(2);
      },
    };
  }
  const pending = runInNewContext(`(${lifetimeServiceRequest})('observe')`, {
    MessageChannel: Channel,
    setTimeout,
    clearTimeout,
    navigator: { serviceWorker: { ready: Promise.reject(undefined) } },
  }) as Promise<unknown>;
  let failed = false,
    primary: unknown;
  try {
    await pending;
  } catch (error) {
    failed = true;
    primary = error;
  }
  expect(failed).toBe(true);
  expect(primary).toBeUndefined();
  expect(closes).toEqual([1, 2]);
});

it('owns a real TLS-listener delivered TCP original before a request or handshake and closes it once', async () => {
  const endpoint = ownLifetimeHttps({}, (_, response) => response.end());
  const listening = once(endpoint.server, 'listening');
  endpoint.server.listen(0, '127.0.0.1');
  await listening;
  const address = endpoint.server.address();
  if (!address || typeof address === 'string') throw new Error('CONTROL_ADDRESS');
  const delivered = once(endpoint.server, 'connection');
  const client = connect(address.port, '127.0.0.1');
  client.on('error', () => {});
  await once(client, 'connect');
  await delivered;
  expect(endpoint.snapshot()).toMatchObject({ delivered: 1, sockets: 1, uncertain: false });
  const original = endpoint.close();
  expect(endpoint.close()).toBe(original);
  await original;
  expect(endpoint.snapshot()).toMatchObject({ sockets: 0, gates: 0, uncertain: false });
  client.destroy();
});

it('retains the sixty-fifth delivered TLS original before fencing listener admission', async () => {
  const endpoint = ownLifetimeHttps({}, (_, response) => response.end());
  let retainedAtCutoff = false;
  endpoint.server.on('connection', () => {
    if (endpoint.snapshot().delivered === 65)
      retainedAtCutoff = endpoint.snapshot().sockets === 1 && endpoint.snapshot().uncertain;
  });
  const listening = once(endpoint.server, 'listening');
  endpoint.server.listen(0, '127.0.0.1');
  await listening;
  const address = endpoint.server.address();
  if (!address || typeof address === 'string') throw new Error('CONTROL_ADDRESS');
  for (let index = 0; index < 65; index++) {
    const delivered = once(endpoint.server, 'connection');
    const client = connect(address.port, '127.0.0.1');
    client.on('error', () => {});
    await once(client, 'connect');
    const [original] = await delivered;
    const closed = once(original, 'close');
    client.destroy();
    await closed;
  }
  expect(retainedAtCutoff).toBe(true);
  await expect(endpoint.close()).rejects.toThrow('LIFETIME_HTTPS_CUSTODY_HELD');
  expect(endpoint.server.listening).toBe(false);
  expect(endpoint.snapshot()).toMatchObject({ sockets: 0, uncertain: true });
});

it('records exactly one real diagnostic original after admission fails without healing custody', async () => {
  const owner = ownLifetimeOperations();
  const home = await mkdtemp(join(tmpdir(), 'lifetime-evidence-control-'));
  const file = join(home, 'receipt');
  try {
    await expect(
      owner.operation(async () => {
        throw new Error('primary-native-error');
      })
    ).rejects.toThrow('primary-native-error');
    await owner.evidence(() => writeFile(file, 'retained failure', { mode: 0o600 }));
    expect(await readFile(file, 'utf8')).toBe('retained failure');
    await expect(owner.evidence(() => writeFile(file, 'replacement'))).rejects.toThrow(
      'LIFETIME_EVIDENCE_REFUSED'
    );
    expect((await owner.finish()).state).toBe('held');
  } finally {
    await rm(home, { recursive: true });
  }
});

it('finalization seals a queued original before SDK entry and shares the same finish', async () => {
  const owner = ownLifetimeOperations();
  let entered = 0;
  const original = owner.operation(async () => {
    entered++;
  });
  const finishing = owner.finish();
  expect(owner.finish()).toBe(finishing);
  await expect(original).rejects.toThrow('LIFETIME_ADMISSION_CLOSED');
  expect((await finishing).state).toBe('held');
  expect(entered).toBe(0);
});

it('a genuinely late producer return is adopted and closed once after the fixed finalizer', async () => {
  const owner = ownLifetimeOperations();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closes = 0;
  const original = owner.operation(async () => {
    const endpoint = ownLifetimeHttps({}, (_, response) => response.end());
    const listening = once(endpoint.server, 'listening');
    endpoint.server.listen(0, '127.0.0.1');
    await listening;
    await gate;
    owner.adopt(endpoint, async () => {
      closes++;
      await endpoint.close();
    });
    return endpoint;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const finishing = owner.finish(5);
  expect((await finishing).state).toBe('held');
  release();
  const endpoint = await original;
  await endpoint.close();
  expect(endpoint.server.listening).toBe(false);
  expect(closes).toBe(1);
  expect(owner.snapshot().state).toBe('held');
  await expect(owner.operation(async () => {})).rejects.toThrow('LIFETIME_ADMISSION_CLOSED');
});
