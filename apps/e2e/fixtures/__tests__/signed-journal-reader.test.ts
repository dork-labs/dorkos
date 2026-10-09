import { expect, it, vi, onTestFinished } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const preventedNativeSpawn = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('UNEXPECTED_NATIVE_PRODUCER');
  })
);
vi.mock('node:child_process', () => ({ spawn: preventedNativeSpawn }));
import {
  decodeOriginalSignedJournalBytes,
  createOriginalSignedJournalReader,
  requireOriginalSignedJournalManager,
} from '../signed-desktop/journal-reader.js';

// Native openat/no-follow behavior must be checked against the compiled supplied artifact separately.
const path = '.dork/browser/journals/journal-original/snapshot.json';
const bytes = Buffer.from('{"original":true}');
it('retains complete original bytes and relative path without conferring journal authority', () => {
  const rows = decodeOriginalSignedJournalBytes(
    JSON.stringify([{ path, base64: bytes.toString('base64') }])
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.path).toBe(path);
  expect(rows[0]?.bytes.equals(bytes)).toBe(true);
  expect(decodeOriginalSignedJournalBytes('[]')).toEqual([]);
});
it.each([
  '../personal/snapshot.json',
  '.dork/browser/journals/../snapshot.json',
  '.dork/browser/journals/journal-original//snapshot.json',
])('refuses an original response outside the closed relative journal scope %s', (badPath) => {
  expect(() =>
    decodeOriginalSignedJournalBytes(
      JSON.stringify([{ path: badPath, base64: bytes.toString('base64') }])
    )
  ).toThrow('DESKTOP_JOURNAL_BOUND');
});
it('refuses duplicate snapshots, truncated bytes, noncanonical base64 and aggregate overflow', () => {
  const row = { path, base64: bytes.toString('base64') };
  for (const rows of [
    [row, row],
    [{ ...row, base64: row.base64.slice(0, -1) }],
    [{ ...row, base64: 'AB==' }],
  ])
    expect(() => decodeOriginalSignedJournalBytes(JSON.stringify(rows))).toThrow(
      'DESKTOP_JOURNAL_BOUND'
    );
  expect(() => decodeOriginalSignedJournalBytes(' '.repeat(1024 * 1024 + 1))).toThrow(
    'DESKTOP_JOURNAL_BOUND'
  );
});

it('freshly rejects changed reader bytes before any subsequent native producer enters', async () => {
  const home = await mkdtemp(join(tmpdir(), 'signed-reader-original-'));
  const path = join(home, 'reader');
  const bytes = Buffer.from('controlled original artifact bytes');
  const owned: { reader?: Awaited<ReturnType<typeof createOriginalSignedJournalReader>> } = {};
  onTestFinished(async () => {
    try {
      await owned.reader?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  preventedNativeSpawn.mockClear();
  const reader = await createOriginalSignedJournalReader(
    { path, sha256: createHash('sha256').update(bytes).digest('hex') },
    home,
    {},
    new AbortController().signal
  );
  owned.reader = reader;
  await writeFile(path, Buffer.from('mutated original artifact bytes'));
  await expect(reader.read(new AbortController().signal)).rejects.toThrow(
    'SIGNED_JOURNAL_READER_CHANGED'
  );
  expect(preventedNativeSpawn).not.toHaveBeenCalled();
  await reader.close();
  expect(() => reader?.read(new AbortController().signal)).toThrow('SIGNED_JOURNAL_READER_CLOSED');
});

it('qualifies only an exact captured Utility birth, never a recycled PID or other app role', () => {
  const original = Object.freeze({ pid: 123, birth: 'darwin-bsd-start:456:789' });
  const other = Object.freeze({ pid: 124, birth: 'darwin-bsd-start:456:790' });
  const cohort = Object.freeze([original, other]);
  expect(() => requireOriginalSignedJournalManager(original, [123], cohort)).not.toThrow();
  expect(() =>
    requireOriginalSignedJournalManager(
      { ...original, birth: 'darwin-bsd-start:999:1' },
      [123],
      cohort
    )
  ).toThrow('JOURNAL_NOT_PACKAGED_SERVER_ACTOR');
  expect(() => requireOriginalSignedJournalManager(other, [123], cohort)).toThrow(
    'JOURNAL_NOT_PACKAGED_SERVER_ACTOR'
  );
  expect(() => requireOriginalSignedJournalManager(original, [123], [])).toThrow(
    'JOURNAL_NOT_PACKAGED_SERVER_ACTOR'
  );
});
