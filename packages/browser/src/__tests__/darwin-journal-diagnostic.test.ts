import { expect, it, vi } from 'vitest';
import {
  createOriginalChildBatchDiagnosticSink,
  readDarwinJournalDiagnostic,
} from '../runtime/darwin-journal-diagnostic.js';
const packet = {
  kind: 'incomplete-native-children' as const,
  journalId: 'journal',
  sequence: 10,
  reason: 'CHILD_UNQUALIFIED' as const,
  parent: { pid: 123, birth: 'darwin-bsd-start:21:0' },
  batch: {
    version: 1 as const,
    bootSeconds: '10',
    bootMicroseconds: '0',
    parentBefore: { pid: 123, seconds: '21', microseconds: '0' },
    parentAfter: null,
    complete: false,
    parentObservation: {
      beforeError: 0,
      afterError: 3,
      beforeZombie: false,
      afterZombie: null,
      identityChanged: null,
    },
    processes: [],
  },
};
it.each([false, undefined])(
  'joins one captured output and preserves a falsy writer fault %s',
  async (failure) => {
    let finish!: (error?: unknown) => void;
    const write = vi.fn((_bytes: string, done: (error?: unknown) => void) => {
      finish = done;
    });
    const sink = createOriginalChildBatchDiagnosticSink(write);
    const first = sink(packet);
    const rejection = first.then(
      () => ({ resolved: true }),
      (value) => ({ value })
    );
    expect(sink(packet)).toBe(first);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    let returned = false;
    void rejection.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    if (failure === undefined) {
      finish();
      expect(await rejection).toEqual({ resolved: true });
    } else {
      finish(failure);
      expect(await rejection).toEqual({ value: false });
    }
    expect(write.mock.calls[0][0]).toContain('"reason":"CHILD_UNQUALIFIED"');
  }
);
it.each([false, undefined])('preserves exact synchronous writer failure %s', async (failure) => {
  const sink = createOriginalChildBatchDiagnosticSink(() => {
    throw failure;
  });
  expect(
    await sink(packet).then(
      () => ({ resolved: true }),
      (value) => ({ value })
    )
  ).toEqual({ value: failure });
});
it('refuses oversized or arbitrary diagnostic properties before the original writer', async () => {
  const write = vi.fn();
  const sink = createOriginalChildBatchDiagnosticSink(write);
  await expect(
    sink({ ...packet, parent: { ...packet.parent, birth: 'x'.repeat(262144) } })
  ).rejects.toBeDefined();
  expect(write).not.toHaveBeenCalled();
  expect(() =>
    readDarwinJournalDiagnostic(
      new TextEncoder().encode(JSON.stringify({ ...packet, secret: 'not admitted' }) + '\n'),
      'journal'
    )
  ).toThrow();
});

it('retains original parent read errors without changing incomplete child admission', () => {
  const original = {
    kind: packet.kind,
    sequence: packet.sequence,
    reason: packet.reason,
    parent: packet.parent,
    batch: packet.batch,
  };
  const record = readDarwinJournalDiagnostic(
    Buffer.from(JSON.stringify(original) + '\n'),
    'journal'
  );
  expect(record?.batch.parentObservation).toEqual(packet.batch.parentObservation);
  expect(record?.batch.complete).toBe(false);
  expect(Object.isFrozen(record?.batch.parentObservation)).toBe(true);
  const legacy = { ...original, batch: { ...packet.batch } };
  Reflect.deleteProperty(legacy.batch, 'parentObservation');
  expect(
    readDarwinJournalDiagnostic(Buffer.from(JSON.stringify(legacy) + '\n'), 'journal')?.batch
      .complete
  ).toBe(false);
});

it('refuses contradictory parent read evidence before publishing a diagnostic', async () => {
  const write = vi.fn();
  const sink = createOriginalChildBatchDiagnosticSink(write);
  await expect(
    sink({
      ...packet,
      batch: {
        ...packet.batch,
        parentObservation: { ...packet.batch.parentObservation, afterError: 0 },
      },
    })
  ).rejects.toBeDefined();
  expect(write).not.toHaveBeenCalled();
});
