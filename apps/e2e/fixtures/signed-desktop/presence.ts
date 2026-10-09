import {
  launchOriginalPresenceObserver,
  classifyOriginalPresence,
} from '../../../server/src/services/browser/runtime/__tests__/macos-ui-presence.fixture.js';
import type { createDarwinEngineProcesses } from '../../../../packages/browser/src/runtime/darwin-engine-processes.js';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ProcessIdentity } from '../../../../packages/browser/src/configuration.js';

// The original pre-read stat bounds allocation; the extra byte detects growth without an unbounded read.
async function readOriginalBoundedBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = await handle.read(bytes, count, bytes.length - count, count);
    if (read.bytesRead === 0) break;
    count += read.bytesRead;
  }
  return bytes.subarray(0, count);
}

/** Capture only the freshly observed original app cohort; this is observation, not release authority. */
export function captureOriginalSignedPresenceCohort(cohort: readonly ProcessIdentity[]) {
  if (!Array.isArray(cohort) || cohort.length > 128)
    throw new Error('SIGNED_PRESENCE_NATIVE_COHORT_BOUND');
  const pids = new Set<number>();
  return Object.freeze(
    cohort.map((original) => {
      if (
        !Number.isSafeInteger(original.pid) ||
        original.pid <= 0 ||
        original.pid > 2147483647 ||
        typeof original.birth !== 'string' ||
        !/^darwin-bsd-start:\d+:\d+$/.test(original.birth) ||
        pids.has(original.pid)
      )
        throw new Error('SIGNED_PRESENCE_NATIVE_COHORT_UNAVAILABLE');
      pids.add(original.pid);
      return Object.freeze({ pid: original.pid, birth: original.birth });
    })
  );
}

/** Crash only the exact original Electron window; retain genuine crash event and original handle. */
export async function crashOriginalSignedRenderer(
  app: ElectronApplication,
  page: Page,
  signal: AbortSignal,
  current: () => void
): Promise<void> {
  current();
  signal.throwIfAborted();
  const window = await app.browserWindow(page);
  let first: { value: unknown } | undefined;
  let resolve!: () => void, reject!: (value: unknown) => void;
  const crashed = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void crashed.catch(() => undefined);
  const crash = () => resolve(),
    stop = () => reject(signal.reason);
  try {
    page.on('crash', crash);
    signal.addEventListener('abort', stop, { once: true });
    current();
    signal.throwIfAborted();
    await window.evaluate((original) => {
      if (original.isDestroyed() || original.webContents.isDestroyed())
        throw new Error('SIGNED_RENDERER_ORIGINAL_WINDOW_UNAVAILABLE');
      original.webContents.forcefullyCrashRenderer();
    });
    await crashed;
    current();
    await page.reload();
    current();
  } catch (value) {
    first ??= { value };
    reject(first.value);
  } finally {
    for (const remove of [
      () => page.off('crash', crash),
      () => signal.removeEventListener('abort', stop),
    ]) {
      try {
        remove();
      } catch (value) {
        first ??= { value };
      }
    }
    await Promise.allSettled([crashed]);
    try {
      await window.dispose();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
}

/** Original signed-campaign observer owner. Unavailable OS observations never qualify a release. */
export async function createOriginalSignedPresence(
  options: Readonly<{
    executable: string;
    sha256: string;
    interaction: true;
    probeSwitcher: boolean;
  }>,
  native: ReturnType<typeof createDarwinEngineProcesses>,
  home: string,
  signal: AbortSignal,
  retainFailure: (value: unknown) => void
) {
  const jobs = new Set<Promise<unknown>>();
  const receipts: unknown[] = [];
  const current = () => signal.throwIfAborted();
  const own = <T>(original: Promise<T>): Promise<T> => {
    jobs.add(original);
    void original.then(
      () => jobs.delete(original),
      (value) => {
        retainFailure(value);
        jobs.delete(original);
      }
    );
    return original;
  };
  current();
  const parent = await native.identity(process.pid);
  if (!parent) throw new Error('SIGNED_PRESENCE_PARENT_UNAVAILABLE');
  const observer = await launchOriginalPresenceObserver({
    ...options,
    signal,
    identity: native.identity,
    attributeRoot: native.attributeRoot,
    parent,
    current,
    own,
  });
  try {
    await own(observer.activateControl());
    receipts.push({
      phase: 'before-app-launch',
      classification: 'UNVERIFIED',
      receipt: await own(observer.sampleOwned([])),
    });
  } catch (first) {
    try {
      await observer.close();
    } catch (value) {
      retainFailure(value);
    }
    await Promise.allSettled([...jobs]);
    throw first;
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    receipts,
    async observe(
      phase: 'launch' | 'capture' | 'input' | 'off',
      originalAppCohort: readonly ProcessIdentity[]
    ) {
      current();
      const cohort = captureOriginalSignedPresenceCohort(originalAppCohort);
      if (options.probeSwitcher) await own(observer.activateControl());
      const receipt = await own(
        observer.sampleRuntimeOwned(
          cohort,
          join(home, '.dork/browser/runtime'),
          options.probeSwitcher
        )
      );
      current();
      if (phase !== 'off' && (!receipt.birthsQualified || !receipt.subjects))
        throw new Error('SIGNED_PRESENCE_NATIVE_COHORT_UNAVAILABLE');
      const classification = classifyOriginalPresence(receipt);
      receipts.push({ phase, classification, receipt });
      if (classification === 'FAIL') throw new Error('SIGNED_PRESENCE_MANAGED_VISIBILITY_OR_FOCUS');
    },
    close(): Promise<void> {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        let first: { value: unknown } | undefined;
        try {
          await observer.close();
        } catch (value) {
          first ??= { value };
        }
        const results = await Promise.allSettled([...jobs]);
        for (const result of results)
          if (result.status === 'rejected') first ??= { value: result.reason };
        if (first) throw first.value;
      });
      void closing.catch(retainFailure);
      return closing;
    },
  });
}

/** Explicit attended-fixture options only; no ambient flag or constructor establishes OS acceptance. */
export function parseOriginalSignedPresence(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SIGNED_PRESENCE_CONFIG_REFUSED');
  const original = value as Record<string, unknown>;
  if (
    Object.keys(original).sort().join(',') !==
      'crashRenderer,executable,interaction,probeSwitcher,sha256' ||
    typeof original.executable !== 'string' ||
    original.executable.length > 4096 ||
    !isAbsolute(original.executable) ||
    typeof original.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(original.sha256) ||
    original.interaction !== true ||
    typeof original.probeSwitcher !== 'boolean' ||
    typeof original.crashRenderer !== 'boolean'
  )
    throw new Error('SIGNED_PRESENCE_CONFIG_REFUSED');
  return Object.freeze({
    executable: original.executable,
    sha256: original.sha256,
    interaction: true as const,
    probeSwitcher: original.probeSwitcher,
    crashRenderer: original.crashRenderer,
  });
}

/** Retain the complete bounded no-follow option-file read and original close, including falsy failures. */
export async function readOriginalSignedPresenceFile(path: string) {
  if (!isAbsolute(path)) throw new Error('SIGNED_PRESENCE_CONFIG_PATH_REQUIRED');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let first: { value: unknown } | undefined;
  let parsed: ReturnType<typeof parseOriginalSignedPresence> | undefined;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 16384)
      throw new Error('SIGNED_PRESENCE_CONFIG_BOUND');
    const bytes = await readOriginalBoundedBytes(file, before.size),
      after = await file.stat();
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error('SIGNED_PRESENCE_CONFIG_CHANGED');
    parsed = parseOriginalSignedPresence(JSON.parse(bytes.toString('utf8')));
  } catch (value) {
    first ??= { value };
  } finally {
    try {
      await file.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
  if (!parsed) throw new Error('SIGNED_PRESENCE_CONFIG_UNAVAILABLE');
  return parsed;
}
