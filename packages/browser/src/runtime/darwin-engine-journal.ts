import {
  readOriginalUnknownJournalDiagnostic,
  createOriginalUnknownJournalDiagnosticSink,
} from './journal/unknown-diagnostic.js';
import { randomUUID } from 'node:crypto';
import {
  readDarwinJournalDiagnostic,
  createOriginalChildBatchDiagnosticSink,
  type DarwinJournalDiagnostic,
} from './darwin-journal-diagnostic.js';
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
  readonly binding: Readonly<JournalBinding>;
  attributeRoot(root: ProcessIdentity, supervisor?: ProcessIdentity): Promise<void>;
  /** Original durable enumeration barrier before any context/native close enters. */
  prepareClose(): Promise<void>;
  stop(
    launchEntered?: boolean
  ): Promise<
    'recorded-gone' | 'campaign-closed' | 'campaign-closed-gapped' | 'retained' | 'uncertain'
  >;
  /** Constructor-private correlated original supervisor child return, not requested shutdown. */
  rootReturned?(root: ProcessIdentity): Promise<void>;
  historyGapped(): boolean;
  custody(): Readonly<{ pending: boolean; uncertain: boolean }>;
}
const retained = new Set<DarwinJournalWorker>();

/** Await durable observer enrollment before entering the actual browser launch. */
export async function startDarwinEngineJournal(
  options: Readonly<{
    parentDirectory: string;
    binding: Omit<JournalBinding, 'bootScope'>;
    launcher?: Readonly<{
      executable: string;
      nodeRuntime: 'node' | 'electron-node';
    }>;
    workerPath: string;
    artifact: Readonly<{ path: string; sha256: string }>;
    duration: number;
    continuous?: boolean;
    maxGap: number;
    onDiagnostic?: (diagnostic: DarwinJournalDiagnostic) => void | Promise<void>;
  }>
): Promise<DarwinEngineJournal> {
  const continuous = options.continuous === true;
  const injectedDiagnostic = options.onDiagnostic;
  const onDiagnostic = injectedDiagnostic ?? createOriginalChildBatchDiagnosticSink();
  const onUnknownDiagnostic = createOriginalUnknownJournalDiagnosticSink();
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
    launcher: options.launcher,
    workerPath: options.workerPath,
    artifact: options.artifact,
    duration: options.duration,
    continuous,
    maxGap: options.maxGap,
    initial,
    location: {
      parentDirectory: options.parentDirectory,
      parentIdentity: await observeJournalDirectory(options.parentDirectory),
      binding,
    },
  });
  retained.add(worker);
  const observationKnown = worker.isObservationKnown?.bind(worker);
  let originalStderr: (() => Uint8Array) | undefined;
  try {
    originalStderr = worker.stderr.bind(worker);
  } catch (value) {
    if (injectedDiagnostic) throw value;
  }
  let historyGapped = false;
  let pending = true,
    uncertain = false,
    stopped = false,
    attributed = false;
  let attributedRoot: ProcessIdentity | undefined, rootReturnForward: Promise<void> | undefined;
  let closeReady: Promise<void> | undefined;
  const completion = worker.completion.then(
    async (result) => {
      if (rootReturnForward) {
        try {
          await rootReturnForward;
        } catch {
          uncertain = true;
        }
      }
      // Original pipes have returned. Retain the diagnostic receiver's own completion too;
      // neither its bytes nor a successful write can upgrade a refused journal.
      if (
        originalStderr &&
        onDiagnostic &&
        (uncertain || (result !== 'recorded-gone' && result !== 'campaign-closed'))
      ) {
        try {
          const originalBytes = originalStderr();
          const diagnostic = readDarwinJournalDiagnostic(originalBytes, initial.binding.journalId);
          // Parse both closed kinds from the same completed bank; duplicates stay refused.
          const unknown = readOriginalUnknownJournalDiagnostic(
            originalBytes,
            initial.binding.journalId
          );
          if (unknown) {
            try {
              await onUnknownDiagnostic(unknown);
            } catch {
              /* Optional fixed output cannot alter original refusal or custody. */
            }
          } else if (diagnostic) await onDiagnostic(diagnostic);
        } catch {
          // A newly installed default diagnostic cannot alter original custody or cleanup result.
          if (injectedDiagnostic) uncertain = true;
        }
      }
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
    binding: initial.binding,
    async attributeRoot(root: ProcessIdentity, supervisor?: ProcessIdentity) {
      if (stopped || attributed || !pending) throw new Error('JOURNAL_ROOT_REFUSED');
      attributed = true;
      try {
        const identity = ProcessIdentitySchema.parse(root);
        attributedRoot = Object.freeze({ ...identity });
        if (supervisor) await worker.enrollRoot(identity, ProcessIdentitySchema.parse(supervisor));
        else await worker.enrollRoot(identity);
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    prepareClose() {
      if (closeReady) return closeReady;
      closeReady = Promise.resolve().then(async () => {
        if (stopped || uncertain || !pending || !attributedRoot || rootReturnForward)
          throw new Error('JOURNAL_PRECLOSE_REFUSED');
        await worker.prepareClose();
      });
      void closeReady.catch(() => {
        uncertain = true;
      });
      return closeReady;
    },
    rootReturned(root: ProcessIdentity) {
      const identity = ProcessIdentitySchema.parse(root);
      if (
        !pending ||
        !attributedRoot ||
        !sameProcess(identity, attributedRoot) ||
        rootReturnForward
      ) {
        uncertain = true;
        return Promise.reject(new Error('JOURNAL_ROOT_RETURN_REFUSED'));
      }
      rootReturnForward = Promise.resolve().then(() => worker.rootReturned(identity));
      void rootReturnForward.catch(() => {
        uncertain = true;
      });
      return rootReturnForward;
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
    custody: () => {
      if (continuous && pending) {
        try {
          if (!observationKnown || observationKnown() !== true) uncertain = true;
        } catch {
          uncertain = true;
        }
      }
      return Object.freeze({ pending, uncertain });
    },
  });
}
