import { Writable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Page, CDPSession } from 'playwright-core';
import { SupervisedSemanticReader } from '../native-reader.js';
import { settleSemanticOriginals, SemanticNativeWork } from '../original-close.js';
const finalizers: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(finalizers.splice(0).map((close) => close()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});
import { SemanticFrameBudget } from '../frame-budget.js';
import { SemanticByteChannel, semanticRecord } from '../byte-channel.js';
function frame(length: number, first = 0x81) {
  return Uint8Array.from([
    first,
    127,
    0,
    0,
    0,
    0,
    (length >>> 24) & 255,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
  ]);
}
it('refuses the original oversized WebSocket length before any payload arrives', () => {
  const gate = new SemanticFrameBudget(false);
  expect(() => gate.admit(frame(1048577))).toThrow('SEMANTIC_WIRE_EXCEEDED');
  expect(() => gate.admit(new Uint8Array())).toThrow('SEMANTIC_WIRE_CLOSED');
});
it('charges actual continuation frames to the same message and refuses aggregation escape', () => {
  const gate = new SemanticFrameBudget(false);
  gate.admit(frame(600000, 0x01));
  gate.admit(new Uint8Array(600000));
  expect(() => gate.admit(frame(600000, 0x80))).toThrow('SEMANTIC_WIRE_EXCEEDED');
});
it('refuses compressed, unknown opcode, mask mismatch and noncanonical lengths', () => {
  for (const bytes of [
    Uint8Array.of(0xc1, 0),
    Uint8Array.of(0x83, 0),
    Uint8Array.of(0x81, 0x80, 0, 0, 0, 0),
    Uint8Array.of(0x81, 126, 0, 2),
  ])
    expect(() => new SemanticFrameBudget(false).admit(bytes)).toThrow();
});
it('admits genuine split headers/payload and interleaved bounded control frames', () => {
  const gate = new SemanticFrameBudget(false);
  gate.admit(Uint8Array.of(0x01));
  gate.admit(Uint8Array.of(2, 123));
  gate.admit(Uint8Array.of(125));
  gate.admit(Uint8Array.of(0x89, 0));
  gate.admit(Uint8Array.of(0x80, 0));
  expect(() => gate.finish()).not.toThrow();
});
it('cannot qualify EOF with a held original payload or fragmented message', () => {
  const payload = new SemanticFrameBudget(false);
  payload.admit(Uint8Array.of(0x81, 2, 123));
  expect(() => payload.finish()).toThrow('SEMANTIC_WIRE_INCOMPLETE');
  const fragmented = new SemanticFrameBudget(false);
  fragmented.admit(Uint8Array.of(0x01, 0));
  expect(() => fragmented.finish()).toThrow('SEMANTIC_WIRE_INCOMPLETE');
});
it('checks pipe length before payload allocation or original effect entry', () => {
  const channel = new SemanticByteChannel();
  let effects = 0;
  expect(() =>
    channel.receive(Uint8Array.of(0, 4, 16, 1), () => {
      effects++;
    })
  ).toThrow('SEMANTIC_PIPE_EXCEEDED');
  expect(effects).toBe(0);
});
it('retains partial actual record until natural complete bytes and accepts exactly one original effect', () => {
  const channel = new SemanticByteChannel(),
    record = semanticRecord({ kind: 'ready' });
  const rows: unknown[] = [];
  channel.receive(record.subarray(0, 5), (value) => rows.push(value));
  expect(rows).toEqual([]);
  channel.receive(record.subarray(5), (value) => rows.push(value));
  expect(rows).toEqual([{ kind: 'ready' }]);
  expect(() => channel.finish()).not.toThrow();
});
it('refuses invalid UTF-8 and preserves original effect falsy failure without a second publication', () => {
  const invalid = new SemanticByteChannel();
  expect(() => invalid.receive(Uint8Array.of(0, 0, 0, 1, 255), () => {})).toThrow();
  const channel = new SemanticByteChannel();
  let first: { reason: unknown } | undefined;
  try {
    channel.receive(semanticRecord({ kind: 'ready' }), () => {
      throw undefined;
    });
  } catch (reason) {
    first = { reason };
  }
  expect(first).toEqual({ reason: undefined });
  expect(() => channel.receive(semanticRecord({ kind: 'ready' }), () => {})).toThrow(
    'SEMANTIC_PIPE_CLOSED'
  );
});

// Portable genuine reader + original protocol receivers; no native Chrome acceptance.
it('enters original private connection close before joining the held reader/native command', async () => {
  const bank: { reader?: SupervisedSemanticReader; read?: Promise<unknown> } = {};
  const events = new EventEmitter();
  const reason = new Error('ORIGINAL_SEMANTIC_CONNECTION_CLOSED');
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<never>((_resolve, reject) => {
    release = () => reject(reason);
  });
  void held.catch(() => {});
  let finished: Promise<void> | undefined;
  finalizers.push(
    () =>
      (finished ??= (async () => {
        release();
        await bank.read?.catch((error: unknown) => {
          if (!Object.is(error, reason)) throw error;
        });
        await bank.reader?.close().catch((error: unknown) => {
          if (!Object.is(error, reason)) throw error;
        });
      })())
  );
  let nativeReturned = false,
    disconnected = false;
  const session = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    detach: async () => {},
    send: async (method: string) => {
      if (method === 'Page.getFrameTree') {
        entered();
        try {
          await held;
        } finally {
          nativeReturned = true;
        }
      }
      throw reason;
    },
  } as unknown as CDPSession;
  const main = {};
  const page = {
    context: () => ({ newCDPSession: async () => session }),
    on: events.on.bind(events),
    off: events.off.bind(events),
    isClosed: () => false,
    frames: () => [main],
    mainFrame: () => main,
  } as unknown as Page;
  bank.reader = new SupervisedSemanticReader(page);
  bank.read = bank.reader.read(
    {
      version: 1,
      browserId: 'AAAAAAAAAAAAAAAAAAAAAA',
      browserGeneration: 1,
      tabId: 'BBBBBBBBBBBBBBBBBBBBBB',
      navigationGeneration: 0,
      viewportVersion: 0,
      treeId: 'CCCCCCCCCCCCCCCCCCCCCC',
      treeRevision: 0,
      epoch: 0,
      inputGeneration: 0,
      grantRevision: 1,
    },
    'DDDDDDDDDDDDDDDDDDDDDD',
    'EEEEEEEEEEEEEEEEEEEEEE'
  );
  void bank.read.catch(() => {});
  await entering;
  const closing = settleSemanticOriginals(
    true,
    bank.read,
    [],
    async () => {},
    () => bank.reader!.close(),
    async () => {
      expect(nativeReturned).toBe(false);
      disconnected = true;
      release();
    }
  );
  const results = await closing;
  expect(disconnected).toBe(true);
  expect(nativeReturned).toBe(true);
  expect(
    results.some((result) => result.status === 'rejected' && Object.is(result.reason, reason))
  ).toBe(true);
});

it('keeps completed native work idle while delivered result bytes retain their original pipe callback', async () => {
  const bank: {
    originalWrite?: Promise<void>;
    closing?: Promise<readonly PromiseSettledResult<unknown>[]>;
  } = {};
  const native = new SemanticNativeWork();
  const framed = semanticRecord({ kind: 'result', sequence: 1, result: true });
  const rows: string[] = [];
  let delivered = Buffer.alloc(0),
    release: (() => void) | undefined;
  let finished: Promise<void> | undefined;
  const pipe = new Writable({
    write(bytes: Buffer, _encoding, callback) {
      delivered = Buffer.from(bytes);
      release = () => {
        release = undefined; // Consume the retained original callback before reentrant cleanup can enter.
        callback();
      };
    },
  });
  finalizers.push(
    () =>
      (finished ??= Promise.resolve().then(async () => {
        release?.();
        await Promise.allSettled([
          ...(bank.originalWrite ? [bank.originalWrite] : []),
          ...(bank.closing ? [bank.closing] : []),
        ]);
        pipe.destroy();
      }))
  );
  // Explicit portable original native receiver double, not an accepted native AX result.
  await native.run(async () => {
    rows.push('native-return');
  });
  expect(native.pending()).toBe(false);
  bank.originalWrite = new Promise<void>((resolve, reject) => {
    pipe.write(framed, (reason) => (reason ? reject(reason) : resolve()));
  });
  expect(delivered).toEqual(Buffer.from(framed));
  bank.closing = settleSemanticOriginals(
    native.pending(),
    bank.originalWrite,
    [bank.originalWrite],
    async () => {
      rows.push('metadata-cleanup');
    },
    async () => {
      rows.push('reader-cleanup');
      expect(rows).not.toContain('connection-close');
    },
    async () => {
      rows.push('connection-close');
    }
  );
  await Promise.resolve();
  expect(rows).toEqual(['native-return']);
  release?.();
  expect(release).toBeUndefined();
  expect((await bank.closing).every((result) => result.status === 'fulfilled')).toBe(true);
  expect(rows).toEqual(['native-return', 'metadata-cleanup', 'reader-cleanup', 'connection-close']);
});
