import type { RecordedProfileRecovery } from '../configuration.js';
import {
  readJournal,
  sameProcess,
  sameJournalBinding,
  type JournalLocation,
  type JournalSnapshot,
} from '../lifecycle/process-journal.js';
import {
  reconcileRecordedGeneration,
  type RecordedObservationBatch,
  type RecordedReconciliation,
} from '../lifecycle/process-reconciliation.js';
import {
  darwinBirth,
  type DarwinProcessBatch,
  type DarwinProcessObserver,
} from './darwin-process-observer.js';

/** Project native facts onto every retained original; no current-parent tree rediscovers lost children. */
export function reconcileDarwinBatch(
  snapshot: JournalSnapshot,
  batch: DarwinProcessBatch,
  sourceDigest: string,
  start: number,
  end: number
): RecordedReconciliation {
  const facts = new Map(
    batch.processes.map((fact) => [fact.kind === 'present' ? fact.identity.pid : fact.pid, fact])
  );
  const statuses: RecordedObservationBatch['statuses'] = snapshot.retainedIdentities.map(
    ({ identity }) => {
      const fact = facts.get(identity.pid);
      if (!fact || fact.kind === 'unknown')
        return { kind: 'unknown', identity, cause: 'identity-unknown' };
      if (fact.kind === 'absent')
        return {
          kind: 'original-gone',
          identity,
          absence: {
            kind: 'explicit-original-absent',
            queriedPid: identity.pid,
            queriedBirth: identity.birth,
          },
        };
      const observed = darwinBirth(fact.identity);
      if (!sameProcess(identity, observed))
        return { kind: 'replacement-observed', identity, replacement: observed };
      if (fact.zombie) return { kind: 'unknown', identity, cause: 'custody-pending' };
      const parent = facts.get(fact.parentPid);
      return {
        kind: 'original-alive',
        identity,
        currentParent: parent?.kind === 'present' ? darwinBirth(parent.identity) : null,
      };
    }
  );
  const sequence = snapshot.sequence + 1;
  return reconcileRecordedGeneration(snapshot, snapshot.binding, {
    journalId: snapshot.binding.journalId,
    browserGeneration: snapshot.binding.browserGeneration,
    reservationNonce: snapshot.binding.reservationNonce,
    bootScope: {
      kind: 'observed',
      value: `darwin-boot:${batch.bootSeconds}:${batch.bootMicroseconds}`,
      sourceIdentityDigest: sourceDigest,
    },
    writerEpoch: snapshot.writer.epoch,
    window: {
      startSequence: sequence,
      checkpointSequence: sequence,
      endSequence: sequence,
      startMonotonic: start,
      endMonotonic: end,
    },
    statuses,
  });
}

/** Compose a trusted journal locator with the real native receiver; this never returns a reuse permit. */
export function createDarwinRecordedRecovery(
  options: Readonly<{
    locate: (selector: Parameters<RecordedProfileRecovery>[0]) => Promise<JournalLocation | null>;
    observer: DarwinProcessObserver;
    sourceDigest: string;
    monotonicNow: () => number;
  }>
): RecordedProfileRecovery {
  return async (selector) => {
    try {
      const location = await options.locate(selector);
      if (
        !location ||
        location.binding.profile.kind !== 'persistent' ||
        location.binding.profile.profileId !== selector.profileId ||
        location.binding.reservationNonce !== selector.reservationNonce ||
        !sameProcess(location.binding.manager, selector.manager)
      )
        return 'unknown';
      const original = await readJournal(location);
      if (
        original.state !== 'valid-recorded-data' ||
        !sameJournalBinding(original.snapshot.binding, location.binding)
      )
        return 'unknown';
      if (
        selector.browser &&
        (original.snapshot.root.kind !== 'attributed' ||
          !sameProcess(original.snapshot.root.identity, selector.browser))
      )
        return 'unknown';
      const pids = [
        ...new Set(original.snapshot.retainedIdentities.map((entry) => entry.identity.pid)),
      ];
      const start = options.monotonicNow();
      const batch = await options.observer.inspect(pids);
      const end = options.monotonicNow();
      const current = await readJournal(location);
      if (
        current.state !== 'valid-recorded-data' ||
        current.digest !== original.digest ||
        current.identity.device !== original.identity.device ||
        current.identity.inode !== original.identity.inode
      )
        return 'unknown';
      return reconcileDarwinBatch(original.snapshot, batch, options.sourceDigest, start, end)
        .recordedDisposition;
    } catch {
      return 'unknown';
    }
  };
}
