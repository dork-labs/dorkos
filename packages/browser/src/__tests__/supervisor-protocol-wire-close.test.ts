import {
  releaseOriginalWireRetirement,
  acceptsOriginalWireRetirementCandidate,
} from '../runtime/identity/supervisor-protocol-wire.js';
import { classifyOriginalWireRetirement } from '../runtime/identity/supervisor-wire-retirement.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createSupervisorProtocolWire } from '../runtime/identity/supervisor-protocol-wire.js';
import { captureOriginalSupervisorCloseDiagnostic } from '../lifecycle/supervisor-close-diagnostic.js';

/** Real loopback upgrade and original Node WebSocket; no native-browser evidence. */
async function originalWire(mode: 'clean' | 'abrupt' | 'abrupt-no-ack') {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const returns: Promise<void>[] = [];
  const rows: string[] = [];
  const sink = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    rows.push(String(value));
    return true;
  });
  const owned: { wire?: ReturnType<typeof createSupervisorProtocolWire> } = {};
  let expected: { value: unknown } | undefined;
  let first: { value: unknown } | undefined;
  let closing: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const finalize = () =>
    (finishing ??= (async () => {
      try {
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch (value) {
            fail(value);
          }
        }
        if (owned.wire) {
          try {
            closing ??= owned.wire.close();
            await closing;
          } catch (value) {
            if (!expected || !Object.is(value, expected.value)) fail(value);
          }
        }
        const returned = await Promise.allSettled(returns);
        for (const result of returned) if (result.status === 'rejected') fail(result.reason);
        if (server.listening) {
          try {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) reject(error);
                else resolve();
              });
            });
          } catch (value) {
            fail(value);
          }
        }
      } finally {
        try {
          sink.mockRestore();
        } catch (value) {
          fail(value);
        }
      }
      if (first) throw first.value;
    })());
  onTestFinished(async () => {
    await finalize();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    returns.push(
      new Promise<void>((resolve) =>
        socket.once('close', () => {
          sockets.delete(socket);
          resolve();
        })
      )
    );
    socket.on('error', fail);
  });
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      fail(new Error('missing original upgrade key'));
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n'
    );
    let bank = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      try {
        bank = Buffer.concat([bank, chunk]);
        if (bank.length > 65536) throw new Error('fixture input overflow');
        while (bank.length >= 2) {
          const opcode = bank[0]! & 15,
            size = bank[1]! & 127;
          if (!(bank[1]! & 128) || size >= 126) throw new Error('unexpected original frame');
          if (bank.length < 6 + size) return;
          const payload = Buffer.alloc(size);
          for (let index = 0; index < size; index++)
            payload[index] = bank[6 + index]! ^ bank[2 + (index % 4)]!;
          bank = bank.subarray(6 + size);
          if (opcode === 8) {
            socket.end();
            return;
          }
          if (opcode !== 1) throw new Error('unexpected opcode');
          const command = JSON.parse(payload.toString());
          expect(command).toEqual({ id: 1, method: 'Browser.close', params: {} });
          if (mode === 'abrupt-no-ack') {
            socket.end();
            return;
          }
          const response = Buffer.from(JSON.stringify({ id: 1, result: {} }));
          socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response]));
          if (mode === 'abrupt') socket.end();
          else socket.write(Buffer.from([0x88, 2, 3, 232]));
        }
      } catch (value) {
        fail(value);
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing original address');
  const wire = createSupervisorProtocolWire(
    `ws://127.0.0.1:${address.port}/devtools/browser/00000000-0000-0000-0000-000000000000`
  );
  owned.wire = wire;
  wire.transport.onmessage = () => {
    acknowledge();
  };
  await wire.open();
  const original = wire;
  return {
    wire: original,
    rows,
    acknowledged,
    finalize,
    stop() {
      original.enterOriginalPeerClose();
      original.transport.send({ id: 1, method: 'Browser.close', params: {} });
    },
    close() {
      return (closing ??= original.close());
    },
    expectFailure(value: unknown) {
      expected = { value };
    },
    faultSink(value: unknown) {
      sink.mockImplementation(() => {
        throw value;
      });
    },
    reenterSink() {
      sink.mockImplementation((value) => {
        rows.push(String(value));
        void original.close().catch(() => {});
        return true;
      });
    },
  };
}

it('retains real post-open abrupt socket error and classifies its original cooperative-close origin', async () => {
  const original = await originalWire('abrupt');
  let callbackReturned = false;
  original.wire.transport.onclose = () => {
    original.wire.transport.onmessage = undefined;
    original.wire.transport.onclose = undefined;
    callbackReturned = true;
  };
  original.stop();
  await original.acknowledged;
  await original.wire.closedOriginal;
  let cause: unknown;
  try {
    await original.close();
  } catch (value) {
    cause = value;
    original.expectFailure(value);
  }
  expect(cause).toBeInstanceOf(Error);
  if (!(cause instanceof Error)) throw new Error('missing original socket failure');
  expect(cause.message).toBe('CHROME_FIXTURE_WIRE_OPEN_FAILED');
  expect(callbackReturned).toBe(true);
  const raw = original.rows.join('');
  expect(raw).toContain('WIRE_SOCKET_ERROR_COOPERATIVE');
  expect(raw).toContain('SUPERVISOR_CLOSE: CHROME_FIXTURE_WIRE_OPEN_FAILED');
  const projected: string[] = [];
  const projection = captureOriginalSupervisorCloseDiagnostic({ diagnostics: () => raw }, (value) =>
    projected.push(value)
  );
  projection();
  const report = JSON.parse(
    projected[0]!.slice('Browser original supervisor close diagnostic '.length)
  );
  expect(report).toEqual({
    state: 'observed',
    rows: [
      { source: 'uncertainty', code: 'WIRE_SOCKET_ERROR_COOPERATIVE' },
      { source: 'close', code: 'CHROME_FIXTURE_WIRE_OPEN_FAILED' },
    ],
  });
  await original.finalize();
});

it('returns genuine clean WebSocket handshake without diagnostic or failed primary', async () => {
  const original = await originalWire('clean');
  original.stop();
  await original.acknowledged;
  await original.wire.closedOriginal;
  await original.close();
  expect(original.rows).toEqual([]);
  await original.finalize();
});

it.each([false, undefined])(
  'preserves original onclose callback failure %s after genuine clean socket return',
  async (value) => {
    const original = await originalWire('clean');
    original.wire.transport.onclose = () => {
      throw value;
    };
    original.stop();
    await original.acknowledged;
    await original.wire.closedOriginal;
    original.expectFailure(value);
    await expect(original.close()).rejects.toBe(value);
    expect(original.rows.join('')).toContain('WIRE_CLOSE_CALLBACK');
    expect(original.rows.join('')).toContain('SUPERVISOR_CLOSE: unknown');
    expect(original.wire.isKnown()).toBe(false);
    await original.finalize();
  }
);

it.each([false, undefined])(
  'isolates optional diagnostic sink failure %s from the original socket primary',
  async (value) => {
    const original = await originalWire('abrupt');
    original.faultSink(value);
    original.stop();
    await original.acknowledged;
    await original.wire.closedOriginal;
    let first: unknown;
    try {
      await original.close();
    } catch (cause) {
      first = cause;
      original.expectFailure(cause);
    }
    expect(first).toBeInstanceOf(Error);
    if (!(first instanceof Error)) throw new Error('missing original socket failure');
    expect(first.message).toBe('CHROME_FIXTURE_WIRE_OPEN_FAILED');
    await expect(original.close()).rejects.toBe(first);
    await original.finalize();
  }
);

it('retains one failed close and one emission when the optional sink reenters original close', async () => {
  const original = await originalWire('abrupt');
  original.reenterSink();
  original.stop();
  await original.acknowledged;
  await original.wire.closedOriginal;
  let first: unknown;
  try {
    await original.close();
  } catch (cause) {
    first = cause;
    original.expectFailure(cause);
  }
  await expect(original.close()).rejects.toBe(first);
  expect(original.rows).toHaveLength(1);
  expect(original.rows[0]).toContain('WIRE_SOCKET_ERROR_COOPERATIVE');
  await original.finalize();
});

it('refuses a previously observed retirement candidate after a new original send refuses admission', async () => {
  const original = await originalWire('abrupt');
  original.stop();
  await original.acknowledged;
  await original.wire.closedOriginal;
  let primary: unknown;
  try {
    await original.close();
  } catch (value) {
    primary = value;
    original.expectFailure(value);
  }
  const prior = original.wire.readOriginalCloseOutcome();
  expect(prior?.kind).toBe('cooperative-socket-terminal');
  let sent: unknown;
  try {
    original.wire.transport.send({ id: 2, method: 'Browser.getVersion', params: {} });
  } catch (value) {
    sent = value;
  }
  expect(sent).toBe(primary);
  expect(original.wire.readOriginalCloseOutcome()?.kind).toBe('failed');
  expect(prior?.kind).toBe('cooperative-socket-terminal'); // Prior immutable observation was not mutated.
  expect(releaseOriginalWireRetirement(original.wire, primary)).toBe(false);
  await expect(original.close()).rejects.toBe(primary);
  await original.finalize();
});

it('classifies only an original cooperative socket terminal with all original retirement facts known', async () => {
  const original = await originalWire('abrupt');
  original.stop();
  await original.acknowledged;
  await original.wire.closedOriginal;
  let primary: unknown;
  try {
    await original.close();
  } catch (value) {
    primary = value;
    original.expectFailure(value);
  }
  // Controlled native-producer facts exercise classification guards, never native ownership proof.
  const root = Object.freeze({ pid: 17, birth: 'controlled-birth' });
  const facts = {
    wire: original.wire,
    result: { status: 'rejected' as const, reason: primary },
    originalBrowserStop: (await Promise.allSettled([original.acknowledged]))[0]!,
    originalReturnedAccepted: true,
    otherOriginalsKnown: true,
    root,
    tree: { status: 'complete' as const, identities: [root] },
    statuses: [{ status: 'dead' as const }],
  };
  expect(classifyOriginalWireRetirement(facts)).toBe(true);
  expect(classifyOriginalWireRetirement({ ...facts, originalReturnedAccepted: false })).toBe(false);
  expect(classifyOriginalWireRetirement({ ...facts, otherOriginalsKnown: false })).toBe(false);
  for (const reason of [false, undefined])
    expect(
      classifyOriginalWireRetirement({
        ...facts,
        originalBrowserStop: { status: 'rejected', reason },
      })
    ).toBe(false);
  expect(
    classifyOriginalWireRetirement({ ...facts, tree: { status: 'unknown', identities: [root] } })
  ).toBe(false);
  expect(
    classifyOriginalWireRetirement({ ...facts, tree: { status: 'complete', identities: [] } })
  ).toBe(false);
  expect(
    classifyOriginalWireRetirement({
      ...facts,
      tree: { status: 'complete', identities: [{ pid: root.pid, birth: 'other' }] },
    })
  ).toBe(false);
  for (const status of ['unknown', 'alive'] as const)
    expect(classifyOriginalWireRetirement({ ...facts, statuses: [{ status }] })).toBe(false);
  expect(classifyOriginalWireRetirement({ ...facts, statuses: [] })).toBe(false);
  expect(
    classifyOriginalWireRetirement({ ...facts, statuses: [{ status: 'dead' }, { status: 'dead' }] })
  ).toBe(false);
  const lookalike = {
    ...original.wire,
    readOriginalCloseOutcome: vi.fn(() => original.wire.readOriginalCloseOutcome()),
  };
  expect(classifyOriginalWireRetirement({ ...facts, wire: lookalike })).toBe(false);
  expect(lookalike.readOriginalCloseOutcome).not.toHaveBeenCalled();
  expect(
    classifyOriginalWireRetirement({ ...facts, result: { status: 'rejected', reason: undefined } })
  ).toBe(false);
  await expect(original.close()).rejects.toBe(primary);
  expect(original.wire.isKnown()).toBe(false);
  await original.finalize();
});

it.each([false, undefined])(
  'refuses cooperative settlement when a later original SDK callback throws %s',
  async (value) => {
    const original = await originalWire('abrupt');
    original.wire.transport.onclose = () => {
      throw value;
    };
    original.stop();
    await original.acknowledged;
    await original.wire.closedOriginal;
    let primary: unknown;
    try {
      await original.close();
    } catch (cause) {
      primary = cause;
      original.expectFailure(cause);
    }
    expect(primary).toBeInstanceOf(Error);
    expect(original.wire.readOriginalCloseOutcome()?.kind).toBe('failed');
    await expect(original.close()).rejects.toBe(primary);
    await original.finalize();
  }
);

it('does not qualify a real FIN without the original Browser.close response', async () => {
  const original = await originalWire('abrupt-no-ack');
  const originalBrowserClose = Promise.race([
    original.acknowledged,
    original.wire.closedOriginal.then(() => {
      throw new Error('original close response absent');
    }),
  ]);
  void originalBrowserClose.catch(() => {});
  original.stop();
  await original.wire.closedOriginal;
  const browserStop = (await Promise.allSettled([originalBrowserClose]))[0]!;
  let primary: unknown;
  try {
    await original.close();
  } catch (value) {
    primary = value;
    original.expectFailure(value);
  }
  const root = Object.freeze({ pid: 17, birth: 'controlled-birth' });
  expect(browserStop.status).toBe('rejected');
  expect(
    classifyOriginalWireRetirement({
      wire: original.wire,
      result: { status: 'rejected', reason: primary },
      originalBrowserStop: browserStop,
      originalReturnedAccepted: true,
      otherOriginalsKnown: true,
      root,
      tree: { status: 'complete', identities: [root] },
      statuses: [{ status: 'dead' }],
    })
  ).toBe(false);
  await original.finalize();
});

it('rejects another genuine wire original reason and releases only one exact qualified retired owner', async () => {
  const one = await originalWire('abrupt');
  one.stop();
  await one.acknowledged;
  await one.wire.closedOriginal;
  let first: unknown;
  try {
    await one.close();
  } catch (value) {
    first = value;
    one.expectFailure(value);
  }
  await one.finalize();
  const two = await originalWire('abrupt');
  two.stop();
  await two.acknowledged;
  await two.wire.closedOriginal;
  let second: unknown;
  try {
    await two.close();
  } catch (value) {
    second = value;
    two.expectFailure(value);
  }
  expect(acceptsOriginalWireRetirementCandidate(one.wire, second)).toBe(false);
  expect(acceptsOriginalWireRetirementCandidate(two.wire, first)).toBe(false);
  expect(releaseOriginalWireRetirement(one.wire, second)).toBe(false);
  // Controlled final commit only tests private owner release; this is not native proof.
  expect(releaseOriginalWireRetirement(one.wire, first)).toBe(true);
  expect(releaseOriginalWireRetirement(one.wire, first)).toBe(false);
  await expect(one.close()).rejects.toBe(first);
  expect(one.wire.isKnown()).toBe(false);
  await two.finalize();
});
