import { expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openJournalWriter, observeJournalDirectory } from '../lifecycle/process-journal.js';
import { reserveProfile } from '../profiles/reservation.js';
import { parseProfileId } from '../ids.js';
import { configuration } from './parent-fixture.js';
const controls = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('../runtime/darwin-process-observer.js', async (original) => ({
  ...(await original<typeof import('../runtime/darwin-process-observer.js')>()),
  createDarwinProcessObserver: () => ({ inspect: controls.inspect }),
}));
import type {
  JournalSnapshot,
  JournalBinding,
  ObservationWindow,
  RecordedAssociation,
} from '../lifecycle/process-journal.js';
import { reconcileDarwinBatch } from '../runtime/darwin-recovery.js';
import type { DarwinProcessBatch } from '../runtime/darwin-process-observer.js';
const manager = { pid: 10, birth: 'darwin-bsd-start:1:10' };
const root = { pid: 20, birth: 'darwin-bsd-start:1:20' };
const child = { pid: 30, birth: 'darwin-bsd-start:1:30' };
const boot = {
  kind: 'observed' as const,
  value: 'darwin-boot:1:0',
  sourceIdentityDigest: 'b'.repeat(64),
};
const binding: JournalBinding = {
  journalId: 'journal_A',
  browserId: 'browser_A',
  profile: { kind: 'persistent', profileId: 'profile_A' },
  browserGeneration: 1,
  reservationNonce: 'nonce_A',
  runtimeIdentityDigest: 'a'.repeat(64),
  manager,
  bootScope: boot,
};
function window(sequence: number): ObservationWindow {
  return {
    startSequence: sequence,
    checkpointSequence: sequence,
    endSequence: sequence,
    startMonotonic: sequence,
    endMonotonic: sequence,
  };
}
function association(
  parent: typeof manager,
  identity: typeof root,
  sequence: number
): RecordedAssociation {
  return {
    parentBefore: parent,
    parentAfter: { ...parent },
    child: identity,
    childParentPid: parent.pid,
    window: window(sequence),
    recordedSequence: sequence,
    parentDeathSequence: null,
  };
}
function snapshot(): JournalSnapshot {
  const rootAssociation = association(manager, root, 1),
    childAssociation = association(root, child, 2);
  return {
    schemaVersion: 1,
    kind: 'browser-process-journal',
    provenance: 'recorded-data',
    binding,
    writer: { writerId: 'observer_A', epoch: 0, kind: 'observer' },
    sequence: 2,
    phase: 'observing',
    observationWindow: window(2),
    root: { kind: 'attributed', identity: root, association: rootAssociation },
    retainedIdentities: [
      {
        identity: manager,
        role: 'manager',
        parent: null,
        association: null,
        currentParent: null,
        acquisitionEpoch: 0,
        firstSeenSequence: 0,
        lastSeenSequence: 2,
        relationWindow: window(0),
        lifecycle: 'alive',
      },
      {
        identity: root,
        role: 'root',
        parent: manager,
        association: rootAssociation,
        currentParent: manager,
        acquisitionEpoch: 0,
        firstSeenSequence: 1,
        lastSeenSequence: 2,
        relationWindow: window(1),
        lifecycle: 'alive',
      },
      {
        identity: child,
        role: 'descendant',
        parent: root,
        association: childAssociation,
        currentParent: root,
        acquisitionEpoch: 0,
        firstSeenSequence: 2,
        lastSeenSequence: 2,
        relationWindow: window(2),
        lifecycle: 'alive',
      },
    ],
    gaps: [],
    firstCause: null,
  };
}

const gone = (): DarwinProcessBatch => ({
  version: 1,
  bootSeconds: '1',
  bootMicroseconds: '0',
  processes: [manager, root, child].map(({ pid }) => ({ kind: 'absent', pid })),
});
it('matches explicit disappearance while retaining profile authority', () => {
  const result = reconcileDarwinBatch(snapshot(), gone(), 'b'.repeat(64), 3, 4);
  expect(result.recordedDisposition).toBe('matching-recorded-gone');
  expect(result.decision).toBe('retain');
});
it('retains a live reparented child after root disappearance and refuses zombies', () => {
  const batch = gone();
  batch.processes[2] = {
    kind: 'present',
    identity: { pid: 30, seconds: '1', microseconds: '30' },
    parentPid: 1,
    zombie: false,
  };
  expect(reconcileDarwinBatch(snapshot(), batch, 'b'.repeat(64), 3, 4).recordedDisposition).toBe(
    'live-recorded'
  );
  batch.processes[2].zombie = true;
  expect(reconcileDarwinBatch(snapshot(), batch, 'b'.repeat(64), 3, 4).recordedDisposition).toBe(
    'unknown'
  );
});
it('refuses missing originals, changed boots and backwards observation time', () => {
  const missing = gone();
  missing.processes.pop();
  const changed = gone();
  changed.bootSeconds = '2';
  for (const batch of [missing, changed])
    expect(reconcileDarwinBatch(snapshot(), batch, 'b'.repeat(64), 3, 4).recordedDisposition).toBe(
      'unknown'
    );
  expect(reconcileDarwinBatch(snapshot(), gone(), 'b'.repeat(64), 1, 2).recordedDisposition).toBe(
    'unknown'
  );
});
it('recognizes replacement without treating it as the original', () => {
  const batch = gone();
  batch.processes[2] = {
    kind: 'present',
    identity: { pid: 30, seconds: '2', microseconds: '30' },
    parentPid: 1,
    zombie: false,
  };
  expect(
    reconcileDarwinBatch(snapshot(), batch, 'b'.repeat(64), 3, 4).replacementIdentities
  ).toEqual([{ pid: 30, birth: 'darwin-bsd-start:2:30' }]);
});

// Real private journal/reservation I/O with semantic native facts, not a native acceptance claim.
it.each(['live-root', 'gone', 'pid-reuse', 'missing-original', 'history-gap'] as const)(
  'startup automatically reconciles %s against every original without profile mutation',
  async (mode) => {
    const rootDir = await realpath(await mkdtemp(join(tmpdir(), 'startup-recorded-')));
    const id = parseProfileId('profile_startup_recovery'),
      nonce = randomUUID();
    const data = snapshot();
    data.binding = {
      ...data.binding,
      reservationNonce: nonce,
      profile: { kind: 'persistent', profileId: id },
    };
    const journals = join(rootDir, 'journals');
    await mkdir(journals, { mode: 0o700 });
    const location = {
      parentDirectory: journals,
      parentIdentity: await observeJournalDirectory(journals),
      binding: data.binding,
    };
    const opened = await openJournalWriter({
      ...location,
      writer: data.writer,
      prior: { kind: 'absent' },
    });
    if (opened.state !== 'allocated') throw new Error('JOURNAL_FIXTURE_SETUP');
    try {
      const initial = structuredClone(data);
      initial.sequence = 0;
      initial.phase = 'allocated';
      initial.observationWindow = window(0);
      initial.root = { kind: 'pending' };
      initial.retainedIdentities = [initial.retainedIdentities[0]!];
      initial.retainedIdentities[0]!.lastSeenSequence = 0;
      expect((await opened.writer.commitSnapshot(initial)).state).toBe('durable-recorded');
      const first = structuredClone(data);
      first.sequence = 1;
      first.observationWindow = window(1);
      first.retainedIdentities.pop();
      for (const original of first.retainedIdentities) original.lastSeenSequence = 1;
      expect((await opened.writer.commitSnapshot(first)).state).toBe('durable-recorded');
      if (mode === 'history-gap') {
        data.gaps = [{ cause: 'association-missing', identity: child, firstSequence: 2, count: 1 }];
        data.firstCause = { cause: 'association-missing', sequence: 2 };
      }
      expect((await opened.writer.commitSnapshot(data)).state).toBe('durable-recorded');
      await opened.writer.close();
      const directory = join(rootDir, 'reservations', id),
        profile = join(rootDir, 'profiles', id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const owner = JSON.stringify({
        nonce,
        manager,
        phase: 'running',
        browser: root,
        journal: data.binding,
      });
      await writeFile(join(directory, 'owner.json'), owner, { mode: 0o600 });
      await writeFile(join(profile, 'fixture-marker'), 'original-private-value', { mode: 0o600 });
      const batch = gone();
      if (mode === 'live-root' || mode === 'pid-reuse')
        batch.processes[1] = {
          kind: 'present',
          identity: { pid: 20, seconds: mode === 'pid-reuse' ? '2' : '1', microseconds: '20' },
          parentPid: 1,
          zombie: false,
        };
      if (mode === 'missing-original') batch.processes.pop();
      controls.inspect.mockResolvedValue(batch);
      const config = configuration();
      config.nativeJournal = {
        artifact: { path: '/private/semantic-observer', sha256: 'b'.repeat(64) },
        workerPath: '/private/semantic-worker',
        duration: 1000,
        maxGap: 100,
      };
      await expect(
        reserveProfile(config, rootDir, id, { pid: 40, birth: 'fresh-manager' })
      ).rejects.toMatchObject({
        code: mode === 'live-root' ? 'PROFILE_IN_USE' : 'PROFILE_UNCERTAIN',
      });
      expect(controls.inspect).toHaveBeenLastCalledWith([10, 20, 30]);
      expect(await readFile(join(directory, 'owner.json'), 'utf8')).toBe(owner);
      expect(await readFile(join(profile, 'fixture-marker'), 'utf8')).toBe(
        'original-private-value'
      );
    } finally {
      await opened.writer.close();
      await rm(rootDir, { recursive: true, force: true });
      controls.inspect.mockReset();
    }
  }
);
