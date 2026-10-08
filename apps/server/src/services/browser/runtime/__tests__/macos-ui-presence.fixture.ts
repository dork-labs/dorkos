/** Fixture-only OS evidence; no production authority or permission prompting. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { z } from 'zod';

const Birth = z
  .object({
    pid: z.number().int().positive(),
    birth: z.string().regex(/^darwin-bsd-start:\d+:\d+$/),
  })
  .strict();
const Inventory = z
  .object({
    coverage: z.enum(['OBSERVED', 'UNVERIFIED']),
    positiveControlIcons: z.number().int().nonnegative(),
    managedIcons: z.number().int().nonnegative(),
    candidateCount: z.number().int().nonnegative(),
  })
  .strict();
const Switcher = z
  .object({
    coverage: z.enum(['OBSERVED', 'UNVERIFIED']),
    reason: z.string().optional(),
    probeCoverage: z.enum(['OBSERVED', 'UNVERIFIED']).optional(),
    positiveControlIcons: z.number().int().nonnegative().optional(),
    managedIcons: z.number().int().nonnegative().optional(),
    candidateCount: z.number().int().nonnegative().optional(),
    ownedReleasesObserved: z.boolean().optional(),
    focusedDockChainObserved: z.boolean().optional(),
    newFocusedElementObserved: z.boolean().optional(),
    focusedDepth: z.number().int().min(0).max(16).optional(),
  })
  .strict();
export const OriginalPresenceReceipt = z
  .object({
    requestId: z.string(),
    control: Birth,
    subjects: z.number().int().nonnegative(),
    birthsQualified: z.boolean(),
    dock: Inventory,
    switcher: Switcher,
    foreground: z
      .object({
        coverage: z.enum(['OBSERVED', 'UNVERIFIED']),
        managedActivations: z.number().int().nonnegative(),
        frontmost: Birth.nullable(),
      })
      .strict(),
  })
  .strict();
export type PresenceTarget = z.infer<typeof Birth> & { executable: string; bundle: string };
export function classifyOriginalPresence(value: unknown): 'FAIL' | 'UNVERIFIED' | 'OBSERVED' {
  const row = OriginalPresenceReceipt.parse(value);
  if (row.dock.managedIcons || row.switcher.managedIcons || row.foreground.managedActivations)
    return 'FAIL';
  if (
    !row.subjects ||
    !row.birthsQualified ||
    row.dock.coverage !== 'OBSERVED' ||
    !row.dock.positiveControlIcons ||
    row.foreground.coverage !== 'OBSERVED' ||
    row.switcher.coverage !== 'OBSERVED' ||
    !row.switcher.positiveControlIcons ||
    row.switcher.ownedReleasesObserved !== true
  )
    return 'UNVERIFIED';
  return 'OBSERVED';
}

/** Join all original close duties even when end/retirement throws a falsy cause. */
export async function joinOriginalPresenceClose(options: {
  end(): void;
  retire(): Promise<void>;
  returns: readonly Promise<void>[];
  absence(): Promise<void>;
  capture(cause: unknown): void;
}): Promise<void> {
  const { end, retire, absence, capture } = options;
  const returns = [...options.returns];
  try {
    end();
  } catch (cause) {
    capture(cause);
  }
  try {
    await retire();
  } catch (cause) {
    capture(cause);
  }
  const settled = await Promise.allSettled(returns);
  for (const result of settled) if (result.status === 'rejected') capture(result.reason);
  try {
    await absence();
  } catch (cause) {
    capture(cause);
  }
}

/** Consume the exact original native identity reader and campaign custody/deadline. */
export async function launchOriginalPresenceObserver(options: {
  executable: string;
  sha256: string;
  interaction: true;
  signal: AbortSignal;
  identity(pid: number): Promise<z.infer<typeof Birth> | null>;
  attributeRoot(parent: z.infer<typeof Birth>, child: z.infer<typeof Birth>): Promise<boolean>;
  parent: z.infer<typeof Birth>;
  current(): void;
  own<T>(promise: Promise<T>): Promise<T>;
}) {
  const { identity, attributeRoot, current, own, signal } = options;
  const parent = Birth.parse(options.parent);
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || options.interaction !== true)
    throw new Error('ORIGINAL_UI_PLATFORM_OR_INTERACTION_REFUSED');
  current();
  signal.throwIfAborted();
  const path = await own(realpath(options.executable));
  const bytes = await own(readFile(path));
  if (
    bytes.length > 8 * 1024 * 1024 ||
    createHash('sha256').update(bytes).digest('hex') !== options.sha256
  )
    throw new Error('ORIGINAL_UI_ARTIFACT_UNKNOWN');
  current();
  signal.throwIfAborted();
  const child = spawn(path, ['--explicit-fixture-interaction'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin' },
  });
  let first: { value: unknown } | undefined;
  let original: z.infer<typeof Birth> | null = null;
  let pending:
    { id: string; resolve(value: unknown): void; reject(value: unknown): void } | undefined;
  let resolveReady!: (value: unknown) => void;
  let rejectReady!: (value: unknown) => void;
  const ready = new Promise<unknown>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const originalFailure = (): { value: unknown } | undefined => first;
  const fail = (value: unknown) => {
    first ??= { value };
    rejectReady(first.value);
    pending?.reject(first.value);
  };
  let buffer = '',
    total = 0,
    readySeen = false;
  const stdout = own(
    new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          total += chunk.length;
          if (total > 4 * 1024 * 1024) throw new Error('ORIGINAL_UI_OUTPUT_OVERFLOW');
          buffer += chunk.toString('utf8');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            if (newline > 65536) throw new Error('ORIGINAL_UI_LINE_OVERFLOW');
            const row: unknown = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (!row || typeof row !== 'object') throw new Error('ORIGINAL_UI_PROTOCOL_UNKNOWN');
            if ('ready' in row && row.ready === true && !readySeen) {
              readySeen = true;
              resolveReady(row);
            } else if (pending && 'requestId' in row && row.requestId === pending.id) {
              const owner = pending;
              pending = undefined;
              owner.resolve(row);
            } else throw new Error('ORIGINAL_UI_CORRELATION_UNKNOWN');
          }
          if (buffer.length > 65536) throw new Error('ORIGINAL_UI_LINE_OVERFLOW');
        } catch (error) {
          fail(error);
        }
      });
      child.stdout.once('error', (error) => {
        fail(error);
        reject(error);
      });
      child.stdout.once('end', () => {
        if (pending || !readySeen) fail(new Error('ORIGINAL_UI_EARLY_RETURN'));
        if (buffer) {
          const error = new Error('ORIGINAL_UI_PARTIAL_LINE');
          fail(error);
          reject(error);
        } else resolve();
      });
    })
  );
  const stderr = own(
    new Promise<void>((resolve, reject) => {
      let size = 0;
      child.stderr.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) fail(new Error('ORIGINAL_UI_STDERR_OVERFLOW'));
      });
      child.stderr.once('error', (error) => {
        fail(error);
        reject(error);
      });
      child.stderr.once('end', resolve);
    })
  );
  // Error outcomes do not substitute for the original child and pipe terminals.
  const terminals = [child, child.stdout, child.stderr].map((producer) =>
    own(new Promise<void>((resolve) => producer.once('close', () => resolve())))
  );
  const returned = own(
    new Promise<void>((resolve, reject) => {
      child.once('error', (error) => {
        fail(error);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (code !== 0 || signal) {
          const error = new Error('ORIGINAL_UI_RETURN_FAILED');
          fail(error);
          reject(error);
        } else {
          if (pending || !readySeen) fail(new Error('ORIGINAL_UI_EARLY_RETURN'));
          resolve();
        }
      });
    })
  );
  for (const job of [stdout, stderr, returned]) void job.catch(() => {});
  let retirement: Promise<void> | undefined;
  const stopOriginal = () => {
    retirement ??= own(retire());
    void retirement.catch(fail);
    return retirement;
  };
  const abort = () => {
    fail(signal.reason);
    void stopOriginal();
  };
  const retire = async () => {
    if (
      original &&
      child.pid &&
      JSON.stringify(await identity(child.pid)) === JSON.stringify(original)
    )
      child.kill('SIGTERM');
    else if (child.exitCode === null) fail(new Error('ORIGINAL_UI_CHILD_BIRTH_UNKNOWN'));
  };
  child.stdin.on('error', fail);
  signal.addEventListener('abort', abort, { once: true });
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        signal.removeEventListener('abort', abort);
        await joinOriginalPresenceClose({
          end: () => {
            child.stdin.end();
          },
          retire: async () => {
            if (first) await stopOriginal();
            if (retirement) await retirement;
          },
          returns: [returned, stdout, stderr, ...terminals],
          absence: async () => {
            if (original && child.pid && (await own(identity(child.pid))) !== null)
              throw new Error('ORIGINAL_UI_DEATH_UNVERIFIED');
          },
          capture: fail,
        });
        if (first) throw first.value;
      });
      closing = own(closing);
    }
    return closing;
  };
  try {
    if (!child.pid) throw new Error('ORIGINAL_UI_CHILD_UNKNOWN');
    original = await own(identity(child.pid));
    if (!original || !(await own(attributeRoot(parent, original))))
      throw new Error('ORIGINAL_UI_CHILD_ATTRIBUTION_UNKNOWN');
    const receipt = z
      .object({ ready: z.literal(true), control: Birth })
      .strict()
      .parse(await own(ready));
    if (JSON.stringify(receipt.control) !== JSON.stringify(original))
      throw new Error('ORIGINAL_UI_CONTROL_SUBSTITUTED');
    current();
    signal.throwIfAborted();
  } catch (error) {
    fail(error);
    await close();
    throw error;
  }
  const command = async (operation: string, fields: object = {}) => {
    current();
    signal.throwIfAborted();
    if (first) throw first.value;
    if (closed || pending) throw new Error('ORIGINAL_UI_COMMAND_NOT_ADMITTED');
    const requestId = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      pending = { id: requestId, resolve, reject };
    });
    void result.catch(() => {});
    await own(
      new Promise<void>((resolve, reject) =>
        child.stdin.write(JSON.stringify({ operation, requestId, ...fields }) + '\n', (error) => {
          if (error) {
            fail(error);
            reject(error);
          } else resolve();
        })
      )
    );
    const row = await own(result);
    current();
    signal.throwIfAborted();
    const failure = originalFailure();
    if (failure) throw failure.value;
    return row;
  };
  return {
    original,
    async activateControl() {
      const row = z
        .object({ requestId: z.string(), control: Birth })
        .strict()
        .parse(await command('activate-control'));
      if (JSON.stringify(row.control) !== JSON.stringify(original))
        throw new Error('ORIGINAL_UI_CONTROL_SUBSTITUTED');
    },
    async sample(targets: readonly PresenceTarget[], probeSwitcher = false) {
      const row = OriginalPresenceReceipt.parse(
        await command('sample', { targets, probeSwitcher })
      );
      if (JSON.stringify(row.control) !== JSON.stringify(original))
        throw new Error('ORIGINAL_UI_CONTROL_SUBSTITUTED');
      return row;
    },
    async sampleOwned(targets: readonly z.infer<typeof Birth>[], probeSwitcher = false) {
      const captured = z.array(Birth).max(128).parse(targets);
      const row = OriginalPresenceReceipt.parse(
        await command('sample-owned', { targets: captured, probeSwitcher })
      );
      if (JSON.stringify(row.control) !== JSON.stringify(original))
        throw new Error('ORIGINAL_UI_CONTROL_SUBSTITUTED');
      return row;
    },
    async sampleRuntimeOwned(
      targets: readonly z.infer<typeof Birth>[],
      runtimeRoot: string,
      probeSwitcher = false
    ) {
      const captured = z.array(Birth).max(128).parse(targets);
      if (!runtimeRoot.startsWith('/') || runtimeRoot.length > 4096 || runtimeRoot.includes('\0'))
        throw new Error('ORIGINAL_UI_RUNTIME_ROOT_REQUIRED');
      const row = OriginalPresenceReceipt.parse(
        await command('sample-runtime-owned', { targets: captured, runtimeRoot, probeSwitcher })
      );
      if (JSON.stringify(row.control) !== JSON.stringify(original))
        throw new Error('ORIGINAL_UI_CONTROL_SUBSTITUTED');
      return row;
    },
    close,
  };
}
