import { registerFixtureRecord, fakePage } from './parent-fixture.js';
import { composeInput } from '../lifecycle/input-owner.js';
import type { EngineConfiguration, ProcessIdentity } from '../configuration.js';
import { createPointerLedger } from '../tabs/pointer.js';
import { unavailableDiagnostics } from '../tabs/diagnostics.js';
import { createDiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import { createBrowserLifetime } from '../lifecycle/ownership.js';
import { it, expect, describe, beforeAll, afterAll, onTestFinished, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, access, rm, rename, mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext } from 'playwright-core';
import { closeRecord } from '../lifecycle/close.js';
import type { BrowserRecord } from '../lifecycle/records.js';
import { ownDirectory } from '../profiles/owned-directory.js';
import { realpathSync } from 'node:fs';
import { parseBrowserId, parseTabId } from '../ids.js';
import { configuration } from './lifecycle-fixture.js';

// Fixture-only original ChildProcess custody; no numeric-PID signal or descendant authority.
const TRUSTED_CHILD_SOURCE =
  "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000)";
const TRUSTED_CHILD_ENV = Object.freeze({});
function ownTrustedChild(child: ChildProcess, end: number, now = () => performance.now()) {
  let exit = false,
    close = false,
    stdinClosed = false;
  let failed: { value: unknown } | null = null;
  let refused = false;
  let stopPromise: Promise<void> | undefined;
  let resolveExit!: () => void, resolveClose!: () => void, resolveStdin!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const inputClosed = new Promise<void>((resolve) => {
    resolveStdin = resolve;
  });
  child.once('exit', () => {
    exit = true;
    resolveExit();
  });
  child.once('close', () => {
    close = true;
    resolveClose();
  });
  child.on('error', (value) => {
    failed ??= { value };
  });
  const stdin = child.stdin;
  stdin?.once('close', () => {
    stdinClosed = true;
    resolveStdin();
  });
  stdin?.on('error', (value) => {
    failed ??= { value };
  });
  const complete = () => exit && close && stdinClosed && failed === null && !refused;
  return Object.freeze({
    isClosed: complete,
    facts: () => Object.freeze({ exit, close, stdinClosed, failed }),
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      let resolve!: () => void, reject!: (value: unknown) => void;
      stopPromise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      // Memoization and all three terminal promises exist before the EOF request.
      void (async () => {
        const entered = now();
        if (!stdin || !Number.isFinite(entered) || entered >= end)
          throw Error('OWNED_CHILD_STOP_END_EXPIRED');
        if (!stdinClosed) stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([exited, closed, inputClosed]),
            new Promise<never>((_, fail) => {
              timer = setTimeout(
                () => fail(Error('OWNED_CHILD_CLOSURE_UNVERIFIED')),
                Math.max(0, end - now())
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        const settled = now();
        if (!Number.isFinite(settled) || settled >= end || !complete())
          throw Error('OWNED_CHILD_CLOSURE_UNVERIFIED', { cause: failed?.value });
      })().then(resolve, (cause) => {
        refused = true;
        reject(cause);
      });
      return stopPromise;
    },
  });
}

function throwCaseFailure(
  primary: { value: unknown } | null,
  cleanup: { value: unknown } | null
): void {
  if (primary !== null) {
    if (cleanup !== null)
      throw new AggregateError([primary.value, cleanup.value], 'PHYSICAL_CASE_FAILED', {
        cause: primary.value,
      });
    throw primary.value;
  }
  if (cleanup !== null) throw cleanup.value;
}

describe('trusted nofork physical cleanup fixture', () => {
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
    child: {
      identity: ProcessIdentity;
      stop(): Promise<void>;
      isClosed(): boolean;
      processes: EngineConfiguration['processes'];
    };
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
        let identity: ProcessIdentity | undefined;
        let childCustody: ReturnType<typeof ownTrustedChild> | undefined;
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
            if (!childCustody) throw Error('OWNED_CHILD_CUSTODY_UNVERIFIED');
            await childCustody.stop();
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
          // The child duty/stop/finish handles already exist before the fallible factory.
          child = spawn(process.execPath, ['-e', TRUSTED_CHILD_SOURCE], {
            stdio: ['pipe', 'ignore', 'ignore'],
            env: TRUSTED_CHILD_ENV,
            shell: false,
          });
          childCustody = ownTrustedChild(child, cleanupEnd);
          const ready = (spawnReady = new Promise<void>((resolve, reject) => {
            child!.once('spawn', () => {
              spawned = true;
              acquiredChildren++;
              resolve();
            });
            child!.once('error', (error) => {
              reject(error);
            });
          }));
          child.once('exit', () => {
            exitObserved = true;
          });
          await bounded(ready, workEnd, 'OWNED_CHILD_START_UNVERIFIED');
          ensureAcquisition();
          if (!child.pid) throw Error('CHILD_IDENTITY_UNAVAILABLE');
          // Diagnostic fixture correspondence only; original ChildProcess owns closure, not this PID.
          identity = Object.freeze({ pid: child.pid, birth: `trusted_fixture_${childAttempts}` });
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
            child: {
              identity,
              stop,
              isClosed: childCustody.isClosed,
              processes: {
                descendants: async (requested, signal) => {
                  if (
                    signal.aborted ||
                    requested.pid !== identity!.pid ||
                    requested.birth !== identity!.birth ||
                    childCustody!.isClosed()
                  )
                    return { status: 'unknown', identities: [] };
                  return { status: 'complete', identities: [identity!] };
                },
                observe: async (requested, signal) => {
                  if (
                    signal.aborted ||
                    requested.pid !== identity!.pid ||
                    requested.birth !== identity!.birth
                  )
                    return { status: 'unknown' };
                  return { status: childCustody!.isClosed() ? 'dead' : 'alive' };
                },
              },
            },
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
        let primary: { value: unknown } | null = null;
        try {
          await bounded(work, workEnd, 'PHYSICAL_CASE_WORK_UNVERIFIED');
        } catch (error) {
          fixtureBlocked = true;
          primary = { value: error };
        }
        let cleanupFailure: { value: unknown } | null = null;
        try {
          await bounded(finish(), cleanupEnd, 'PHYSICAL_CASE_CLEANUP_UNVERIFIED');
        } catch (error) {
          fixtureBlocked = true;
          cleanupFailure = { value: error };
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
            childFacts: childCustody?.facts(),
            cleanup: cleanupFailure === null ? 'observed' : 'unverified',
          })
        );
        throwCaseFailure(primary, cleanupFailure);
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
        config.processes = child.processes;
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
      config.processes = child.processes;
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
    identity: ProcessIdentity,
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
      manager: { pid: process.pid, birth: 'trusted_fixture_parent' },
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
        config.processes = child.processes;
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
        expect(child.isClosed()).toBe(false);
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
        config.processes = child.processes;
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
        config.processes = child.processes;
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
        expect(child.isClosed()).toBe(true);
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
        config.processes = child.processes;
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
    for (const row of closureRows)
      expect(row).toMatchObject({
        cleanup: 'observed',
        childFacts: { exit: true, close: true, stdinClosed: true, failed: null },
      });
  });
});

// These controls use only EventEmitter fixtures; they never spawn, query or signal a process.
describe('trusted child closure protocol without native subjects', () => {
  afterEach(() => vi.useRealTimers());
  function fixture() {
    const child = new EventEmitter();
    const stdin = new EventEmitter();
    const end = vi.fn();
    Object.assign(stdin, { end });
    Object.assign(child, { stdin });
    let now = 0;
    const owner = ownTrustedChild(child as unknown as ChildProcess, 100, () => now);
    return {
      child,
      stdin,
      end,
      owner,
      setNow: (value: number) => {
        now = value;
      },
    };
  }
  it('memoizes EOF and requires exact original exit, child close and stdin close', async () => {
    const f = fixture();
    const first = f.owner.stop();
    expect(f.owner.stop()).toBe(first);
    expect(f.end).toHaveBeenCalledTimes(1);
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    f.stdin.emit('close');
    await first;
    expect(f.owner.isClosed()).toBe(true);
  });
  it.each(['exit', 'close', 'stdin'])(
    'missing %s remains unknown at original deadline',
    async (missing) => {
      vi.useFakeTimers();
      const f = fixture();
      const pending = expect(f.owner.stop()).rejects.toThrow('OWNED_CHILD_CLOSURE_UNVERIFIED');
      if (missing !== 'exit') f.child.emit('exit', 0, null);
      if (missing !== 'close') f.child.emit('close', 0, null);
      if (missing !== 'stdin') f.stdin.emit('close');
      f.setNow(100);
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(f.owner.isClosed()).toBe(false);
    }
  );
  it('late complete events never renew the shared stop result', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.owner.stop();
    const rejection = expect(first).rejects.toThrow();
    f.setNow(100);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    f.stdin.emit('close');
    expect(f.owner.stop()).toBe(first);
    await expect(first).rejects.toThrow();
    expect(f.owner.isClosed()).toBe(false);
  });
  it('undefined child error remains failure after apparently complete events', async () => {
    const f = fixture();
    const result = f.owner.stop();
    f.child.emit('error', undefined);
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    f.stdin.emit('close');
    await expect(result).rejects.toMatchObject({ cause: undefined });
    expect(f.owner.isClosed()).toBe(false);
  });
  it('preserves undefined original body failure before cleanup failure with healthy peer', () => {
    let captured: unknown;
    let caught = false;
    const cleanup = Error('cleanup');
    try {
      throwCaseFailure({ value: undefined }, { value: cleanup });
    } catch (value) {
      captured = value;
      caught = true;
    }
    expect(caught).toBe(true);
    expect(captured).toBeInstanceOf(AggregateError);
    expect(Object.hasOwn(captured as object, 'cause')).toBe(true);
    expect((captured as AggregateError).cause).toBeUndefined();
    expect((captured as AggregateError).errors).toEqual([undefined, cleanup]);
    expect(() => throwCaseFailure(null, null)).not.toThrow();
  });
  it('closed environment supplies no NODE_OPTIONS, preload or shell intake', () => {
    expect(Object.keys(TRUSTED_CHILD_ENV)).toEqual([]);
    expect(TRUSTED_CHILD_SOURCE).not.toMatch(/require|import|fork|spawn|Worker/);
    expect(TRUSTED_CHILD_SOURCE).toContain("process.stdin.on('end',()=>process.exit(0))");
  });
});
