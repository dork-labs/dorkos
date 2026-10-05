import { randomUUID } from 'node:crypto';
import type { ProcessIdentity } from '../configuration.js';
import {
  observeJournalDirectory,
  validateJournalSnapshot,
  ProcessIdentitySchema,
  sameProcess,
  type JournalBinding,
  type JournalSnapshot,
} from '../lifecycle/process-journal.js';
import { createDarwinProcessObserver, darwinBirth } from './darwin-process-observer.js';
import {
  startDarwinJournalWorker,
  darwinMonotonicNow,
  type DarwinJournalWorker,
} from './darwin-journal-worker.js';

/** Private engine custody, not evidence granting profile release. */
export interface DarwinEngineJournal {
  attributeRoot(root: ProcessIdentity, supervisor?: ProcessIdentity): Promise<void>;
  stop(
    launchEntered?: boolean
  ): Promise<
    'recorded-gone' | 'campaign-closed' | 'campaign-closed-gapped' | 'retained' | 'uncertain'
  >;
  historyGapped(): boolean;
  custody(): Readonly<{ pending: boolean; uncertain: boolean }>;
}
const retained = new Set<DarwinJournalWorker>();

/** Await durable observer enrollment before entering the actual browser launch. */
export async function startDarwinEngineJournal(
  options: Readonly<{
    parentDirectory: string;
    binding: Omit<JournalBinding, 'bootScope'>;
    workerPath: string;
    artifact: Readonly<{ path: string; sha256: string }>;
    duration: number;
    maxGap: number;
  }>
): Promise<DarwinEngineJournal> {
  const manager = ProcessIdentitySchema.parse(options.binding.manager);
  if (manager.pid !== process.pid) throw new Error('JOURNAL_MANAGER_MISMATCH');
  const observer = createDarwinProcessObserver(options.artifact);
  const batch = await observer.inspect([manager.pid]);
  const fact = batch.processes[0];
  if (fact?.kind !== 'present' || fact.zombie || !sameProcess(darwinBirth(fact.identity), manager))
    throw new Error('JOURNAL_MANAGER_UNAVAILABLE');
  const binding = {
    ...options.binding,
    manager,
    bootScope: {
      kind: 'observed' as const,
      value: `darwin-boot:${batch.bootSeconds}:${batch.bootMicroseconds}`,
      sourceIdentityDigest: options.artifact.sha256,
    },
  };
  const time = darwinMonotonicNow();
  const window = {
    startSequence: 0,
    checkpointSequence: 0,
    endSequence: 0,
    startMonotonic: time,
    endMonotonic: time,
  };
  const initial: JournalSnapshot = validateJournalSnapshot({
    schemaVersion: 1,
    kind: 'browser-process-journal',
    provenance: 'recorded-data',
    binding,
    writer: { writerId: randomUUID(), epoch: 0, kind: 'observer' },
    sequence: 0,
    phase: 'allocated',
    observationWindow: window,
    root: { kind: 'pending' },
    retainedIdentities: [
      {
        identity: manager,
        role: 'manager',
        parent: null,
        association: null,
        currentParent: null,
        acquisitionEpoch: 0,
        firstSeenSequence: 0,
        lastSeenSequence: 0,
        relationWindow: window,
        lifecycle: 'alive',
      },
    ],
    gaps: [],
    firstCause: null,
  });
  const worker = await startDarwinJournalWorker({
    workerPath: options.workerPath,
    artifact: options.artifact,
    duration: options.duration,
    maxGap: options.maxGap,
    initial,
    location: {
      parentDirectory: options.parentDirectory,
      parentIdentity: await observeJournalDirectory(options.parentDirectory),
      binding,
    },
  });
  retained.add(worker);
  let historyGapped = false;
  let pending = true,
    uncertain = false,
    stopped = false,
    attributed = false;
  const completion = worker.completion.then(
    (result) => {
      pending = false;
      historyGapped ||= result === 'campaign-closed-gapped';
      uncertain ||=
        result !== 'campaign-closed-gapped' &&
        result !== 'recorded-gone' &&
        result !== 'campaign-closed';
      if (!uncertain) retained.delete(worker);
      return result === 'recorded-gone' ||
        result === 'campaign-closed' ||
        result === 'campaign-closed-gapped'
        ? uncertain
          ? ('uncertain' as const)
          : result
        : ('uncertain' as const);
    },
    () => {
      pending = false;
      uncertain = true;
      return 'uncertain' as const;
    }
  );
  return Object.freeze({
    async attributeRoot(root: ProcessIdentity, supervisor?: ProcessIdentity) {
      if (stopped || attributed || !pending) throw new Error('JOURNAL_ROOT_REFUSED');
      attributed = true;
      try {
        const identity = ProcessIdentitySchema.parse(root);
        if (supervisor) await worker.enrollRoot(identity, ProcessIdentitySchema.parse(supervisor));
        else await worker.enrollRoot(identity);
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    stop(launchEntered = true) {
      if (!stopped) {
        stopped = true;
        void worker.endBrowser(launchEntered).catch(() => {
          uncertain = true;
        });
      }
      return completion;
    },
    historyGapped: () => historyGapped,
    custody: () => Object.freeze({ pending, uncertain }),
  });
}
