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

// Actual Node IPC/pipe/child originals; durable checkpoint data here is a protocol double.
it.each(['exact', 'wrong-nonce', 'wrong-root', 'duplicate', 'reentrant-send'] as const)(
  'correlates original pre-close ACK and retains natural worker return (%s)',
  async (mode) => {
    const input = await options();
    await writeFile(
      input.workerPath,
      `
    let root, nonce, ack, ended = false;
    process.on('message', value => {
      if (value.kind === 'seed') { nonce = value.initial.binding.reservationNonce; process.send({kind:'enrolled'}); }
      if (value.kind === 'root') root = value.identity;
      if (value.kind === 'prepare-close') {
        ack = {kind:'enumeration-closed',nonce:${mode === 'wrong-nonce' ? "'other-nonce'" : 'nonce'},sequence:2,monotonic:1000,
          root:${mode === 'wrong-root' ? "{...root,birth:'other-original'}" : 'root'}};
        process.stdout.write('held');
      }
      if (value.kind === 'control-release' && ack) {
        process.send(ack);
        ${mode === 'duplicate' ? 'process.send(ack);' : ''}
        ack = null;
      }
      if (value.kind === 'end-browser' && !ended) {
        ended = true;
        process.send({kind:'complete',result:'campaign-closed'}, () => process.disconnect());
      }
    });
  `
    );
    vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => 1000000000n);
    const originals: {
      child?: ChildProcess;
      terminal?: Promise<unknown>;
      starting?: ReturnType<typeof startDarwinJournalWorker>;
      send?: ChildProcess['send'];
      joined?: Promise<void>;
    } = {};
    const release = () =>
      new Promise<void>((resolve, reject) => {
        if (!originals.child?.connected || !originals.send) {
          resolve();
          return;
        }
        originals.send({ kind: 'control-release' }, (reason: Error | null) =>
          reason ? reject(reason) : resolve()
        );
      });
    const cleanup = () =>
      (originals.joined ??= Promise.resolve().then(async () => {
        let first: { reason: unknown } | undefined;
        try {
          await release();
        } catch (reason) {
          first ??= { reason };
        }
        try {
          if (originals.child?.connected && originals.send)
            await new Promise<void>((resolve, reject) =>
              originals.send!(
                { kind: 'end-browser', launchEntered: true },
                (reason: Error | null) => (reason ? reject(reason) : resolve())
              )
            );
        } catch (reason) {
          first ??= { reason };
        }
        const joins: Promise<unknown>[] = [];
        if (originals.starting) joins.push(originals.starting.then((worker) => worker.completion));
        if (originals.terminal) joins.push(originals.terminal);
        for (const joined of await Promise.allSettled(joins))
          if (joined.status === 'rejected') first ??= { reason: joined.reason };
        if (first) throw first.reason;
      }));
    originalFinalizers.add(cleanup);
    onTestFinished(cleanup);
    controls.spawn.mockImplementation((...args: Parameters<typeof actualSpawn>) => {
      const child = actualSpawn(...args);
      originals.child = child;
      originals.terminal = once(child, 'close');
      originals.send = child.send.bind(child);
      return child;
    });
    originals.starting = startDarwinJournalWorker(input);
    const worker = await originals.starting;
    await worker.enrollRoot({ pid: 20, birth: 'darwin-bsd-start:200:0' });
    let reentrant: Promise<void> | undefined;
    let sends = 0;
    if (mode === 'reentrant-send') {
      const actualSend = worker.child.send;
      vi.spyOn(worker.child, 'send').mockImplementation(function (
        ...args: Parameters<ChildProcess['send']>
      ) {
        if (
          typeof args[0] === 'object' &&
          args[0] !== null &&
          'kind' in args[0] &&
          args[0].kind === 'prepare-close'
        ) {
          sends++;
          reentrant = worker.prepareClose();
        }
        return Reflect.apply(actualSend, worker.child, args);
      });
    }
    const held = once(worker.child.stdout!, 'data');
    const first = worker.prepareClose();
    void first.catch(() => {});
    expect(worker.prepareClose()).toBe(first);
    let settled = false;
    void first.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await held;
    expect(settled).toBe(false);
    if (mode === 'reentrant-send') {
      expect(reentrant).toBe(first);
      expect(sends).toBe(1);
    }
    await release();
    if (mode === 'wrong-nonce' || mode === 'wrong-root')
      await expect(first).rejects.toThrow('JOURNAL_PRECLOSE_REFUSED');
    else await first;
    await worker.endBrowser(true);
    expect(await worker.completion).toBe(
      mode === 'exact' || mode === 'reentrant-send' ? 'campaign-closed' : 'uncertain'
    );
    expect(worker.child.exitCode).toBe(0);
    expect(worker.child.stdout!.readableEnded).toBe(true);
    expect(worker.child.stderr!.readableEnded).toBe(true);
  }
);
