import { createSupervisorUncertaintyDiagnostic } from './supervisor-uncertainty-diagnostic.js';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  sameProcess,
  type JournalLocation,
  type JournalSnapshot,
} from '../lifecycle/process-journal.js';
import type { ProcessIdentity } from '../configuration.js';
import {
  identity,
  seedSchema,
  rootSchema,
  launchSchema,
  returnedSchema,
  prepareCloseSchema,
  messages,
} from './journal/worker-protocol.js';
import { createDarwinProcessObserver, darwinBirth } from './darwin-process-observer.js';
import { runPrivateWorker } from './journal/worker-entry.js';
export { darwinMonotonicNow } from './journal/worker-protocol.js';

/** Original worker remains retained by the caller until both streams and its natural terminal close. */
export interface DarwinJournalWorker {
  /** Exact original message/pipe/process custody, with sticky observation refusal. */
  isObservationKnown(): boolean;
  readonly child: ChildProcess;
  readonly location: JournalLocation;
  stderr(): Uint8Array;
  enrollRoot(root: ProcessIdentity, supervisor?: ProcessIdentity): Promise<void>;
  endBrowser(launchEntered: boolean): Promise<void>;
  rootReturned(root: ProcessIdentity): Promise<void>;
  /** Retains the exact original pre-close ACK, not a requested end-browser proof. */
  prepareClose(): Promise<void>;
  launchRoot(
    command: Readonly<{
      executable: string;
      argv: readonly string[];
      cwd: string;
    }>
  ): Promise<void>;
  readonly completion: Promise<
    | 'recorded-gone'
    | 'original-child-returned-observer-live'
    | 'campaign-closed-gapped'
    | 'campaign-closed'
    | 'retained'
    | 'uncertain'
  >;
}
const originals = new Set<ChildProcess>();
/** Start the private packaged supervisor before browser launch; it has its own process lifetime. */
export async function startDarwinJournalWorker(
  options: Readonly<{
    launcher?: Readonly<{
      executable: string;
      nodeRuntime: 'node' | 'electron-node';
    }>;
    workerPath: string;
    location: JournalLocation;
    initial: JournalSnapshot;
    artifact: Readonly<{ path: string; sha256: string }>;
    duration: number;
    continuous?: boolean;
    maxGap: number;
    ownedLaunch?: boolean;
  }>
): Promise<DarwinJournalWorker> {
  const seed = seedSchema.parse({
    kind: 'seed',
    ownedLaunch: options.ownedLaunch ?? false,
    location: options.location,
    initial: options.initial,
    artifact: options.artifact,
    duration: options.duration,
    continuous: options.continuous ?? false,
    maxGap: options.maxGap,
  });
  if (Buffer.byteLength(JSON.stringify(seed)) > 1048576) throw new Error('JOURNAL_UNAVAILABLE');
  // Capture the original host boot clock before callbacks can replace its receiver.
  const originalClock = process.hrtime.bigint.bind(process.hrtime);
  const monotonicNow = () => Number(originalClock() / 1000000n);
  if (seed.continuous && seed.ownedLaunch) throw new Error('CONTINUOUS_ROOT_UNSUPPORTED');
  const child = spawn(
    options.launcher?.executable ?? process.execPath,
    [options.workerPath, '--private-darwin-journal-worker'],
    {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        ...(options.launcher?.nodeRuntime === 'electron-node' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    }
  );
  originals.add(child);
  let failure = false,
    used = false,
    returnedSent = false,
    result:
      | 'recorded-gone'
      | 'original-child-returned-observer-live'
      | 'campaign-closed-gapped'
      | 'campaign-closed'
      | 'retained'
      | 'uncertain' = 'uncertain';
  let acknowledge!: (value?: unknown) => void, refuse!: (error: unknown) => void;
  const enrolled = new Promise<void>((resolve, reject) => {
    acknowledge = () => resolve();
    refuse = reject;
  });
  void enrolled.catch(() => {});
  let sawEnrolled = false,
    sawComplete = false;
  let expectedRoot: ProcessIdentity | undefined;
  let checkpoint: { sequence: number; monotonic: number } | undefined;
  let acceptCheckpoint!: () => void, rejectCheckpoint!: (reason: unknown) => void;
  const firstCheckpoint = new Promise<void>((resolve, reject) => {
    acceptCheckpoint = resolve;
    rejectCheckpoint = reject;
  });
  void firstCheckpoint.catch(() => {});
  let closeRequested = false,
    closeAcknowledged = false;
  let resolveClose!: () => void, rejectClose!: (reason: unknown) => void;
  const closeReady = new Promise<void>((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });
  void closeReady.catch(() => {});
  let closeSend: Promise<void> | undefined;
  const identityDiagnostic = createSupervisorUncertaintyDiagnostic();
  const fault = (reason: unknown) => {
    failure = true;
    refuse(reason);
    rejectCheckpoint(reason);
    rejectClose(reason);
  };
  const observationKnown = () => {
    if (failure || !sawEnrolled || sawComplete) return false;
    if (!seed.continuous) return true;
    if (!checkpoint) return false;
    const now = monotonicNow();
    if (
      !Number.isSafeInteger(now) ||
      now < checkpoint.monotonic ||
      now - checkpoint.monotonic > seed.maxGap
    ) {
      fault(new Error('JOURNAL_OBSERVATION_STALE'));
      return false;
    }
    return true;
  };
  child.on('message', (value) => {
    const parsed = messages.safeParse(value);
    if (!parsed.success) {
      fault(new Error('JOURNAL_UNAVAILABLE'));
      return;
    }
    if (parsed.data.kind === 'observation-fault') {
      fault(new Error('JOURNAL_OBSERVATION_REFUSED'));
      if (parsed.data.reason) {
        identityDiagnostic.note(parsed.data.reason);
        identityDiagnostic.emit();
      }
    } else if (parsed.data.kind === 'enumeration-closed') {
      const next = parsed.data;
      const now = monotonicNow();
      if (
        !closeRequested ||
        closeAcknowledged ||
        failure ||
        sawComplete ||
        !sawEnrolled ||
        !expectedRoot ||
        next.nonce !== seed.initial.binding.reservationNonce ||
        !sameProcess(next.root, expectedRoot) ||
        !Number.isSafeInteger(now) ||
        next.monotonic > now ||
        now - next.monotonic > seed.maxGap ||
        (checkpoint &&
          (next.sequence <= checkpoint.sequence || next.monotonic < checkpoint.monotonic))
      ) {
        fault(new Error('JOURNAL_PRECLOSE_REFUSED'));
        return;
      }
      closeAcknowledged = true;
      resolveClose();
    } else if (parsed.data.kind === 'checkpoint') {
      const next = parsed.data;
      const now = monotonicNow();
      if (
        !seed.continuous ||
        !sawEnrolled ||
        sawComplete ||
        failure ||
        !expectedRoot ||
        expectedRoot.pid !== next.root.pid ||
        expectedRoot.birth !== next.root.birth ||
        (checkpoint &&
          (!observationKnown() ||
            next.sequence <= checkpoint.sequence ||
            next.monotonic < checkpoint.monotonic)) ||
        !Number.isSafeInteger(now) ||
        next.monotonic > now ||
        now - next.monotonic > seed.maxGap
      ) {
        fault(new Error('JOURNAL_CHECKPOINT_REFUSED'));
        return;
      }
      checkpoint = { sequence: next.sequence, monotonic: next.monotonic };
      acceptCheckpoint();
    } else if (parsed.data.kind === 'enrolled') {
      if (sawEnrolled || sawComplete) {
        fault(new Error('JOURNAL_UNAVAILABLE'));
        return;
      }
      sawEnrolled = true;
      acknowledge();
    } else {
      if (!sawEnrolled || sawComplete) {
        fault(new Error('JOURNAL_UNAVAILABLE'));
        return;
      }
      sawComplete = true;
      if (seed.continuous && !checkpoint) fault(new Error('JOURNAL_CHECKPOINT_REFUSED'));
      rejectCheckpoint(new Error('JOURNAL_OBSERVATION_ENDED'));
      if (!closeAcknowledged) rejectClose(new Error('JOURNAL_PRECLOSE_REFUSED'));
      result = parsed.data.result;
    }
  });
  child.on('error', () => {
    fault(new Error('JOURNAL_UNAVAILABLE'));
  });
  const terminal = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      if (!sawComplete) fault(new Error('JOURNAL_UNAVAILABLE'));
      rejectCheckpoint(new Error('JOURNAL_OBSERVATION_ENDED'));
      if (!closeAcknowledged) rejectClose(new Error('JOURNAL_PRECLOSE_REFUSED'));
      resolve(code);
    })
  );
  const stderrChunks: Uint8Array[] = [];
  const pipeReturns = [
    { eof: false, closed: false },
    { eof: false, closed: false },
  ];
  const drain = async (stream: ChildProcess['stdout'], duty: (typeof pipeReturns)[number]) => {
    if (!stream) {
      fault(new Error('JOURNAL_PIPE_UNAVAILABLE'));
      return;
    }
    stream.once('error', (reason) => fault(reason));
    stream.once('end', () => {
      duty.eof = true;
    });
    stream.once('close', () => {
      duty.closed = true;
      if (!duty.eof) fault(new Error('JOURNAL_PIPE_UNAVAILABLE'));
    });
    try {
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 262144) fault(new Error('JOURNAL_PIPE_UNAVAILABLE'));
        else if (stream === child.stderr) stderrChunks.push(Buffer.from(chunk));
      }
      if (!stream.readableEnded || !duty.eof) throw new Error('JOURNAL_PIPE_UNAVAILABLE');
    } catch (reason) {
      fault(reason);
      throw reason;
    }
  };
  const streams = Promise.allSettled([
    drain(child.stdout, pipeReturns[0]),
    drain(child.stderr, pipeReturns[1]),
  ]);
  const completion = (async () => {
    const [code, closed] = await Promise.all([terminal, streams]);
    // A rejected/abandoned drain is not an original-pipe return. In particular,
    // startup may throw before any caller receives the handle: keep its child and
    // both original streams strongly owned rather than silently dropping custody.
    const pipesReturned =
      closed.every((value) => value.status === 'fulfilled') &&
      pipeReturns.every((duty) => duty.eof && duty.closed);
    if (pipesReturned) originals.delete(child);
    return failure || code !== 0 || !pipesReturned || !sawComplete
      ? ('uncertain' as const)
      : result;
  })();
  const send = (value: unknown) =>
    new Promise<void>((resolve, reject) =>
      child.send(value as object, (error) => {
        if (error) {
          fault(error);
          reject(error);
        } else resolve();
      })
    );
  try {
    if (options.ownedLaunch) {
      const batch = await createDarwinProcessObserver(options.artifact).inspect([child.pid!]);
      const self = batch.processes[0];
      if (
        self.kind !== 'present' ||
        self.zombie ||
        self.parentPid !== process.pid ||
        seed.initial.binding.bootScope.kind !== 'observed' ||
        seed.initial.binding.bootScope.value !==
          `darwin-boot:${batch.bootSeconds}:${batch.bootMicroseconds}`
      )
        throw new Error('SUPERVISOR_UNAVAILABLE');
      seed.logicalManager = { ...seed.initial.binding.manager };
      const actualSelf = darwinBirth(self.identity);
      seed.initial.binding.manager = actualSelf;
      seed.location.binding.manager = actualSelf;
      seed.initial.retainedIdentities[0].identity = actualSelf;
    }
    await send(seed);
    await enrolled;
  } catch (error) {
    // Let the exact original worker refuse its seed and close its IPC end naturally.
    // Parent-side disconnect skips Node's aggregate IPC close accounting; no synthetic close is issued.
    // Its original pipes and terminal remain retained until actual EOF and natural close.
    try {
      if (child.connected) await send({ kind: 'refuse-seed' });
    } catch {
      failure = true;
    }
    try {
      await completion;
    } catch {
      failure = true;
    }
    throw error;
  }
  return Object.freeze({
    child,
    isObservationKnown: observationKnown,
    location: seed.location,
    stderr: () => Buffer.concat(stderrChunks),
    completion,
    prepareClose() {
      if (closeSend) return closeSend;
      closeRequested = true;
      closeSend = Promise.resolve().then(async () => {
        if (failure || sawComplete || returnedSent || !expectedRoot)
          throw new Error('JOURNAL_PRECLOSE_REFUSED');
        await send(
          prepareCloseSchema.parse({
            kind: 'prepare-close',
            nonce: seed.initial.binding.reservationNonce,
            identity: expectedRoot,
          })
        );
        await closeReady;
      });
      void closeSend.catch(fault);
      return closeSend;
    },
    async rootReturned(root: ProcessIdentity) {
      const original = identity.parse(root);
      if (failure || returnedSent || !expectedRoot || !sameProcess(original, expectedRoot))
        throw new Error('JOURNAL_ROOT_RETURN_REFUSED');
      returnedSent = true;
      await send(
        returnedSchema.parse({
          kind: 'root-returned',
          nonce: seed.initial.binding.reservationNonce,
          identity: original,
        })
      );
    },
    async endBrowser(launchEntered: boolean) {
      await send({ kind: 'end-browser', launchEntered });
    },
    async launchRoot(
      command: Readonly<{
        executable: string;
        argv: readonly string[];
        cwd: string;
      }>
    ) {
      if (!options.ownedLaunch || used) throw new Error('ROOT_ALREADY_ENROLLED');
      used = true;
      await send(launchSchema.parse({ kind: 'launch', ...command }));
    },
    async enrollRoot(root: ProcessIdentity, supervisor?: ProcessIdentity) {
      if (used || options.ownedLaunch) throw new Error('ROOT_ALREADY_ENROLLED');
      used = true;
      expectedRoot = identity.parse(root);
      await send(
        rootSchema.parse({
          kind: 'root',
          identity: expectedRoot,
          ...(supervisor ? { supervisor } : {}),
        })
      );
      if (seed.continuous) await firstCheckpoint;
    },
  });
}

if (process.argv[2] === '--private-darwin-journal-worker') void runPrivateWorker();
