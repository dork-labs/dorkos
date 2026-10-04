import { registerFixtureRecord, fakePage } from './parent-fixture.js';
import { composeInput } from '../lifecycle/input-owner.js';
import type { EngineConfiguration } from '../configuration.js';
import { createPointerLedger } from '../tabs/pointer.js';
import { unavailableDiagnostics } from '../tabs/diagnostics.js';
import { createDiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import { createBrowserLifetime } from '../lifecycle/ownership.js';
import { it, expect, beforeAll, afterAll, onTestFinished } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, access, rm, rename, mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext } from 'playwright-core';
import { closeRecord } from '../lifecycle/close.js';
import type { BrowserRecord } from '../lifecycle/records.js';
import { hostIdentity } from '../runtime/host-identity.js';
import { ownDirectory } from '../profiles/owned-directory.js';
import { realpathSync } from 'node:fs';
import { parseBrowserId, parseTabId } from '../ids.js';
import { configuration } from './lifecycle-fixture.js';

// PROPOSED fixture-only limits: six serial cases, original 5000 work + 5000 cleanup each.
// They bound waits, not physical disappearance or cancellation; execution is still HELD.
const CASE_WORK_MS = 5000;
const CASE_TOTAL_MS = 10000;
const TOTAL_FIXTURE_MS = 6 * CASE_TOTAL_MS;
let fixtureEnd = 0;
let fixtureBlocked = false;
let childAttempts = 0;
let acquiredChildren = 0;
let directoryAttempts = 0;
let acquiredDirectories = 0;
let replacementAttempts = 0;
let acquiredReplacements = 0;
const closureRows: object[] = [];
beforeAll(() => {
  fixtureEnd = performance.now() + TOTAL_FIXTURE_MS;
});

interface DirectoryDuty {
  path?: string;
  identity?: Readonly<{ dev: number; ino: number }>;
  pending: boolean;
  removed: boolean;
  lateIdentity?: boolean;
}
interface PhysicalFixture {
  child: { identity: NonNullable<ReturnType<typeof hostIdentity>>; stop(): Promise<void> };
  root: string;
  assertWork(): void;
  replaceDirectory(): Promise<string>;
}

async function bounded<T>(operation: Promise<T>, end: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let result: T;
    try {
      result = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error(code)), Math.max(0, end - performance.now()));
        }),
      ]);
    } catch (error) {
      const rejectedAt = performance.now();
      if (!Number.isFinite(rejectedAt) || rejectedAt >= end) throw Error(code, { cause: error });
      throw error;
    }
    const fulfilledAt = performance.now();
    if (!Number.isFinite(fulfilledAt) || fulfilledAt >= end) throw Error(code);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function physicalCase(name: string, body: (owned: PhysicalFixture) => Promise<void>): void {
  it.sequential(
    name,
    async () => {
      if (fixtureBlocked || performance.now() >= fixtureEnd)
        throw Error('FIXTURE_ADMISSION_CLOSED');
      const entered = performance.now();
      const workEnd = Math.min(fixtureEnd, entered + CASE_WORK_MS);
      const cleanupEnd = Math.min(fixtureEnd, entered + CASE_TOTAL_MS);
      const directories: DirectoryDuty[] = [];
      let child: ReturnType<typeof spawn> | undefined;
      let exitObserved = false;
      let spawned = false;
      let spawnReady: Promise<void> | undefined;
      let workSettled = false;
      let childClosureObserved = false;
      let stopPromise: Promise<void> | undefined;
      let finishPromise: Promise<void> | undefined;
      let identity: NonNullable<ReturnType<typeof hostIdentity>> | undefined;
      let resolveExit!: () => void;
      let rejectExit!: (error: unknown) => void;
      const exited = new Promise<void>((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });
      // Suppress only unhandled rejection reporting; the owned stop still observes the original promise.
      void exited.catch(() => {});
      const ensureAcquisition = () => {
        const observedAt = performance.now();
        if (
          fixtureBlocked ||
          finishPromise ||
          !Number.isFinite(observedAt) ||
          observedAt >= workEnd
        )
          throw Error('FIXTURE_ACQUISITION_REFUSED');
      };
      const stop = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        stopPromise = new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        });
        // Publish the exact shared handle before any observation or cooperative signal.
        void (async () => {
          if (!child) return;
          if (!spawned && spawnReady)
            await bounded(spawnReady, cleanupEnd, 'OWNED_CHILD_START_UNVERIFIED');
          if (!exitObserved && spawned && child.exitCode === null && child.signalCode === null) {
            if (performance.now() >= cleanupEnd) throw Error('OWNED_CHILD_STOP_END_EXPIRED');
            if (!child.kill('SIGTERM')) throw Error('OWNED_CHILD_STOP_UNVERIFIED');
          }
          await bounded(exited, cleanupEnd, 'OWNED_CHILD_EXIT_UNVERIFIED');
          if (performance.now() >= cleanupEnd) throw Error('OWNED_CHILD_OBSERVATION_END_EXPIRED');
          if (identity && hostIdentity(identity.pid) !== null)
            throw Error('OWNED_CHILD_IDENTITY_NOT_GONE');
          const settledAt = performance.now();
          if (!Number.isFinite(settledAt) || settledAt >= cleanupEnd)
            throw Error('OWNED_CHILD_OBSERVATION_END_EXPIRED');
        })().then(resolve, reject);
        return stopPromise;
      };
      const finish = (): Promise<void> => {
        if (finishPromise) return finishPromise;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        finishPromise = new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        });
        void (async () => {
          const failures: unknown[] = [];
          try {
            await stop();
            childClosureObserved = true;
          } catch (error) {
            failures.push(error);
          }
          for (const duty of directories) {
            try {
              if (
                !workSettled ||
                duty.pending ||
                duty.lateIdentity ||
                !duty.path ||
                !duty.identity ||
                !exitObserved ||
                !childClosureObserved
              )
                throw Error('OWNED_DIRECTORY_CUSTODY_UNVERIFIED');
              if (duty.removed) continue;
              try {
                if (performance.now() >= cleanupEnd) throw Error('DIRECTORY_CLOSE_END_EXPIRED');
                const current = await bounded(
                  lstat(duty.path),
                  cleanupEnd,
                  'DIRECTORY_OBSERVATION_UNVERIFIED'
                );
                if (
                  !current.isDirectory() ||
                  current.isSymbolicLink() ||
                  current.dev !== duty.identity.dev ||
                  current.ino !== duty.identity.ino
                )
                  throw Error('OWNED_DIRECTORY_REPLACED');
                if (performance.now() >= cleanupEnd) throw Error('DIRECTORY_CLOSE_END_EXPIRED');
                await bounded(
                  rm(duty.path, { recursive: true, force: false }),
                  cleanupEnd,
                  'DIRECTORY_CLOSE_UNVERIFIED'
                );
                if (performance.now() >= cleanupEnd) throw Error('DIRECTORY_ABSENCE_END_EXPIRED');
                await bounded(lstat(duty.path), cleanupEnd, 'DIRECTORY_ABSENCE_UNVERIFIED');
                throw Error('OWNED_DIRECTORY_STILL_PRESENT');
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
              duty.removed = true;
            } catch (error) {
              failures.push(error);
            }
          }
          const settledAt = performance.now();
          if (!Number.isFinite(settledAt) || settledAt >= cleanupEnd)
            failures.push(Error('PHYSICAL_FIXTURE_FINAL_END_EXPIRED'));
          if (failures.length) {
            fixtureBlocked = true;
            throw new AggregateError(failures, 'PHYSICAL_FIXTURE_CLEANUP_UNVERIFIED');
          }
        })().then(resolve, reject);
        return finishPromise;
      };
      // Register the complete cleanup closure before child/identity/directory acquisition.
      onTestFinished(() => finish());
      const ownDirectoryDuty = async (path: string, duty: DirectoryDuty): Promise<string> => {
        duty.path = path;
        if (performance.now() >= workEnd || finishPromise)
          throw Error('LATE_DIRECTORY_CUSTODY_UNVERIFIED');
        const observed = await lstat(path);
        if (!observed.isDirectory() || observed.isSymbolicLink())
          throw Error('DIRECTORY_NOT_OWNED');
        duty.identity = Object.freeze({ dev: observed.dev, ino: observed.ino });
        duty.pending = false;
        // Retain the exact receipt for late cleanup custody, but refuse ordinary continuation.
        try {
          ensureAcquisition();
        } catch (error) {
          duty.lateIdentity = true;
          throw Error('LATE_DIRECTORY_CUSTODY_UNVERIFIED', { cause: error });
        }
        return path;
      };
      const work = (async () => {
        ensureAcquisition();
        childAttempts++;
        if (childAttempts > 6) throw Error('CHILD_ACQUISITION_CAP');
        // The child duty/exited/stop/finish handles already exist before the fallible factory.
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        const ready = (spawnReady = new Promise<void>((resolve, reject) => {
          child!.once('spawn', () => {
            spawned = true;
            acquiredChildren++;
            resolve();
          });
          child!.once('error', (error) => {
            reject(error);
            rejectExit(error);
          });
        }));
        child.once('exit', () => {
          exitObserved = true;
          resolveExit();
        });
        await bounded(ready, workEnd, 'OWNED_CHILD_START_UNVERIFIED');
        ensureAcquisition();
        identity = hostIdentity(child.pid!) ?? undefined;
        if (!identity) throw Error('CHILD_IDENTITY_UNAVAILABLE');
        ensureAcquisition();
        const rootDuty: DirectoryDuty = { pending: true, removed: false };
        directories.push(rootDuty);
        directoryAttempts++;
        if (directoryAttempts > 6) throw Error('DIRECTORY_ACQUISITION_CAP');
        const root = await mkdtemp(join(tmpdir(), 'browser-engine-cleanup-')).then((path) => {
          acquiredDirectories++;
          return ownDirectoryDuty(path, rootDuty);
        });
        ensureAcquisition();
        await body({
          child: { identity, stop },
          root,
          assertWork: ensureAcquisition,
          replaceDirectory: async () => {
            ensureAcquisition();
            // Register both rename destination and replacement BEFORE either fallible effect.
            const moved = root + '-moved';
            const movedDuty: DirectoryDuty = {
              path: moved,
              identity: rootDuty.identity,
              pending: true,
              removed: false,
            };
            const replacement: DirectoryDuty = { path: root, pending: true, removed: false };
            directories.push(movedDuty, replacement);
            await rename(root, moved);
            rootDuty.removed = true;
            movedDuty.pending = false;
            ensureAcquisition();
            replacementAttempts++;
            if (replacementAttempts > 1) throw Error('REPLACEMENT_ACQUISITION_CAP');
            await mkdir(root, { mode: 0o700 });
            acquiredReplacements++;
            await ownDirectoryDuty(root, replacement);
            ensureAcquisition();
            return moved;
          },
        });
      })().then(
        () => {
          workSettled = true;
        },
        (error) => {
          workSettled = true;
          throw error;
        }
      );
      let primary: unknown;
      try {
        await bounded(work, workEnd, 'PHYSICAL_CASE_WORK_UNVERIFIED');
      } catch (error) {
        fixtureBlocked = true;
        primary = error;
      }
      let cleanupFailure: unknown;
      try {
        await bounded(finish(), cleanupEnd, 'PHYSICAL_CASE_CLEANUP_UNVERIFIED');
      } catch (error) {
        fixtureBlocked = true;
        cleanupFailure = error;
      }
      closureRows.push(
        Object.freeze({
          name,
          entered,
          workEnd,
          cleanupEnd,
          totalEnd: fixtureEnd,
          spawned,
          exitObserved,
          childClosureObserved,
          workSettled,
          childStopShared: stopPromise !== undefined,
          directoryDuties: directories.map((duty) => Object.freeze({ ...duty })),
          cleanup: cleanupFailure === undefined ? 'observed' : 'unverified',
        })
      );
      if (primary !== undefined) {
        if (cleanupFailure !== undefined)
          throw new AggregateError([primary, cleanupFailure], 'PHYSICAL_CASE_FAILED', {
            cause: primary,
          });
        throw primary;
      }
      if (cleanupFailure !== undefined) throw cleanupFailure;
      const settledAt = performance.now();
      if (!Number.isFinite(settledAt) || settledAt >= cleanupEnd) {
        fixtureBlocked = true;
        throw Error('PHYSICAL_CASE_FINAL_END_EXPIRED');
      }
    },
    CASE_TOTAL_MS
  );
}

physicalCase(
  'does not reuse a previously complete inventory after the current observer becomes unavailable',
  async ({ child, root, assertWork }) => {
    let closeCalls = 0;
    {
      const config = await configuration(root, 'http://127.0.0.1:9001');
      assertWork();
      config.processes = {
        descendants: async () => ({ status: 'unknown', identities: [] }),
        observe: async () => ({ status: 'dead' }),
      };
      const record = ledger(config, root, child.identity, {
        close: async () => {
          closeCalls++;
        },
      } as unknown as BrowserContext);
      record.inventoryComplete = true;
      record.identities = [child.identity];
      expect(await closeRecord(config, record)).toEqual({
        cleanup: 'unverified',
        reason: 'observationUnavailable',
      });
      expect(closeCalls).toBe(1);
      assertWork();
      await expect(access(root)).resolves.toBeUndefined();
    }
  }
);

physicalCase(
  'bounds live-process teardown even when the injected clock does not advance',
  async ({ child, root, assertWork }) => {
    const config = await configuration(root, 'http://127.0.0.1:9001');
    assertWork();
    let frozen = true;
    config.clock.monotonicNow = () => (frozen ? 0 : 10000);
    config.processes = {
      descendants: async () => ({ status: 'complete', identities: [child.identity] }),
      observe: async () => ({ status: 'alive' }),
    };
    const operation = closeRecord(
      config,
      ledger(config, root, child.identity, { close: async () => {} } as unknown as BrowserContext)
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('TEARDOWN_NOT_BOUNDED')), 2600);
      });
      expect(await Promise.race([operation, bounded])).toEqual({
        cleanup: 'failed',
        reason: 'processesRemain',
      });
      assertWork();
      await expect(access(root)).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer);
      frozen = false;
      await operation;
    }
  }
);

function ledger(
  config: EngineConfiguration,
  profileDir: string,
  identity: NonNullable<ReturnType<typeof hostIdentity>>,
  context: BrowserContext
): BrowserRecord {
  const owned: BrowserRecord = {
    diagnosticsBudget: createDiagnosticsBudget(),
    lifetime: createBrowserLifetime('browser_0123456789abcdef0123456789ab', 0),
    browserId: parseBrowserId('browser_0123456789abcdef0123456789ab'),
    browserGeneration: 0,
    mode: 'ephemeral',
    profileDir: realpathSync(profileDir),
    directory: ownDirectory(realpathSync(profileDir)),
    manager: hostIdentity(process.pid)!,
    root: identity,
    rootAttributed: true,
    context,
    launchEntered: true,
    identities: [],
    inventoryComplete: false,
    status: 'running',
    tabs: new Map(),
  };
  registerFixtureRecord(owned, () => closeRecord(config, owned));
  return owned;
}

physicalCase(
  'retains the owned directory and fixed failure when context close rejects while its exact root lives',
  async ({ child, root, assertWork }) => {
    {
      const config = await configuration(root, 'http://127.0.0.1:9001');
      assertWork();
      const result = await closeRecord(
        config,
        ledger(config, root, child.identity, {
          close: async () => {
            throw Error('PRIVATE-URL-SECRET');
          },
        } as unknown as BrowserContext)
      );
      expect(result).toEqual({ cleanup: 'failed', reason: 'closeFailed' });
      expect(JSON.stringify(result)).not.toContain('PRIVATE-URL-SECRET');
      assertWork();
      expect(hostIdentity(child.identity.pid)).toEqual(child.identity);
      assertWork();
      await access(root);
    }
  }
);

physicalCase(
  'does not delete a replacement directory after freshly verified exact-root disappearance',
  async ({ child, root, assertWork, replaceDirectory }) => {
    {
      const config = await configuration(root, 'http://127.0.0.1:9001');
      assertWork();
      const record = ledger(config, root, child.identity, {
        close: () => child.stop(),
      } as unknown as BrowserContext);
      await replaceDirectory();
      assertWork();
      await writeFile(join(root, 'replacement-seed'), 'UNCHANGED');
      assertWork();
      expect(await closeRecord(config, record)).toEqual({
        cleanup: 'unverified',
        reason: 'observationUnavailable',
      });
      assertWork();
      expect(await readFile(join(root, 'replacement-seed'), 'utf8')).toBe('UNCHANGED');
    }
  }
);

physicalCase(
  'refuses corrupt extra identities in a claimed complete census and still attempts owned graceful close',
  async ({ child, root, assertWork }) => {
    {
      const config = await configuration(root, 'http://127.0.0.1:9001');
      assertWork();
      config.processes.descendants = async () => ({
        status: 'complete',
        identities: [child.identity, { pid: 0, birth: 'not-an-identity' }],
      });
      const record = ledger(config, root, child.identity, {
        close: () => child.stop(),
      } as unknown as BrowserContext);
      expect(await closeRecord(config, record)).toEqual({
        cleanup: 'unverified',
        reason: 'observationUnavailable',
      });
      assertWork();
      expect(hostIdentity(child.identity.pid)).toBe(null);
      assertWork();
      await access(root);
    }
  }
);

physicalCase(
  'drops acquired Page and context references only after fresh complete disappearance proof',
  async ({ child, root, assertWork }) => {
    {
      const config = await configuration(root, 'http://127.0.0.1:9001');
      assertWork();
      const record = ledger(config, root, child.identity, {
        close: () => child.stop(),
      } as unknown as BrowserContext);
      const tabId = parseTabId('tab_0123456789abcdef0123456789abcdef');
      const pageFixture = fakePage();
      record.tabs.set(tabId, {
        pointer: createPointerLedger(() => null),
        diagnostics: unavailableDiagnostics,
        page: pageFixture.page,
        binding: {
          browserId: record.browserId,
          browserGeneration: record.browserGeneration,
          tabId,
          navigationGeneration: 0,
          viewportVersion: 0,
          epoch: 0,
          inputGeneration: 0,
        },
        stopped: false,
        captureSequence: 0,
        pending: 0,
        tail: Promise.resolve(),
      });
      await composeInput(config, record, record.tabs.get(tabId)!).readiness;
      expect(await closeRecord(config, record)).toEqual({ cleanup: 'observed' });
      expect(record.context).toBeUndefined();
      expect(record.tabs.size).toBe(0);
      expect(record.root).toBeUndefined();
      expect(record.identities).toEqual([]);
      expect(record.profileDir).toBeUndefined();
      assertWork();
      await expect(access(root)).rejects.toThrow();
    }
  }
);

afterAll(() => {
  // Proposed explicit-only fixture receipt; unknown tails cannot be retroactively healed.
  console.info(
    'PHYSICAL_CLEANUP_CLOSURE',
    JSON.stringify({
      proposedBudget: {
        totalMs: TOTAL_FIXTURE_MS,
        caseWorkMs: CASE_WORK_MS,
        caseTotalMs: CASE_TOTAL_MS,
      },
      childAttempts,
      acquiredChildren,
      directoryAttempts,
      acquiredDirectories,
      replacementAttempts,
      acquiredReplacements,
      blocked: fixtureBlocked,
      rows: closureRows,
    })
  );
  expect(acquiredChildren).toBe(6);
  expect(acquiredDirectories).toBe(6);
  expect(acquiredReplacements).toBe(1);
  expect(closureRows).toHaveLength(6);
  expect(fixtureBlocked).toBe(false);
});
