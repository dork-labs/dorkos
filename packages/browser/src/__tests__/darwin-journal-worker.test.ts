import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { observeJournalDirectory, type JournalSnapshot } from '../lifecycle/process-journal.js';
import { startDarwinJournalWorker } from '../runtime/darwin-journal-worker.js';

const controls = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: controls.spawn,
}));
const { spawn: actualSpawn } =
  await vi.importActual<typeof import('node:child_process')>('node:child_process');
const directories: string[] = [];
const originalFinalizers = new Set<() => Promise<void>>();
afterEach(async () => {
  // Also join before globals/files restore: onTestFinished may run after afterEach.
  const joined = await Promise.allSettled([...originalFinalizers].map((finish) => finish()));
  vi.restoreAllMocks();
  controls.spawn.mockReset();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  const failed = joined.find((entry) => entry.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
});

async function options() {
  const parentDirectory = await realpath(await mkdtemp(join(tmpdir(), 'journal-pipe-custody-')));
  directories.push(parentDirectory);
  const workerPath = join(parentDirectory, 'worker.mjs');
  // A genuine separate original process, with real IPC EOF, output pipes and
  // natural exit. It refuses startup before a caller can receive its handle.
  await writeFile(
    workerPath,
    `
    process.on('message', value => {
      if (value.kind === 'seed') process.send({kind:'invalid-startup'});
      else if (value.kind === 'refuse-seed') {
        process.stdout.write('original stdout');
        process.stderr.write('original stderr');
        process.disconnect();
      }
    });
  `
  );
  const window = {
    startSequence: 0,
    checkpointSequence: 0,
    endSequence: 0,
    startMonotonic: 10,
    endMonotonic: 10,
  };
  const manager = { pid: process.pid, birth: 'darwin-bsd-start:100:0' };
  const binding = {
    journalId: 'pipe-custody',
    browserId: 'browser',
    browserGeneration: 0,
    reservationNonce: 'nonce',
    runtimeIdentityDigest: 'a'.repeat(64),
    profile: { kind: 'ephemeral' as const },
    manager,
    bootScope: {
      kind: 'observed' as const,
      value: 'darwin-boot:1:0',
      sourceIdentityDigest: 'b'.repeat(64),
    },
  };
  const initial: JournalSnapshot = {
    schemaVersion: 1,
    kind: 'browser-process-journal',
    provenance: 'recorded-data',
    binding,
    writer: { writerId: 'observer', epoch: 0, kind: 'observer' },
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
  };
  return {
    workerPath,
    initial,
    location: {
      parentDirectory,
      parentIdentity: await observeJournalDirectory(parentDirectory),
      binding,
    },
    artifact: { path: '/unused/no-native-observer', sha256: 'c'.repeat(64) },
    duration: 1000,
    maxGap: 100,
  };
}

it.each(['healthy', 'rejected-drain', 'premature-drain-return'] as const)(
  'keeps startup original custody unless both real pipes return (%s)',
  async (mode) => {
    const input = await options();
    const drainError = new Error('actual consumer drain failure');
    let child!: ChildProcess;
    let terminal!: Promise<unknown>;
    const actualAdd = Set.prototype.add;
    const originalRegistries: Set<unknown>[] = [];
    // Capture the actual private registry when the exact spawned original enters it.
    // No production/test export, surrogate receipt or weak-reference timing oracle.
    vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (child && value === child) originalRegistries.push(this);
      return actualAdd.call(this, value);
    });
    controls.spawn.mockImplementation((...args: Parameters<typeof actualSpawn>) => {
      child = actualSpawn(...args);
      terminal = once(child, 'close');
      if (mode !== 'healthy') {
        // Fault the consumer's drain, not native process events or close counters.
        // Actual Node pipes remain attached and the child returns naturally.
        child.stdout![Symbol.asyncIterator] = async function* (): AsyncGenerator<never, undefined> {
          if (mode === 'rejected-drain') throw drainError;
          return undefined;
        };
      }
      return child;
    });
    const original = startDarwinJournalWorker(input);
    if (mode === 'rejected-drain') await expect(original).rejects.toBe(drainError);
    else
      await expect(original).rejects.toThrow(
        mode === 'healthy' ? 'JOURNAL_UNAVAILABLE' : 'JOURNAL_PIPE_UNAVAILABLE'
      );
    await terminal;
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(child.connected).toBe(false);
    expect(originalRegistries).toHaveLength(1);
    expect(originalRegistries[0].has(child)).toBe(mode !== 'healthy');
    expect(child.stdout!.readableEnded).toBe(true);
    expect(child.stderr!.readableEnded).toBe(true);
  }
);

// Real original Node process, IPC, pipes and terminal; checkpoint facts are explicit
// source doubles, not a native Darwin sweep or sustained-native acceptance.
it.each(['freshness', 'wrong-root', 'rejected-drain', 'premature-close'] as const)(
  'fences continuous original worker custody while remaining originals are held (%s)',
  async (mode) => {
    const input = await options();
    await writeFile(
      input.workerPath,
      `
      process.on('message', value => {
        if (value.kind === 'seed') process.send({kind:'enrolled'});
        if (value.kind === 'root') process.send({kind:'checkpoint',sequence:1,monotonic:1000,
          root: ${mode === 'wrong-root' ? "{pid:value.identity.pid,birth:'other-root'}" : 'value.identity'}});
        if (value.kind === 'end-browser') {
          process.send({kind:'complete',result:'campaign-closed'}, () => process.disconnect());
        }
        if (value.kind === 'control-close') process.disconnect();
      });
    `
    );
    let now = 1000;
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => BigInt(now) * 1000000n);
    let child: ChildProcess | undefined;
    let terminal: Promise<unknown> | undefined;
    let originalSend: ChildProcess['send'] | undefined;
    const originals: { starting?: ReturnType<typeof startDarwinJournalWorker> } = {};
    let worker: Awaited<ReturnType<typeof startDarwinJournalWorker>> | undefined;
    let firstFailure: { reason: unknown } | undefined;
    const failed = (reason: unknown) => {
      firstFailure ??= { reason };
    };
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      let resolve!: () => void, reject!: (reason: unknown) => void;
      cleanupPromise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      try {
        release();
      } catch (reason) {
        failed(reason);
      }
      try {
        child?.stdout?.resume();
      } catch (reason) {
        failed(reason);
      }
      const joins: Promise<unknown>[] = [];
      try {
        if (child?.connected && originalSend)
          joins.push(
            new Promise<void>((yes, no) =>
              originalSend!({ kind: 'end-browser', launchEntered: true }, (reason: Error | null) =>
                reason ? no(reason) : yes()
              )
            )
          );
      } catch (reason) {
        failed(reason);
      }
      if (terminal) joins.push(terminal);
      if (originals.starting)
        joins.push(
          originals.starting.then(async (actual) => {
            worker = actual;
            await actual.completion;
          })
        );
      void Promise.allSettled(joins).then((results) => {
        for (const result of results) if (result.status === 'rejected') failed(result.reason);
        originalFinalizers.delete(cleanup);
        if (firstFailure) reject(firstFailure.reason);
        else resolve();
      });
      return cleanupPromise;
    };
    // Register before the first original child can be acquired, including startup failures/timeouts.
    originalFinalizers.add(cleanup);
    onTestFinished(cleanup);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rejected!: () => void;
    const enteredRejection = new Promise<void>((resolve) => {
      rejected = resolve;
    });
    controls.spawn.mockImplementation((...args: Parameters<typeof actualSpawn>) => {
      child = actualSpawn(...args);
      terminal = once(child, 'close');
      originalSend = child.send.bind(child);
      if (mode === 'rejected-drain') {
        child.stdout![Symbol.asyncIterator] = async function* (): AsyncGenerator<never, undefined> {
          await held;
          rejected();
          throw new Error('original drain rejected while stderr and child held');
        };
      } else if (mode === 'premature-close') {
        const originalIterator = child.stdout![Symbol.asyncIterator].bind(child.stdout!);
        child.stdout![Symbol.asyncIterator] = async function* (): AsyncGenerator<
          unknown,
          undefined,
          unknown
        > {
          yield* originalIterator();
          await held;
          return undefined;
        };
      }
      return child;
    });
    const starting = (originals.starting = startDarwinJournalWorker({
      ...input,
      continuous: true,
    }));
    worker = await starting;
    let returned = false;
    void worker.completion.then(() => {
      returned = true;
    });
    try {
      const root = { pid: 123, birth: 'exact-root' };
      if (mode === 'wrong-root') {
        await expect(worker.enrollRoot(root)).rejects.toThrow('JOURNAL_CHECKPOINT_REFUSED');
        expect(worker.isObservationKnown()).toBe(false);
      } else {
        await worker.enrollRoot(root);
        expect(worker.isObservationKnown()).toBe(true);
        if (mode === 'freshness') {
          now += input.maxGap + 1;
          expect(worker.isObservationKnown()).toBe(false);
          now = 1000;
          expect(worker.isObservationKnown()).toBe(false); // Clock restoration cannot heal custody.
        } else if (mode === 'rejected-drain') {
          release();
          await enteredRejection;
          await Promise.resolve();
          expect(worker.isObservationKnown()).toBe(false);
        } else {
          originalSend!({ kind: 'control-close' });
          await terminal;
          expect(worker.isObservationKnown()).toBe(false);
        }
      }
      expect(returned).toBe(false); // Original terminal/other drain remains joined.
    } catch (reason) {
      failed(reason);
    } finally {
      await cleanup();
    }
    if (firstFailure) throw firstFailure.reason;
    expect(await worker.completion).toBe('uncertain');
  }
);
