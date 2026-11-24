import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  JOURNAL_LIMITS,
  openJournalWriter,
  observeJournalDirectory,
  readJournal,
  validateJournalSnapshot,
  type JournalFaultPoint,
  type JournalLocation,
  type ProcessJournalWriter,
  type JournalWriterIdentity,
} from '../../lifecycle/process-journal.js';
import { ProcessJournalError } from '../../lifecycle/process-journal.js';
import { binding, writerIdentity, snapshot } from './process-journal.fixtures.js';

// Keep actual filesystem methods while exposing a configurable module for close-acknowledgement spies.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

/** All process/boot facts here are synthetic; only the owned temporary filesystem is real. */
describe('recorded process journal Node persistence', () => {
  let parent: string, location: JournalLocation;
  const writers: ProcessJournalWriter[] = [];
  beforeEach(async () => {
    parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'process-journal-owned-')));
    await fs.chmod(parent, 0o700);
    location = {
      parentDirectory: parent,
      parentIdentity: await observeJournalDirectory(parent),
      binding,
    };
  });
  afterEach(async () => {
    for (const writer of writers.splice(0)) await writer.close();
    // Only the test's own mkdtemp tree; production journal exposes no recursive cleanup.
    await fs.rm(parent, { recursive: true, force: true });
  });
  const root = () => join(parent, 'journal-' + binding.journalId);
  async function open(
    fault?: (point: JournalFaultPoint) => void | Promise<void>,
    writeChunkBytes?: number
  ) {
    const result = await openJournalWriter({
      ...location,
      writer: writerIdentity,
      prior: { kind: 'absent' },
      fault,
      writeChunkBytes,
    });
    expect(result.state).toBe('allocated');
    if (result.state !== 'allocated') throw Error('test writer was not allocated');
    writers.push(result.writer);
    return result.writer;
  }
  it('persists canonical bounded bytes, reads through original FD, and queues exact successors', async () => {
    expect((await readJournal(location)).state).toBe('missing');
    const writer = await open(undefined, 7); // Genuine small writes exercise the partial-write loop.
    const first = writer.commitSnapshot(snapshot());
    const secondInput = snapshot(1);
    const second = writer.commitSnapshot(secondInput);
    secondInput.retainedIdentities[0]!.identity = { pid: 999, birth: 'caller-mutated' };
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.state)).toEqual(['durable-recorded', 'durable-recorded']);
    const read = await readJournal(location);
    expect(read.state).toBe('valid-recorded-data');
    if (read.state === 'valid-recorded-data') {
      expect(read.snapshot.sequence).toBe(1);
      expect(read.snapshot.binding.manager.pid).toBe(10);
      expect(read.custody.held).toBe(0);
      expect(read.custody.opens).toBe(read.custody.closed);
    }
    const close = writer.close();
    expect(writer.close()).toBe(close);
    expect((await close).state).toBe('closed');
    expect((await writer.commitSnapshot(snapshot(2))).state).toBe('uncertain');
    expect(
      (await openJournalWriter({ ...location, writer: writerIdentity, prior: { kind: 'absent' } }))
        .state
    ).toBe('busy');
  });
  it('admits only one concurrent cooperating writer, without replacing the winner marker', async () => {
    const results = await Promise.all([
      openJournalWriter({ ...location, writer: writerIdentity, prior: { kind: 'absent' } }),
      openJournalWriter({
        ...location,
        writer: { ...writerIdentity, writerId: 'loser' },
        prior: { kind: 'absent' },
      }),
    ]);
    expect(results.filter((r) => r.state === 'allocated')).toHaveLength(1);
    // A loser reaching the directory before marker publication sees unknown ownership;
    // it refuses rather than stealing the not-yet-durable reservation.
    expect(results.filter((r) => r.state === 'busy' || r.state === 'refused')).toHaveLength(1);
    for (const result of results) if (result.state === 'allocated') writers.push(result.writer);
    const owner = JSON.parse(await fs.readFile(join(root(), 'writer.json'), 'utf8'));
    expect(['writer_A', 'loser']).toContain(owner.writer.writerId);
  });
  it('requires the genuine one-use local ticket; serialized receipts and matching digests cannot reopen', async () => {
    const writer = await open();
    const committed = await writer.commitSnapshot(snapshot());
    expect(committed.state).toBe('durable-recorded');
    if (committed.state !== 'durable-recorded') throw Error('test commit failed');
    const nextIdentity: JournalWriterIdentity = {
      writerId: 'writer_B',
      epoch: 1,
      kind: 'reconciler',
    };
    const handoff = writer.handoff(nextIdentity);
    expect(writer.handoff(nextIdentity)).toBe(handoff);
    const result = await handoff;
    expect(result.state).toBe('handed-off');
    if (result.state !== 'handed-off') throw Error('test handoff failed');
    const options = {
      ...location,
      writer: nextIdentity,
      prior: { kind: 'recorded' as const, sequence: 0, digest: committed.digest },
    };
    expect((await openJournalWriter(options)).state).toBe('refused');
    expect((await openJournalWriter({ ...options, ticket: JSON.parse('{}') })).state).toBe(
      'refused'
    );
    const reopened = await openJournalWriter({ ...options, ticket: result.ticket });
    expect(reopened.state).toBe('allocated');
    if (reopened.state === 'allocated') {
      writers.push(reopened.writer);
      expect((await reopened.writer.commitSnapshot(snapshot(1, nextIdentity))).state).toBe(
        'durable-recorded'
      );
    }
    expect((await openJournalWriter({ ...options, ticket: result.ticket })).state).toBe('refused');
  });
  it('does not adopt an empty abandoned namespace or erase an unknown marker', async () => {
    await fs.mkdir(root(), { mode: 0o700 });
    expect(
      (await openJournalWriter({ ...location, writer: writerIdentity, prior: { kind: 'absent' } }))
        .state
    ).toBe('refused');
    await fs.writeFile(join(root(), 'writer.json'), 'unknown', { mode: 0o600, flag: 'wx' });
    expect(
      (await openJournalWriter({ ...location, writer: writerIdentity, prior: { kind: 'absent' } }))
        .state
    ).toBe('busy');
    expect(await fs.readFile(join(root(), 'writer.json'), 'utf8')).toBe('unknown');
  });
  it.each(['payload-write', 'payload-sync', 'payload-close', 'snapshot-rename'] as const)(
    'keeps the original durable snapshot on pre-rename %s failure and fences retries',
    async (point) => {
      let armed = false;
      const writer = await open((stage) => {
        if (armed && stage === point) throw Error('injected');
      });
      await writer.commitSnapshot(snapshot());
      const old = await fs.readFile(join(root(), 'snapshot.json'));
      armed = true;
      const result = await writer.commitSnapshot(snapshot(1));
      expect(result.state).toBe('uncertain');
      expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(old);
      expect((await writer.commitSnapshot(snapshot(2))).state).toBe('uncertain');
      expect((await writer.close()).state).toBe('uncertain');
    }
  );
  it.each(['namespace-sync', 'parent-sync', 'marker-write', 'marker-sync'] as const)(
    'refuses allocation when new directory/marker durability fails at %s',
    async (point) => {
      const result = await openJournalWriter({
        ...location,
        writer: writerIdentity,
        prior: { kind: 'absent' },
        fault: (stage) => {
          if (stage === point) throw Error('injected');
        },
      });
      expect(result.state).not.toBe('allocated');
      expect((await readJournal(location)).state).not.toBe('valid-recorded-data');
    }
  );
  it.each(['startSequence', 'checkpointSequence', 'endSequence'] as const)(
    'refuses a separately regressing %s despite advancing outer sequence and clocks',
    async (field) => {
      const writer = await open();
      expect((await writer.commitSnapshot(snapshot())).state).toBe('durable-recorded');
      const one = snapshot(1);
      one.observationWindow.startSequence = 0;
      one.observationWindow.checkpointSequence = 0;
      expect((await writer.commitSnapshot(one)).state).toBe('durable-recorded');
      const two = snapshot(2);
      two.observationWindow.startSequence = 1;
      two.observationWindow.checkpointSequence = 1;
      expect((await writer.commitSnapshot(two)).state).toBe('durable-recorded');
      const three = snapshot(3);
      three.observationWindow.startSequence = 1;
      three.observationWindow.checkpointSequence = 2;
      expect((await writer.commitSnapshot(three)).state).toBe('durable-recorded');
      const old = await fs.readFile(join(root(), 'snapshot.json'));
      const next = snapshot(4);
      next.observationWindow = { ...three.observationWindow, startMonotonic: 4, endMonotonic: 4 };
      next.observationWindow[field]--; // Other two components remain equal and the internal ordering is valid.
      expect(() => validateJournalSnapshot(next)).not.toThrow();
      const result = await writer.commitSnapshot(next);
      expect(result.state).toBe('uncertain');
      if (result.state === 'uncertain') {
        expect(result.cause).toBe('sequence-gap');
        expect(result.phase).toBe('validation');
      }
      expect(result.custody.opens).toBe(0);
      expect(result.custody.held).toBe(0);
      expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(old);
      expect(await fs.readdir(root())).not.toContain('snapshot.tmp');
      const retry = await writer.commitSnapshot(snapshot(4));
      if (retry.state === 'uncertain') expect(retry.cause).toBe('sequence-gap');
      else throw Error('regression did not fence the writer');
      expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(old);
    }
  );
  it('retains partial temporary bytes on interrupted real small writes and preserves old current', async () => {
    let writes = 0,
      armed = false;
    const writer = await open((point) => {
      if (armed && point === 'payload-write' && ++writes === 2) throw Error('second write refused');
    }, 7);
    await writer.commitSnapshot(snapshot());
    const old = await fs.readFile(join(root(), 'snapshot.json'));
    armed = true;
    expect((await writer.commitSnapshot(snapshot(1))).state).toBe('uncertain');
    expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(old);
    expect((await fs.stat(join(root(), 'snapshot.tmp'))).size).toBe(7);
  });
  it.each(['reservationNonce', 'browserGeneration', 'writer'] as const)(
    'refuses a wrong %s without changing the original snapshot',
    async (field) => {
      const writer = await open();
      await writer.commitSnapshot(snapshot());
      const original = await fs.readFile(join(root(), 'snapshot.json'));
      const next = snapshot(1);
      if (field === 'writer') next.writer = { ...writerIdentity, epoch: 1 };
      else
        next.binding = {
          ...binding,
          ...(field === 'reservationNonce'
            ? { reservationNonce: 'wrong' }
            : { browserGeneration: 1 }),
        };
      const result = await writer.commitSnapshot(next);
      expect(result.state).toBe('uncertain');
      if (result.state === 'uncertain') expect(result.cause).toBe('sequence-gap');
      expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(original);
    }
  );
  it('consumes a failed expected-prior ticket once and never substitutes equal-looking data', async () => {
    const writer = await open();
    await writer.commitSnapshot(snapshot());
    const nextIdentity: JournalWriterIdentity = { ...writerIdentity, epoch: 1 };
    const transfer = await writer.handoff(nextIdentity);
    if (transfer.state !== 'handed-off') throw Error('test transfer failed');
    const bad = {
      ...location,
      writer: nextIdentity,
      ticket: transfer.ticket,
      prior: { kind: 'recorded' as const, sequence: 0, digest: 'c'.repeat(64) },
    };
    expect((await openJournalWriter(bad)).state).toBe('uncertain');
    expect((await openJournalWriter(bad)).state).toBe('refused');
    expect((await readJournal(location)).state).toBe('valid-recorded-data');
  });
  it('refuses symlink/wrong-type/oversized/malformed/extra-field/duplicate-key snapshots', async () => {
    const writer = await open();
    await writer.commitSnapshot(snapshot());
    await writer.close();
    const file = join(root(), 'snapshot.json'),
      original = await fs.readFile(file);
    for (const bytes of [
      Buffer.from('{'),
      Buffer.alloc(JOURNAL_LIMITS.bytes + 1, 32),
      Buffer.from(JSON.stringify({ ...snapshot(), complete: true })),
      Buffer.from('{"schemaVersion":1,' + original.toString().slice(1)),
    ]) {
      await fs.writeFile(file, bytes, { mode: 0o600 });
      expect((await readJournal(location)).state).toBe('refused');
    }
    await fs.unlink(file);
    await fs.mkdir(file);
    expect((await readJournal(location)).state).toBe('refused');
    await fs.rmdir(file);
    const sentinel = join(parent, 'sentinel');
    await fs.writeFile(sentinel, original);
    await fs.symlink(sentinel, file);
    expect((await readJournal(location)).state).toBe('refused');
    expect(await fs.readFile(sentinel)).toEqual(original);
  });
  it('detects named-file replacement between lstat and open and attempts reader FD close', async () => {
    const writer = await open();
    await writer.commitSnapshot(snapshot());
    const file = join(root(), 'snapshot.json'),
      bytes = await fs.readFile(file);
    let swapped = false;
    const result = await readJournal({
      ...location,
      fault: async (point) => {
        if (point === 'reader-open' && !swapped) {
          swapped = true;
          await fs.rename(file, file + '.original');
          await fs.writeFile(file, bytes, { mode: 0o600 });
        }
      },
    });
    expect(result.state).toBe('refused');
    expect(result.custody.opens).toBe(result.custody.closed);
  });
  it('refuses parent/root replacement before opening a payload instead of writing to the replacement', async () => {
    let armed = false,
      changed = false;
    const writer = await open(async (point) => {
      if (armed && point === 'payload-open' && !changed) {
        changed = true;
        await fs.rename(root(), root() + '.original');
        await fs.mkdir(root(), { mode: 0o700 });
      }
    });
    await writer.commitSnapshot(snapshot());
    armed = true;
    const result = await writer.commitSnapshot(snapshot(1));
    expect(result.state).toBe('uncertain');
    if (result.state === 'uncertain') expect(result.cause).toBe('parent-changed');
    expect(await fs.readdir(root())).toEqual([]);
  });
  it('never transfers ownership after a handoff directory-sync failure', async () => {
    let armed = false;
    const writer = await open((point) => {
      if (armed && point === 'handoff-directory-sync') throw Error('injected');
    });
    await writer.commitSnapshot(snapshot());
    armed = true;
    const handoff = await writer.handoff({ ...writerIdentity, epoch: 1 });
    expect(handoff.state).toBe('uncertain');
    expect('ticket' in handoff).toBe(false);
    expect(
      (await openJournalWriter({ ...location, writer: writerIdentity, prior: { kind: 'absent' } }))
        .state
    ).toBe('refused');
  });

  it.each(['snapshot-directory-sync', 'parent-sync'] as const)(
    'retains post-rename uncertainty on %s without pretending rollback',
    async (point) => {
      let armed = false;
      const writer = await open((stage) => {
        if (armed && stage === point) throw Error('injected');
      });
      const old = await writer.commitSnapshot(snapshot());
      armed = true;
      const result = await writer.commitSnapshot(snapshot(1));
      expect(result.state).toBe('uncertain');
      if (result.state === 'uncertain' && old.state === 'durable-recorded') {
        expect(result.phase).toBe('renamed');
        expect(result.oldDigest).toBe(old.digest);
        expect(result.newDigest).not.toBe(old.digest);
      }
      const actual = JSON.parse(await fs.readFile(join(root(), 'snapshot.json'), 'utf8'));
      expect(actual.sequence).toBe(1); // Published bytes remain; result refused durability.
    }
  );

  it.each([null, undefined])(
    'keeps directory-close rejection %s uncertain after rename without rollback',
    async (value) => {
      let armed = false,
        attempts = 0;
      const writer = await open((point) => {
        if (armed && point === 'directory-close') {
          attempts++;
          throw value;
        }
      });
      await writer.commitSnapshot(snapshot());
      armed = true;
      const result = await writer.commitSnapshot(snapshot(1));
      expect(result.state).toBe('uncertain');
      if (result.state === 'uncertain') {
        expect(result.cause).toBe('persistence-uncertain');
        expect(result.phase).toBe('renamed');
      }
      expect(attempts).toBe(1);
      expect(result.custody.closesAttempted).toBe(result.custody.opens);
      expect(result.custody.closed).toBe(result.custody.opens);
      expect(result.custody.held).toBe(0);
      expect(JSON.parse(await fs.readFile(join(root(), 'snapshot.json'), 'utf8')).sequence).toBe(1);
    }
  );

  it('preserves payload primary failure before close failure, old bytes and sticky writer cause', async () => {
    let armed = false,
      closeAttempts = 0;
    const writer = await open((point) => {
      if (armed && point === 'payload-write') throw new ProcessJournalError('observer-lost');
      if (armed && point === 'payload-close') {
        closeAttempts++;
        throw new ProcessJournalError('custody-pending');
      }
    });
    await writer.commitSnapshot(snapshot());
    const old = await fs.readFile(join(root(), 'snapshot.json'));
    armed = true;
    const result = await writer.commitSnapshot(snapshot(1));
    expect(result.state).toBe('uncertain');
    if (result.state === 'uncertain') expect(result.cause).toBe('observer-lost');
    expect(closeAttempts).toBe(1);
    expect(result.custody.opens).toBeGreaterThan(0);
    expect(result.custody.closesAttempted).toBe(result.custody.opens);
    expect(result.custody.closed).toBe(result.custody.opens);
    expect(result.custody.held).toBe(0);
    expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(old);
    const retry = await writer.commitSnapshot(snapshot(2));
    if (retry.state === 'uncertain') expect(retry.cause).toBe('observer-lost');
    else throw Error('failed writer accepted another commit');
    const closed = await writer.close();
    expect(closed.state).toBe('uncertain');
    if (closed.state === 'uncertain') expect(closed.cause).toBe('observer-lost');
  });
});
