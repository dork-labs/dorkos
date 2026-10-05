import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import {
  JournalSnapshotSchema,
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
    maxGap: z.number().positive().max(10000),
  })
  .strict();
const rootSchema = z.object({ kind: z.literal('root'), identity }).strict();
const launchSchema = z
  .object({
    kind: z.literal('launch'),
    executable: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    argv: z.array(z.string().max(4096)).max(64),
  })
  .strict();
const refuseSchema = z.object({ kind: z.literal('refuse-seed') }).strict();
const endSchema = z.object({ kind: z.literal('end-browser'), launchEntered: z.boolean() }).strict();
const messages = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('enrolled') }).strict(),
  z
    .object({
      kind: z.literal('complete'),
      result: z.enum([
        'recorded-gone',
        'original-child-returned-observer-live',
        'campaign-closed',
        'retained',
        'uncertain',
      ]),
    })
    .strict(),
]);
/** Original worker remains retained by the caller until both streams and its natural terminal close. */
export interface DarwinJournalWorker {
  readonly child: ChildProcess;
  readonly location: JournalLocation;
  stderr(): Uint8Array;
  enrollRoot(root: ProcessIdentity): Promise<void>;
  endBrowser(launchEntered: boolean): Promise<void>;
  launchRoot(
    command: Readonly<{ executable: string; argv: readonly string[]; cwd: string }>
  ): Promise<void>;
  readonly completion: Promise<
    | 'recorded-gone'
    | 'original-child-returned-observer-live'
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
    maxGap: options.maxGap,
  });
  if (Buffer.byteLength(JSON.stringify(seed)) > 1048576) throw new Error('JOURNAL_UNAVAILABLE');
  const child = spawn(process.execPath, [options.workerPath, '--private-darwin-journal-worker'], {
    shell: false,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  originals.add(child);
  let failure = false,
    used = false,
    result:
      | 'recorded-gone'
      | 'original-child-returned-observer-live'
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
  child.on('message', (value) => {
    const parsed = messages.safeParse(value);
    if (!parsed.success) {
      failure = true;
      refuse(new Error('JOURNAL_UNAVAILABLE'));
      return;
    }
    if (parsed.data.kind === 'enrolled') {
      if (sawEnrolled || sawComplete) {
        failure = true;
        return;
      }
      sawEnrolled = true;
      acknowledge();
    } else {
      if (!sawEnrolled || sawComplete) {
        failure = true;
        return;
      }
      sawComplete = true;
      result = parsed.data.result;
    }
  });
  child.on('error', () => {
    failure = true;
    refuse(new Error('JOURNAL_UNAVAILABLE'));
  });
  const terminal = new Promise<number | null>((resolve) =>
    child.once('close', (code) => {
      refuse(new Error('JOURNAL_UNAVAILABLE'));
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
      failure = true;
      return;
    }
    stream.once('end', () => {
      duty.eof = true;
    });
    stream.once('close', () => {
      duty.closed = true;
    });
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 262144) failure = true;
      else if (stream === child.stderr) stderrChunks.push(Buffer.from(chunk));
    }
    if (!stream.readableEnded || !duty.eof) throw new Error('JOURNAL_PIPE_UNAVAILABLE');
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
          failure = true;
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
    location: seed.location,
    stderr: () => Buffer.concat(stderrChunks),
    completion,
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
    async enrollRoot(root: ProcessIdentity) {
      if (used || options.ownedLaunch) throw new Error('ROOT_ALREADY_ENROLLED');
      used = true;
      await send(rootSchema.parse({ kind: 'root', identity: root }));
    },
  });
}

/** Boot-relative monotonic clock shared by separate Node processes on this host. */
export function darwinMonotonicNow(): number {
  return Number(process.hrtime.bigint() / 1000000n);
}
async function runPrivateWorker(): Promise<void> {
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
    | 'campaign-closed'
    | 'retained'
    | 'uncertain';
  try {
    const value = seedSchema.parse(await seed);
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
        observer,
        endBrowser: () => ended,
        launchNotEntered: () => launchNotEntered,
        ...(value.ownedLaunch
          ? { logicalManager, exitingObserver: value.initial.binding.manager }
          : {}),
        monotonicNow: darwinMonotonicNow,
        pause: () => new Promise((resolve) => setTimeout(resolve, 50)),
        endMonotonic: darwinMonotonicNow() + value.duration,
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
