import { expect, it } from 'vitest';
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
