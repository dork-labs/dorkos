/**
 * Helpers shared by the `process-journal*.test.ts` suites. Not a `*.test.ts`, so vitest
 * never collects it as a suite.
 *
 * @module process-journal.fixtures
 */
import {
  type JournalBinding,
  type JournalSnapshot,
  type JournalWriterIdentity,
} from '../../lifecycle/process-journal.js';

export const binding: JournalBinding = {
  journalId: 'journal_A',
  browserId: 'browser_A',
  profile: { kind: 'ephemeral' },
  browserGeneration: 0,
  reservationNonce: 'nonce_A',
  runtimeIdentityDigest: 'a'.repeat(64),
  manager: { pid: 10, birth: 'manager-A' },
  bootScope: { kind: 'observed', value: 'boot-A', sourceIdentityDigest: 'b'.repeat(64) },
};

export const writerIdentity: JournalWriterIdentity = {
  writerId: 'writer_A',
  epoch: 0,
  kind: 'observer',
};

export function snapshot(sequence = 0, writer = writerIdentity): JournalSnapshot {
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
