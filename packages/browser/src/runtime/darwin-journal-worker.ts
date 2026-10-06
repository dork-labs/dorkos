import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import {
  JournalSnapshotSchema,
  sameProcess,
  type JournalLocation,
  type JournalSnapshot,
} from '../lifecycle/process-journal.js';
import type { ProcessIdentity } from '../configuration.js';
import { createDarwinProcessObserver } from './darwin-process-observer.js';
import {
  createDarwinOwnedChildLauncher,
  acceptsDarwinOwnedChildReturn,
  type DarwinOwnedChild,
} from './darwin-owned-child.js';
import { darwinBirth } from './darwin-process-observer.js';
import { observeDarwinJournal } from './darwin-journal-observer.js';
const identity = z
  .object({ pid: z.number().int().positive(), birth: z.string().min(1).max(128) })
  .strict();
const seedSchema = z
  .object({
    kind: z.literal('seed'),
    ownedLaunch: z.boolean().default(false),
    logicalManager: identity.optional(),
    initial: JournalSnapshotSchema,
    location: z
      .object({
        parentDirectory: z.string().max(4096),
        parentIdentity: z
          .object({
            device: z.string(),
            inode: z.string(),
            mode: z.number(),
            uid: z.number(),
            type: z.literal('directory'),
          })
          .strict(),
        binding: JournalSnapshotSchema.shape.binding,
      })
      .strict(),
    artifact: z
      .object({ path: z.string().max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    duration: z.number().positive().max(600000),
    continuous: z.boolean().default(false),
    maxGap: z.number().positive().max(10000),
  })
  .strict();
const rootSchema = z
  .object({ kind: z.literal('root'), identity, supervisor: identity.optional() })
  .strict();
const launchSchema = z
  .object({
    kind: z.literal('launch'),
    executable: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    argv: z.array(z.string().max(4096)).max(64),
  })
  .strict();
const refuseSchema = z.object({ kind: z.literal('refuse-seed') }).strict();
const returnedSchema = z
  .object({ kind: z.literal('root-returned'), nonce: z.string().min(1).max(128), identity })
  .strict();
const endSchema = z.object({ kind: z.literal('end-browser'), launchEntered: z.boolean() }).strict();
const messages = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('enrolled') }).strict(),
  z.object({ kind: z.literal('observation-fault') }).strict(),
  z
    .object({
      kind: z.literal('checkpoint'),
      sequence: z.number().int().positive().safe(),
      monotonic: z.number().int().nonnegative().safe(),
      root: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal('complete'),
      result: z.enum([
        'recorded-gone',
        'original-child-returned-observer-live',
        'campaign-closed-gapped',
        'campaign-closed',
        'retained',
        'uncertain',
      ]),
    })
    .strict(),
]);
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
  launchRoot(
    command: Readonly<{ executable: string; argv: readonly string[]; cwd: string }>
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
  const child = spawn(process.execPath, [options.workerPath, '--private-darwin-journal-worker'], {
    shell: false,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
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
  const fault = (reason: unknown) => {
    failure = true;
    refuse(reason);
    rejectCheckpoint(reason);
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
      command: Readonly<{ executable: string; argv: readonly string[]; cwd: string }>
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

/** Boot-relative monotonic clock shared by separate Node processes on this host. */
export function darwinMonotonicNow(): number {
  return Number(process.hrtime.bigint() / 1000000n);
}
async function runPrivateWorker(): Promise<void> {
  let supervisor: ProcessIdentity | undefined;
  let rootResolve!: (identity: ProcessIdentity | null) => void;
  const root = new Promise<ProcessIdentity | null>((resolve) => {
    rootResolve = resolve;
  });
  let seedResolve!: (value: unknown) => void;
  const seed = new Promise<unknown>((resolve) => {
    seedResolve = resolve;
  });
  let launchResolve!: (value: unknown) => void;
  const launch = new Promise<unknown>((resolve) => {
    launchResolve = resolve;
  });
  let ended = false,
    launchNotEntered = false;
  let seedNonce: string | undefined;
  let enrolledRoot: ProcessIdentity | undefined, returnedRoot: ProcessIdentity | undefined;
  let seeded = false,
    rooted = false,
    invalid = false;
  const receive = (value: unknown) => {
    if (refuseSchema.safeParse(value).success) {
      invalid = true;
      seeded = true;
      seedResolve(null);
      rootResolve(null);
      launchResolve(null);
      return;
    }
    if (!seeded) {
      seeded = true;
      seedResolve(value);
      return;
    }
    const returned = returnedSchema.safeParse(value);
    if (returned.success) {
      if (
        !rooted ||
        !enrolledRoot ||
        returnedRoot ||
        !seedNonce ||
        returned.data.nonce !== seedNonce ||
        !sameProcess(returned.data.identity, enrolledRoot)
      ) {
        invalid = true;
        return;
      }
      returnedRoot = Object.freeze({ ...returned.data.identity });
      return;
    }
    const end = endSchema.safeParse(value);
    if (end.success) {
      if (ended) {
        invalid = true;
        return;
      }
      ended = true;
      launchNotEntered = !end.data.launchEntered;
      if (launchNotEntered) {
        if (rooted) {
          invalid = true;
          return;
        }
        rootResolve(null);
        launchResolve(null);
      }
      return;
    }
    if (ended) {
      invalid = true;
      return;
    }
    const request = launchSchema.safeParse(value);
    if (!rooted && request.success) {
      rooted = true;
      launchResolve(request.data);
      return;
    }
    const parsed = rootSchema.safeParse(value);
    if (rooted || !parsed.success) {
      invalid = true;
      rootResolve(null);
      return;
    }
    rooted = true;
    supervisor = parsed.data.supervisor;
    enrolledRoot = Object.freeze({ ...parsed.data.identity });
    rootResolve(parsed.data.identity);
  };
  process.on('message', receive);
  const disconnected = () => {
    process.removeListener('message', receive);
    if (!seeded) seedResolve(null);
    if (!rooted) {
      rootResolve(null);
      launchResolve(null);
    }
  };
  process.once('disconnect', disconnected);
  // The original parent can refuse pre-seed custody while this module is still loading.
  if (!process.connected) disconnected();
  const send = (value: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (!process.send) {
        reject(new Error('CHANNEL_UNAVAILABLE'));
        return;
      }
      process.send(value as object, (error) => (error ? reject(error) : resolve()));
    });
  let result:
    | 'recorded-gone'
    | 'original-child-returned-observer-live'
    | 'campaign-closed-gapped'
    | 'campaign-closed'
    | 'retained'
    | 'uncertain';
  try {
    const value = seedSchema.parse(await seed);
    seedNonce = value.initial.binding.reservationNonce;
    if (
      value.initial.binding.bootScope.kind !== 'observed' ||
      value.initial.binding.bootScope.sourceIdentityDigest !== value.artifact.sha256
    )
      throw new Error('BOOT_SOURCE_UNAVAILABLE');
    const logicalManager = value.logicalManager ?? { ...value.initial.binding.manager };
    const observer = createDarwinProcessObserver(value.artifact);
    let ownedRoot: DarwinOwnedChild | null = null;
    if (value.ownedLaunch) {
      const self = (await observer.inspect([process.pid])).processes[0];
      if (self.kind !== 'present' || self.zombie) throw new Error('SUPERVISOR_UNAVAILABLE');
      const actualSelf = darwinBirth(self.identity);
      if (
        actualSelf.pid !== value.initial.binding.manager.pid ||
        actualSelf.birth !== value.initial.binding.manager.birth ||
        !value.logicalManager
      )
        throw new Error('SUPERVISOR_BINDING_MISMATCH');
      void (async () => {
        try {
          const command = launchSchema.parse(await launch);
          ownedRoot = await createDarwinOwnedChildLauncher({
            artifact: value.artifact,
            manager: logicalManager,
          }).launch({
            executable: command.executable,
            argv: command.argv,
            cwd: command.cwd,
            env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
          });
          rootResolve(await ownedRoot.identity());
        } catch {
          invalid = true;
          rootResolve(null);
        }
      })();
    }
    const rootEnd = setTimeout(() => {
      rootResolve(null);
      launchResolve(null);
    }, value.duration);
    let reportedIncomplete = false;
    try {
      result = await observeDarwinJournal({
        location: value.location,
        initial: value.initial,
        root,
        rootSupervisor: () => supervisor,
        observer,
        endBrowser: () => ended,
        originalRootReturned: () => {
          if (invalid) throw new Error('JOURNAL_ROOT_RETURN_REFUSED');
          return returnedRoot;
        },
        launchNotEntered: () => launchNotEntered,
        ...(value.ownedLaunch
          ? { logicalManager, exitingObserver: value.initial.binding.manager }
          : {}),
        monotonicNow: darwinMonotonicNow,
        pause: () => new Promise((resolve) => setTimeout(resolve, 50)),
        endMonotonic: darwinMonotonicNow() + value.duration,
        ...(value.continuous
          ? {
              continuousWindowMilliseconds: value.duration,
              onObservationFault: () => send({ kind: 'observation-fault' }),
              onCheckpoint: (checkpoint) => send({ kind: 'checkpoint', ...checkpoint }),
            }
          : {}),
        maxGap: value.maxGap,
        onEnrolled: () => send({ kind: 'enrolled' }),
        onIncompleteChildren: async (parent, batch) => {
          if (reportedIncomplete) return;
          reportedIncomplete = true;
          const bytes =
            JSON.stringify({ kind: 'incomplete-native-children', parent, batch }) + '\n';
          await new Promise<void>((resolve, reject) =>
            process.stderr.write(bytes, (error) => (error ? reject(error) : resolve()))
          );
        },
      });
    } finally {
      clearTimeout(rootEnd);
    }
    if (value.ownedLaunch) {
      const original = ownedRoot as DarwinOwnedChild | null;
      if (!original || result !== 'original-child-returned-observer-live') result = 'uncertain';
      else if (!acceptsDarwinOwnedChildReturn(original, await original.returned()))
        result = 'uncertain';
    }
    if (invalid) result = 'uncertain';
  } catch {
    result = 'uncertain';
  }
  if (process.connected) {
    try {
      await send({ kind: 'complete', result });
    } catch {
      result = 'uncertain';
    }
    process.disconnect();
  }
  process.exitCode = result === 'uncertain' ? 1 : 0;
}
if (process.argv[2] === '--private-darwin-journal-worker') void runPrivateWorker();
