import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
afterEach(async () => {
  vi.restoreAllMocks();
  controls.spawn.mockReset();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
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
          if (mode === 'rejected-drain') throw new Error('actual consumer drain failure');
          return undefined;
        };
      }
      return child;
    });
    await expect(startDarwinJournalWorker(input)).rejects.toThrow('JOURNAL_UNAVAILABLE');
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
