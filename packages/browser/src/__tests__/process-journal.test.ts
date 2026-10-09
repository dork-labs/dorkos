import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  JOURNAL_LIMITS,
  ProcessJournalError,
  openJournalWriter,
  observeJournalDirectory,
  readJournal,
  validateJournalSnapshot,
  type JournalBinding,
  type JournalFaultPoint,
  type JournalLocation,
  type JournalSnapshot,
  type ProcessJournalWriter,
  type JournalWriterIdentity,
} from '../lifecycle/process-journal.js';

// Keep actual filesystem methods while exposing a configurable module for close-acknowledgement spies.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const binding: JournalBinding = {
  journalId: 'journal_A',
  browserId: 'browser_A',
  profile: { kind: 'ephemeral' },
  browserGeneration: 0,
  reservationNonce: 'nonce_A',
  runtimeIdentityDigest: 'a'.repeat(64),
  manager: { pid: 10, birth: 'manager-A' },
  bootScope: { kind: 'observed', value: 'boot-A', sourceIdentityDigest: 'b'.repeat(64) },
};
const writerIdentity: JournalWriterIdentity = { writerId: 'writer_A', epoch: 0, kind: 'observer' };
function snapshot(sequence = 0, writer = writerIdentity): JournalSnapshot {
  const window = {
    startSequence: sequence,
    checkpointSequence: sequence,
    endSequence: sequence,
    startMonotonic: sequence,
    endMonotonic: sequence,
  };
  return {
    schemaVersion: 1,
    kind: 'browser-process-journal',
    provenance: 'recorded-data',
    binding,
    writer,
    sequence,
    phase: 'allocated',
    observationWindow: window,
    root: { kind: 'pending' },
    retainedIdentities: [
      {
        identity: binding.manager,
        role: 'manager',
        parent: null,
        association: null,
        currentParent: null,
        acquisitionEpoch: 0,
        firstSeenSequence: 0,
        lastSeenSequence: sequence,
        relationWindow: {
          startSequence: 0,
          checkpointSequence: 0,
          endSequence: 0,
          startMonotonic: 0,
          endMonotonic: 0,
        },
        lifecycle: 'alive',
      },
    ],
    gaps: [],
    firstCause: null,
  };
}

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
  it.each([
    'complete-chain',
    'cycle',
    'disconnected',
    'nonlive-new-parent',
    'wrong-epoch',
    'wrong-window',
    'stale-valid-window',
    'stale-monotonic-window',
    'leaf-wrong-epoch',
    'parent-after-child',
  ] as const)(
    'retains same-sweep native association chain only with original live ancestry (%s)',
    async (mode) => {
      const originalWriter = { ...writerIdentity, epoch: 1 };
      const opened = await openJournalWriter({
        ...location,
        writer: originalWriter,
        prior: { kind: 'absent' },
      });
      expect(opened.state).toBe('allocated');
      if (opened.state !== 'allocated') throw new Error('ORIGINAL_WRITER_REQUIRED');
      const writer = opened.writer;
      writers.push(writer);
      const prior = snapshot(0, originalWriter);
      expect((await writer.commitSnapshot(prior)).state).toBe('durable-recorded');
      const next = snapshot(1, originalWriter);
      const identities = [
        { pid: 20, birth: 'root-A' },
        { pid: 30, birth: 'child-A' },
        { pid: 40, birth: 'grandchild-A' },
      ];
      for (const [index, identity] of identities.entries()) {
        const parent = index === 0 ? binding.manager : identities[index - 1]!;
        const window = { ...next.observationWindow };
        const association = {
          parentBefore: parent,
          parentAfter: parent,
          child: identity,
          childParentPid: parent.pid,
          window,
          recordedSequence: 1,
          parentDeathSequence: null,
        };
        next.retainedIdentities.push({
          identity,
          role: index === 0 ? 'root' : 'descendant',
          parent,
          currentParent: parent,
          association,
          acquisitionEpoch: 1,
          firstSeenSequence: 1,
          lastSeenSequence: 1,
          relationWindow: window,
          lifecycle: 'alive',
        });
        if (index === 0) next.root = { kind: 'attributed', identity, association };
      }
      next.phase = 'observing';
      const child = next.retainedIdentities[2]!;
      if (mode === 'cycle' || mode === 'disconnected') {
        const parent = mode === 'cycle' ? identities[2]! : { pid: 99, birth: 'foreign-A' };
        child.parent = parent;
        child.currentParent = parent;
        child.association!.parentBefore = parent;
        child.association!.parentAfter = parent;
        child.association!.childParentPid = parent.pid;
      }
      if (mode === 'nonlive-new-parent') child.lifecycle = 'dead';
      if (mode === 'wrong-epoch') child.acquisitionEpoch = 0;
      if (mode === 'wrong-window') child.relationWindow.endMonotonic = 0;
      if (mode === 'stale-valid-window') {
        child.relationWindow.startSequence = 0;
        child.relationWindow.checkpointSequence = 0;
        child.relationWindow.endSequence = 0;
        child.relationWindow.startMonotonic = 0;
        child.relationWindow.endMonotonic = 0;
      }
      if (mode === 'stale-monotonic-window') {
        child.relationWindow.startMonotonic = 0;
        child.relationWindow.endMonotonic = 0;
      }
      if (mode === 'leaf-wrong-epoch') next.retainedIdentities[3]!.acquisitionEpoch = 0;
      if (mode === 'parent-after-child') {
        next.observationWindow.endMonotonic = 2;
        child.relationWindow.endMonotonic = 2;
      }
      if (
        mode === 'stale-valid-window' ||
        mode === 'stale-monotonic-window' ||
        mode === 'leaf-wrong-epoch' ||
        mode === 'wrong-epoch' ||
        mode === 'parent-after-child'
      )
        expect(() => validateJournalSnapshot(next)).not.toThrow();
      const result = await writer.commitSnapshot(next);
      expect(result.state).toBe(mode === 'complete-chain' ? 'durable-recorded' : 'uncertain');
      const read = await readJournal(location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state !== 'valid-recorded-data') throw new Error('ORIGINAL_CHECKPOINT_REQUIRED');
      expect(read.snapshot).toEqual(mode === 'complete-chain' ? next : prior);
    }
  );
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
  it('records uncertain reader-close even while attempting the actual owned close', async () => {
    const writer = await open();
    await writer.commitSnapshot(snapshot());
    const read = await readJournal({
      ...location,
      fault: (point) => {
        if (point === 'reader-close') throw Error('injected');
      },
    });
    expect(read.state).toBe('refused');
    expect(read.custody.opens).toBe(read.custody.closed);
    if (read.state === 'refused') expect(read.cause).toBe('read-uncertain');
    expect(read.custody.closesAttempted).toBe(read.custody.opens);
    expect(read.custody.held).toBe(0);
  });
  it.each([null, undefined, false, 0, ''])(
    'refuses a close-only falsy reader rejection %s after actual close',
    async (value) => {
      const writer = await open();
      await writer.commitSnapshot(snapshot());
      let attempts = 0;
      const read = await readJournal({
        ...location,
        fault: (point) => {
          if (point === 'reader-close') {
            attempts++;
            throw value;
          }
        },
      });
      expect(read.state).toBe('refused');
      if (read.state === 'refused') expect(read.cause).toBe('read-uncertain');
      expect(attempts).toBe(1);
      expect(read.custody).toEqual({ opens: 1, closesAttempted: 1, closed: 1, held: 0 });
    }
  );
  it.each([null, undefined])(
    'refuses allocation after falsy directory-close rejection %s without throwing a classifier error',
    async (value) => {
      let attempts = 0;
      const result = await openJournalWriter({
        ...location,
        writer: writerIdentity,
        prior: { kind: 'absent' },
        fault: (point) => {
          if (point === 'directory-close') {
            attempts++;
            throw value;
          }
        },
      });
      expect(result.state).toBe('refused');
      if (result.state !== 'allocated') expect(result.cause).toBe('persistence-uncertain');
      expect(attempts).toBe(1);
      expect(result.custody).toEqual({ opens: 1, closesAttempted: 1, closed: 1, held: 0 });
      expect((await readJournal(location)).state).toBe('missing');
    }
  );
  it.each([null, undefined])(
    'keeps payload-close rejection %s uncertain before rename with actual returned custody',
    async (value) => {
      let armed = false,
        attempts = 0;
      const writer = await open((point) => {
        if (armed && point === 'payload-close') {
          attempts++;
          throw value;
        }
      });
      await writer.commitSnapshot(snapshot());
      const old = await fs.readFile(join(root(), 'snapshot.json'));
      armed = true;
      const result = await writer.commitSnapshot(snapshot(1));
      expect(result.state).toBe('uncertain');
      if (result.state === 'uncertain') {
        expect(result.cause).toBe('persistence-uncertain');
        expect(result.phase).toBe('temporary');
      }
      expect(attempts).toBe(1);
      expect(result.custody.closesAttempted).toBe(result.custody.opens);
      expect(result.custody.closed).toBe(result.custody.opens);
      expect(result.custody.held).toBe(0);
      expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(old);
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
  it.each([null, undefined])(
    'does not report a healthy marker close or handoff for rejection %s',
    async (value) => {
      let armed = false,
        attempts = 0;
      const writer = await open((point) => {
        if (armed && point === 'marker-close') {
          attempts++;
          throw value;
        }
      });
      await writer.commitSnapshot(snapshot());
      armed = true;
      const closed = await writer.close();
      expect(closed.state).toBe('uncertain');
      if (closed.state === 'uncertain') expect(closed.cause).toBe('custody-pending');
      expect(attempts).toBe(1);
      expect(closed.custody.closed).toBe(closed.custody.opens);
      expect(closed.custody.held).toBe(0);
      expect(writer.close()).toBe(writer.close());
      const handoff = await writer.handoff({ ...writerIdentity, epoch: 1 });
      expect(handoff.state).toBe('uncertain');
      expect('ticket' in handoff).toBe(false);
      expect(attempts).toBe(1);
      expect(await fs.readFile(join(root(), 'writer.json'), 'utf8')).toContain('writer_A');
    }
  );
  it.each([null, undefined])(
    'does not mint a handoff ticket when original marker-close rejects %s',
    async (value) => {
      let armed = false,
        attempts = 0;
      const writer = await open((point) => {
        if (armed && point === 'marker-close') {
          attempts++;
          throw value;
        }
      });
      await writer.commitSnapshot(snapshot());
      armed = true;
      const handoff = await writer.handoff({ ...writerIdentity, epoch: 1 });
      expect(handoff.state).toBe('uncertain');
      if (handoff.state === 'uncertain') expect(handoff.cause).toBe('persistence-uncertain');
      expect('ticket' in handoff).toBe(false);
      expect(attempts).toBe(1);
      expect(handoff.custody.closed).toBe(handoff.custody.opens);
      expect(handoff.custody.held).toBe(0);
      await writer.close();
      expect(attempts).toBe(1);
      expect(await fs.readFile(join(root(), 'writer.json'), 'utf8')).toContain('handoff');
    }
  );
  it.each([null, undefined])(
    'preserves a named reader primary before falsy close rejection %s',
    async (value) => {
      const writer = await open();
      await writer.commitSnapshot(snapshot());
      let attempts = 0;
      const read = await readJournal({
        ...location,
        binding: { ...binding, runtimeIdentityDigest: 'c'.repeat(64) },
        fault: (point) => {
          if (point === 'reader-close') {
            attempts++;
            throw value;
          }
        },
      });
      expect(read.state).toBe('refused');
      if (read.state === 'refused') expect(read.cause).toBe('boot-changed');
      expect(attempts).toBe(1);
      expect(read.custody).toEqual({ opens: 1, closesAttempted: 1, closed: 1, held: 0 });
    }
  );
  it.each([null, undefined])(
    'preserves a falsy payload primary %s before named close rejection',
    async (value) => {
      let armed = false,
        attempts = 0;
      const writer = await open((point) => {
        if (armed && point === 'payload-write') throw value;
        if (armed && point === 'payload-close') {
          attempts++;
          throw new ProcessJournalError('custody-pending');
        }
      });
      await writer.commitSnapshot(snapshot());
      const old = await fs.readFile(join(root(), 'snapshot.json'));
      armed = true;
      const result = await writer.commitSnapshot(snapshot(1));
      expect(result.state).toBe('uncertain');
      if (result.state === 'uncertain') expect(result.cause).toBe('persistence-uncertain');
      expect(attempts).toBe(1);
      expect(result.custody.closed).toBe(result.custody.opens);
      expect(result.custody.held).toBe(0);
      expect(await fs.readFile(join(root(), 'snapshot.json'))).toEqual(old);
    }
  );
  it.each([null, undefined])(
    'preserves first falsy reader-close rejection %s over a later named original-close rejection',
    async (value) => {
      const writer = await open();
      await writer.commitSnapshot(snapshot());
      const originalOpen = fs.open;
      let attempts = 0;
      const closeSpies: Array<{ mockRestore(): void }> = [];
      const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
        const handle = await originalOpen(path, flags, mode);
        if (path === join(root(), 'snapshot.json')) {
          const originalClose = handle.close.bind(handle);
          closeSpies.push(
            vi.spyOn(handle, 'close').mockImplementation(async () => {
              attempts++;
              await originalClose();
              throw new ProcessJournalError('custody-pending');
            })
          );
        }
        return handle;
      });
      try {
        const read = await readJournal({
          ...location,
          fault: (point) => {
            if (point === 'reader-close') throw value;
          },
        });
        expect(read.state).toBe('refused');
        if (read.state === 'refused') expect(read.cause).toBe('read-uncertain');
        expect(attempts).toBe(1);
        expect(read.custody).toEqual({ opens: 1, closesAttempted: 1, closed: 0, held: 1 });
      } finally {
        openSpy.mockRestore();
        for (const spy of closeSpies) spy.mockRestore();
      }
      expect(attempts).toBe(1); // Real close ran; unknown acknowledgement remains held, never retried.
    }
  );
  it('preserves binding mismatch before a different reader-close failure while closing the original', async () => {
    const writer = await open();
    await writer.commitSnapshot(snapshot());
    let closeAttempts = 0;
    const read = await readJournal({
      ...location,
      binding: { ...binding, runtimeIdentityDigest: 'c'.repeat(64) },
      fault: (point) => {
        if (point === 'reader-close') {
          closeAttempts++;
          throw new ProcessJournalError('custody-pending');
        }
      },
    });
    expect(read.state).toBe('refused');
    if (read.state === 'refused') expect(read.cause).toBe('boot-changed');
    expect(closeAttempts).toBe(1);
    expect(read.custody.opens).toBe(1);
    expect(read.custody.closesAttempted).toBe(1);
    expect(read.custody.closed).toBe(1);
    expect(read.custody.held).toBe(0); // Hook failure cannot suppress the genuine original close.
  });
  it('keeps primary reader cause and unresolved custody when original close acknowledgement rejects', async () => {
    const writer = await open();
    await writer.commitSnapshot(snapshot());
    const originalOpen = fs.open;
    let closeAttempts = 0;
    const closeSpies: Array<{ mockRestore(): void }> = [];
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (path === join(root(), 'snapshot.json')) {
        const originalClose = handle.close.bind(handle);
        closeSpies.push(
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            closeAttempts++;
            await originalClose();
            // The real close occurs, but its acknowledgement is deliberately lost.
            // Production must retain this unknown original, not infer return or retry it.
            throw new ProcessJournalError('custody-pending');
          })
        );
      }
      return handle;
    });
    try {
      const read = await readJournal({
        ...location,
        binding: { ...binding, runtimeIdentityDigest: 'c'.repeat(64) },
      });
      expect(read.state).toBe('refused');
      if (read.state === 'refused') expect(read.cause).toBe('boot-changed');
      expect(closeAttempts).toBe(1);
      expect(read.custody.opens).toBe(1);
      expect(read.custody.closesAttempted).toBe(1);
      expect(read.custody.closed).toBe(0);
      expect(read.custody.held).toBe(1); // Report uncertainty despite physical test cleanup.
    } finally {
      openSpy.mockRestore();
      for (const spy of closeSpies) spy.mockRestore();
    }
    expect(closeAttempts).toBe(1); // drain did not repeat a numeric/original close.
  });
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
  it('preserves directory-sync primary failure before directory close failure after rename', async () => {
    let armed = false,
      failedSync = false,
      closeAttempts = 0;
    const writer = await open((point) => {
      if (armed && point === 'snapshot-directory-sync') {
        failedSync = true;
        throw new ProcessJournalError('observer-lost');
      }
      if (failedSync && point === 'directory-close') {
        closeAttempts++;
        throw new ProcessJournalError('custody-pending');
      }
    });
    const old = await writer.commitSnapshot(snapshot());
    armed = true;
    const result = await writer.commitSnapshot(snapshot(1));
    expect(result.state).toBe('uncertain');
    if (result.state === 'uncertain' && old.state === 'durable-recorded') {
      expect(result.cause).toBe('observer-lost');
      expect(result.phase).toBe('renamed');
      expect(result.oldDigest).toBe(old.digest);
      expect(result.newDigest).not.toBe(old.digest);
    } else throw Error('compound directory control did not reach the expected publication phase');
    expect(closeAttempts).toBe(1);
    expect(result.custody.opens).toBeGreaterThan(0);
    expect(result.custody.closesAttempted).toBe(result.custody.opens);
    expect(result.custody.closed).toBe(result.custody.opens);
    expect(result.custody.held).toBe(0);
    expect(JSON.parse(await fs.readFile(join(root(), 'snapshot.json'), 'utf8')).sequence).toBe(1);
    const closed = await writer.close();
    if (closed.state === 'uncertain') expect(closed.cause).toBe('observer-lost');
    else throw Error('directory failure was erased by close');
  });
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
  it('allows equal sequence windows for persistence-only checkpoints and forward windows', async () => {
    const writer = await open();
    expect((await writer.commitSnapshot(snapshot())).state).toBe('durable-recorded');
    expect((await writer.commitSnapshot(snapshot(1))).state).toBe('durable-recorded');
    const same = snapshot(2);
    same.observationWindow = {
      ...snapshot(1).observationWindow,
      startMonotonic: 2,
      endMonotonic: 2,
    };
    expect((await writer.commitSnapshot(same)).state).toBe('durable-recorded');
    expect((await writer.commitSnapshot(snapshot(3))).state).toBe('durable-recorded');
    const read = await readJournal(location);
    if (read.state === 'valid-recorded-data')
      expect(read.snapshot.observationWindow).toEqual(snapshot(3).observationWindow);
    else throw Error('forward observation history was not durable');
  });
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
  it('rejects accessors without invoking them and keeps the original sticky gap', async () => {
    let reads = 0;
    const getter = Object.defineProperty({ ...snapshot() }, 'sequence', {
      enumerable: true,
      get: () => {
        reads++;
        return 0;
      },
    });
    expect(() => validateJournalSnapshot(getter)).toThrow();
    expect(reads).toBe(0);
    const writer = await open();
    const initial = snapshot();
    initial.gaps = [{ cause: 'observer-lost', firstSequence: 0, identity: null, count: 1 }];
    initial.firstCause = { cause: 'observer-lost', sequence: 0 };
    expect((await writer.commitSnapshot(initial)).state).toBe('durable-recorded');
    expect((await writer.commitSnapshot(snapshot(1))).state).toBe('uncertain');
    const read = await readJournal(location);
    if (read.state === 'valid-recorded-data')
      expect(read.snapshot.firstCause?.cause).toBe('observer-lost');
    else throw Error('original snapshot lost');
  });
  it('bounds queue admission while a real write is paused and retains first refusal', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let waiting = false;
    const writer = await open(async (point) => {
      if (point === 'payload-write' && !waiting) {
        waiting = true;
        entered();
        await blocked;
      }
    });
    const first = writer.commitSnapshot(snapshot());
    await entry;
    const queued = Array.from({ length: JOURNAL_LIMITS.pending }, (_, i) =>
      writer.commitSnapshot(snapshot(i + 1))
    );
    release();
    const results = await Promise.all([first, ...queued]);
    expect(results.every((r) => r.state === 'uncertain')).toBe(true);
    expect((await writer.commitSnapshot(snapshot(100))).state).toBe('uncertain');
    expect((await readJournal(location)).state).toBe('missing');
  });
});

/** Pure snapshot contract controls complement the real-filesystem cases above. */
describe('journal bounded retained generation data', () => {
  it('accepts shared own data references without allowing cycles or accessor traversal', () => {
    const valid = snapshot();
    expect(validateJournalSnapshot(valid).binding.manager).toEqual(binding.manager);
    const cyclic: Record<string, unknown> = { ...valid };
    cyclic.root = cyclic;
    expect(() => validateJournalSnapshot(cyclic)).toThrow();
  });
  it('admits the full 512 identity cap and refuses cap+1 without silently dropping an old lifetime', () => {
    const full = snapshot();
    for (let i = 1; i < JOURNAL_LIMITS.identities; i++) {
      const identity = { pid: 1000 + i, birth: 'synthetic-child-' + i };
      const window = {
        startSequence: 0,
        checkpointSequence: 0,
        endSequence: 0,
        startMonotonic: 0,
        endMonotonic: 0,
      };
      full.retainedIdentities.push({
        identity,
        role: 'descendant',
        parent: binding.manager,
        currentParent: binding.manager,
        association: {
          parentBefore: binding.manager,
          parentAfter: binding.manager,
          child: identity,
          childParentPid: binding.manager.pid,
          window,
          recordedSequence: 0,
          parentDeathSequence: null,
        },
        acquisitionEpoch: 0,
        firstSeenSequence: 0,
        lastSeenSequence: 0,
        relationWindow: window,
        lifecycle: 'alive',
      });
    }
    expect(validateJournalSnapshot(full).retainedIdentities).toHaveLength(512);
    const overflow = {
      ...full,
      retainedIdentities: [
        ...full.retainedIdentities,
        {
          ...full.retainedIdentities[1]!,
          identity: { pid: 9999, birth: 'overflow' },
        },
      ],
    };
    expect(() => validateJournalSnapshot(overflow)).toThrow();
    expect(full.retainedIdentities).toHaveLength(512);
    expect(validateJournalSnapshot(full).retainedIdentities[1]!.identity.birth).toBe(
      'synthetic-child-1'
    );
  });
});
