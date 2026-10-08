import { expect, it, vi } from 'vitest';
import {
  readOriginalUnknownJournalDiagnostic,
  createOriginalUnknownJournalDiagnosticSink,
} from '../runtime/journal/unknown-diagnostic.js';
const raw = {
  kind: 'original-native-unknown',
  sequence: 238,
  fact: {
    kind: 'unknown',
    pid: 123,
    error: 35,
    uncertainty: 'membership-disappeared',
    inspection: {
      membershipBefore: true,
      membershipAfter: false,
      firstError: 3,
      secondError: 3,
      firstZombie: null,
      secondZombie: null,
      birthChanged: null,
      parentChanged: null,
    },
  },
  leaf: {
    watched: true,
    enrolled: true,
    forked: false,
    exited: true,
    consumed: false,
    receiverFailed: false,
    receiverClosed: false,
  },
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
it('retains original unknown facts and nested leaf evidence without upgrading them', () => {
  const result = readOriginalUnknownJournalDiagnostic(bytes(raw), 'journal');
  expect(result).toEqual({ ...raw, journalId: 'journal' });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result?.fact)).toBe(true);
  expect(Object.isFrozen(result?.fact.inspection)).toBe(true);
  expect(Object.isFrozen(result?.leaf)).toBe(true);
});
it('rejects extra fields, duplicates, unsafe epochs, oversized raw lines and invalid UTF8', () => {
  for (const value of [
    { ...raw, secret: 'private' },
    { ...raw, sequence: NaN },
    { ...raw, leaf: { ...raw.leaf, secret: 'private' } },
    { ...raw, fact: { ...raw.fact, pid: 0 } },
  ])
    expect(() => readOriginalUnknownJournalDiagnostic(bytes(value), 'journal')).toThrow();
  expect(() =>
    readOriginalUnknownJournalDiagnostic(Buffer.concat([bytes(raw), bytes(raw)]), 'journal')
  ).toThrow();
  expect(() =>
    readOriginalUnknownJournalDiagnostic(
      Buffer.from('{"kind":"original-native-unknown",' + ' '.repeat(2048)),
      'journal'
    )
  ).toThrow();
  expect(() => readOriginalUnknownJournalDiagnostic(Buffer.from([255]), 'journal')).toThrow();
});
it.each([false, undefined])('preserves exact synchronous writer fault %s', async (value) => {
  const original = readOriginalUnknownJournalDiagnostic(bytes(raw), 'journal');
  if (!original) throw Error('original missing');
  const sink = createOriginalUnknownJournalDiagnosticSink(() => {
    throw value;
  });
  await expect(sink(original)).rejects.toBe(value);
});
it('joins the held original writer before return and memoizes the same output duty', async () => {
  const original = readOriginalUnknownJournalDiagnostic(bytes(raw), 'journal');
  if (!original) throw Error('original missing');
  let finish: ((error?: unknown) => void) | undefined;
  const write = vi.fn((_bytes: string, done: (error?: unknown) => void) => {
    finish = done;
  });
  const sink = createOriginalUnknownJournalDiagnosticSink(write),
    work = sink(original);
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  try {
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(sink(original)).toBe(work);
    expect(settled).toBe(false);
    expect(write.mock.calls[0][0]).toContain('JOURNAL_ORIGINAL_UNKNOWN: ');
  } finally {
    finish?.(false);
    await Promise.allSettled([work]);
  }
  await expect(work).rejects.toBe(false);
});

it('selects the first recognized original line while still refusing later duplicate unknowns', () => {
  const children = Buffer.from('{"kind":"incomplete-native-children","parent":{},"batch":{}}\n');
  expect(
    readOriginalUnknownJournalDiagnostic(Buffer.concat([bytes(raw), children]), 'journal')?.kind
  ).toBe('original-native-unknown');
  expect(
    readOriginalUnknownJournalDiagnostic(Buffer.concat([children, bytes(raw)]), 'journal')
  ).toBeUndefined();
  expect(() =>
    readOriginalUnknownJournalDiagnostic(
      Buffer.concat([children, bytes(raw), bytes(raw)]),
      'journal'
    )
  ).toThrow();
});

it('never reads extra getters or participant toJSON while emitting closed original fields', async () => {
  const record = readOriginalUnknownJournalDiagnostic(bytes(raw), 'journal');
  if (!record) throw Error('missing');
  const secret = vi.fn(() => {
    throw Error('secret');
  });
  const participant = {
    ...record,
    fact: {
      ...record.fact,
      ...(record.fact.inspection ? { inspection: { ...record.fact.inspection } } : {}),
    },
    leaf: record.leaf && { ...record.leaf },
  };
  for (const value of [
    participant,
    participant.fact,
    participant.fact.inspection,
    participant.leaf,
  ])
    if (value) {
      Object.defineProperty(value, 'secret', { enumerable: true, get: secret });
      Object.defineProperty(value, 'toJSON', { value: secret });
    }
  const lines: string[] = [];
  const sink = createOriginalUnknownJournalDiagnosticSink((line, done) => {
    lines.push(line);
    done();
  });
  await sink(participant);
  expect(secret).not.toHaveBeenCalled();
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain('secret');
  expect(JSON.parse(lines[0].slice('JOURNAL_ORIGINAL_UNKNOWN: '.length))).toEqual(record);
});
it.each([false, undefined])(
  'preserves fixed-field getter failure %s before original write',
  async (value) => {
    const record = readOriginalUnknownJournalDiagnostic(bytes(raw), 'journal');
    if (!record) throw Error('missing');
    const write = vi.fn(),
      participant = { ...record };
    Object.defineProperty(participant, 'fact', {
      get() {
        throw value;
      },
    });
    await expect(createOriginalUnknownJournalDiagnosticSink(write)(participant)).rejects.toBe(
      value
    );
    expect(write).not.toHaveBeenCalled();
  }
);
