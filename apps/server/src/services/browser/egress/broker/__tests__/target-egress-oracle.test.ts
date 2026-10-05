import { BrokerError } from '../errors.js';
import { expect, it } from 'vitest';
import {
  assertTargetReport,
  ownTargetOperations,
  createTargetOrigin,
  finishTargetReceipt,
  isTargetAuthorityRefusal,
  writeTargetReceipt,
} from './target-egress-fixture.js';
import { get } from 'node:http';
import { once } from 'node:events';

it('refuses every missing target acknowledgement and malformed reports', () => {
  const positive = { dedicated: true, shared: true, service: true, cache: true, websocket: true };
  expect(() => assertTargetReport(positive)).not.toThrow();
  for (const key of Object.keys(positive))
    expect(() => assertTargetReport({ ...positive, [key]: false })).toThrow(
      'TARGET_MATRIX_INCOMPLETE'
    );
  expect(() => assertTargetReport({ ...positive, extra: true })).toThrow();
});
it('retains a timed out raw original even after its actual late settlement', async () => {
  const owner = ownTargetOperations();
  let release!: () => void;
  await expect(
    owner.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      5
    )
  ).rejects.toThrow('TARGET_DUTY_EXPIRED');
  expect(owner.finish()).toEqual({ observed: false, pending: 1, failed: true });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(owner.finish()).toEqual({ observed: false, pending: 0, failed: true });
});
it('charges eight original slots before entry and frees only actual returned slots', async () => {
  const owner = ownTargetOperations();
  const releases: Array<() => void> = [];
  const originals = Array.from({ length: 8 }, () =>
    owner.run(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    )
  );
  await expect(owner.run(async () => {})).rejects.toThrow('TARGET_DUTY_CAPACITY');
  await new Promise((resolve) => setImmediate(resolve));
  releases.forEach((release) => release());
  await Promise.all(originals);
  await owner.run(async () => {});
  expect(owner.finish().observed).toBe(true);
});
it('the exact counter endpoint observes direct bypass instead of passing a dead oracle', async () => {
  const origin = createTargetOrigin('http://127.0.0.1:1/denied');
  const ready = once(origin.server, 'listening');
  origin.server.listen(0, '127.0.0.1');
  await ready;
  try {
    const address = origin.server.address();
    if (!address || typeof address === 'string') throw Error('UNKNOWN');
    await new Promise<void>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${address.port}/denied`, (response) => {
        response.resume();
        response.once('end', resolve);
      });
      request.once('error', reject);
    });
    expect(origin.snapshot().counts['/denied']).toBe(1);
    expect(origin.snapshot().connections).toBe(1);
  } finally {
    await origin.close();
  }
});

it('owns the actual named home during late canonicalization before the caller can receive it', async () => {
  const { ownTargetHome } = await import('./target-egress-fixture.js');
  const { realpath, lstat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const home = ownTargetHome(join(tmpdir(), 'target-home-control-'), async (named) => {
    await barrier;
    return realpath(named);
  });
  const original = home.acquire();
  try {
    await expect.poll(() => home.snapshot().named).toBeTruthy();
    const snapshot = home.snapshot();
    expect(snapshot.canonical).toBeUndefined();
    expect(snapshot.settled).toBe(false);
    expect((await lstat(snapshot.named!)).isDirectory()).toBe(true);
    expect(await home.removeIfObserved(false)).toBe(false);
  } finally {
    release();
    await original;
    expect(await home.removeIfObserved(true)).toBe(true);
  }
});

it('admits exactly 64 original sockets and stops all effects on the 65th real delivery', async () => {
  const { Socket } = await import('node:net');
  const origin = createTargetOrigin('http://127.0.0.1:1/denied');
  const originals: InstanceType<typeof Socket>[] = [];
  const closes: Promise<void>[] = [];
  const ready = once(origin.server, 'listening');
  origin.server.listen(0, '127.0.0.1');
  await ready;
  try {
    const address = origin.server.address();
    if (!address || typeof address === 'string') throw Error('UNKNOWN');
    for (let index = 0; index < 65; index++) {
      const original = new Socket();
      originals.push(original);
      closes.push(new Promise<void>((resolve) => original.once('close', resolve)));
      original.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        original.once('connect', resolve);
        original.once('error', reject);
        original.connect(address.port, '127.0.0.1');
      });
      if (index === 63) {
        await expect.poll(() => origin.snapshot().connections).toBe(64);
        expect(origin.server.listening).toBe(true);
        expect(originals.every((value) => !value.destroyed)).toBe(true);
        expect(origin.snapshot().overflow).toBe(false);
      }
    }
    await expect.poll(() => origin.snapshot().overflow).toBe(true);
    await Promise.all(closes);
    expect(origin.snapshot().admitted).toBe(0);
    expect(origin.server.listening).toBe(false);
    expect(origin.snapshot().counts).toEqual({});
  } finally {
    for (const original of originals) original.destroy();
    await Promise.all(closes);
    if (origin.snapshot().overflow)
      await expect(origin.close()).rejects.toThrow('TARGET_ORIGIN_REFUSED');
    else await origin.close();
  }
});

it('the actual transport barrier drains admitted original traffic before the counter cutoff', async () => {
  const { Socket } = await import('node:net');
  const origin = createTargetOrigin('http://127.0.0.1:1/denied');
  const original = new Socket();
  const closed = new Promise<void>((resolve) => original.once('close', resolve));
  original.on('error', () => {});
  original.on('data', () => {});
  const ready = once(origin.server, 'listening');
  origin.server.listen(0, '127.0.0.1');
  await ready;
  try {
    const address = origin.server.address();
    if (!address || typeof address === 'string') throw Error('UNKNOWN');
    await new Promise<void>((resolve, reject) => {
      original.once('connect', resolve);
      original.once('error', reject);
      original.connect(address.port, '127.0.0.1');
    });
    await expect.poll(() => origin.snapshot().admitted).toBe(1);
    const before = origin.snapshot();
    let returned = false;
    const barrier = origin.transportBarrier().then(() => {
      returned = true;
    });
    original.write(
      `GET /after HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`
    );
    await barrier;
    await closed;
    expect(returned).toBe(true);
    const cutoff = origin.snapshot();
    expect(before.counts['/after']).toBeUndefined();
    expect(cutoff.counts['/after']).toBe(1);
    expect(cutoff.admitted).toBe(0);
    expect(origin.snapshot()).toEqual(cutoff);
  } finally {
    original.destroy();
    await closed;
    await origin.close();
  }
});

it('actual WebSocket open/echo settles and original close rejects a pending echo', async () => {
  const { WebSocket } = await import('ws');
  const { waitTargetSocketEvent } = await import('./target-egress-fixture.js');
  const origin = createTargetOrigin('http://127.0.0.1:1/denied');
  const ready = once(origin.server, 'listening');
  origin.server.listen(0, '127.0.0.1');
  await ready;
  const address = origin.server.address();
  if (!address || typeof address === 'string') throw Error('UNKNOWN');
  const original = new WebSocket(`ws://127.0.0.1:${address.port}/socket`);
  const closed = once(original, 'close');
  try {
    await waitTargetSocketEvent(original, 'open');
    const echo = waitTargetSocketEvent(original, 'message');
    const rawEcho = once(original, 'message');
    original.send('BOUND');
    expect(Reflect.get((await echo) as object, 'data')).toBe('BOUND');
    const [raw, isBinary] = await rawEcho;
    expect(raw.toString()).toBe('BOUND');
    expect(isBinary).toBe(false);
    expect(origin.snapshot().upgrades).toBe(1);
    expect(origin.snapshot().websocketConnections).toBe(1);
    const pending = waitTargetSocketEvent(original, 'message');
    const refusal = expect(pending).rejects.toThrow('TARGET_WEBSOCKET_FAILED');
    original.close();
    await refusal;
    await closed;
  } finally {
    if (original.readyState !== WebSocket.CLOSED) original.close();
    await closed;
    await origin.close();
  }
});

it('actual refused WebSocket opening rejects rather than leaving the reporter pending', async () => {
  const { WebSocket } = await import('ws');
  const { waitTargetSocketEvent } = await import('./target-egress-fixture.js');
  const { createServer } = await import('node:http');
  const server = createServer();
  server.on('upgrade', (_request, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  );
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('UNKNOWN');
  const original = new WebSocket(`ws://127.0.0.1:${address.port}/socket`);
  const closed = new Promise<void>((resolve) => original.once('close', resolve));
  try {
    await expect(waitTargetSocketEvent(original, 'open')).rejects.toThrow(
      'TARGET_WEBSOCKET_FAILED'
    );
    await closed;
  } finally {
    if (original.readyState !== WebSocket.CLOSED) original.close();
    await closed;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

it.each([undefined, null, false, 0, ''])(
  'preserves present falsy cleanup failure %s when actual receipt output refuses',
  (primary) => {
    let caught = false;
    let observed: unknown;
    let attempted = false;
    try {
      finishTargetReceipt(
        { present: true, value: primary },
        () => ({ observed: false }),
        () => {
          attempted = true;
          throw Error('OUTPUT_REFUSED');
        }
      );
    } catch (error) {
      caught = true;
      observed = error;
    }
    expect(attempted).toBe(true);
    expect(caught).toBe(true);
    expect(observed).toBe(primary);
  }
);
it('refuses receipt output or capacity failure when no earlier failure is present', () => {
  const refused = Error('OUTPUT_REFUSED');
  expect(() =>
    finishTargetReceipt(
      { present: false, value: undefined },
      () => ({}),
      () => {
        throw refused;
      }
    )
  ).toThrow(refused);
  expect(() =>
    finishTargetReceipt({ present: false, value: undefined }, () => ({ scalar: 'x'.repeat(4096) }))
  ).toThrow('TARGET_RECEIPT_CAP');
});
it('preserves original cleanup failure when receipt construction throws undefined', () => {
  const primary = Error('ORIGINAL_CLEANUP');
  expect(() =>
    finishTargetReceipt({ present: true, value: primary }, () => {
      throw undefined;
    })
  ).toThrow(primary);
});

it('matches genuine typed authority refusal while rejecting message/DTO/wrong-code counterfeits', () => {
  const original = new BrokerError('AUTHORITY_REFUSED');
  expect(original.message).not.toBe('AUTHORITY_REFUSED'); // Previous native oracle was RED.
  expect(isTargetAuthorityRefusal(original)).toBe(true);
  expect(isTargetAuthorityRefusal(new Error('AUTHORITY_REFUSED'))).toBe(false);
  expect(isTargetAuthorityRefusal({ code: 'AUTHORITY_REFUSED' })).toBe(false);
  expect(isTargetAuthorityRefusal(new BrokerError('CLOSED'))).toBe(false);
});
it('does not execute a counterfeit code getter or trust altered genuine error accessors', () => {
  let calls = 0;
  const counterfeit = {
    get code() {
      calls++;
      return 'AUTHORITY_REFUSED';
    },
  };
  expect(isTargetAuthorityRefusal(counterfeit)).toBe(false);
  const altered = new BrokerError('AUTHORITY_REFUSED');
  Object.defineProperty(altered, 'code', {
    get() {
      calls++;
      return 'AUTHORITY_REFUSED';
    },
  });
  expect(isTargetAuthorityRefusal(altered)).toBe(false);
  expect(calls).toBe(0);
});

it('writes an actual bounded receipt and refuses the exact already-closed output descriptor', async () => {
  const { mkdtempSync, openSync, closeSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'target-output-control-'));
  const path = join(root, 'receipt.raw');
  const original = openSync(path, 'wx');
  let closed = false;
  try {
    writeTargetReceipt('{"observed":true}', original);
    expect(readFileSync(path, 'utf8')).toBe('TARGET_EGRESS_RECEIPT {"observed":true}\n');
    expect(() => writeTargetReceipt('x'.repeat(4090), original)).toThrow('TARGET_RECEIPT_CAP');
    closeSync(original);
    closed = true;
    let caught = false;
    let observed: unknown;
    try {
      finishTargetReceipt(
        { present: true, value: undefined },
        () => ({}),
        (raw) => writeTargetReceipt(raw, original)
      );
    } catch (error) {
      caught = true;
      observed = error;
    }
    expect(caught).toBe(true);
    expect(observed).toBeUndefined();
    expect(() => writeTargetReceipt('{}', original)).toThrow(); // Actual EBADF, no replay/substitute.
  } finally {
    if (!closed) closeSync(original);
    rmSync(root, { recursive: true });
  }
});
