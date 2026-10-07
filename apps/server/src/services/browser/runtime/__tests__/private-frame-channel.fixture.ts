import type { ChildProcess } from 'node:child_process';
import { lstat, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

/** Private original worker handshake. Files convey observations, never browser authority. */
export async function createOriginalFrameChannel(directory: string, signal: AbortSignal) {
  if (!isAbsolute(directory)) throw new Error('FRAME_ORIGINAL_CHANNEL_REQUIRED');
  const original = await lstat(directory, { bigint: true });
  if (!original.isDirectory() || original.isSymbolicLink())
    throw new Error('FRAME_ORIGINAL_CHANNEL_REQUIRED');
  const current = async () => {
    const actual = await lstat(directory, { bigint: true });
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== original.dev ||
      actual.ino !== original.ino
    )
      throw new Error('FRAME_ORIGINAL_CHANNEL_REPLACED');
  };
  return Object.freeze({
    async write(name: 'ready' | 'start' | 'active' | 'release' | 'failure', value: unknown) {
      await current();
      const bytes = JSON.stringify({ value });
      if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('FRAME_CHANNEL_CAPACITY');
      const temporary = join(directory, 'original-' + randomUUID() + '.json');
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try {
        await current();
        await link(temporary, join(directory, name + '.json'));
        await current();
      } finally {
        await unlink(temporary);
      }
    },
    async wait(name: 'ready' | 'start' | 'active' | 'release') {
      for (;;) {
        signal.throwIfAborted();
        await current();
        if (name === 'start') {
          try {
            await lstat(join(directory, 'release.json'));
            throw new Error('FRAME_ORIGINAL_PARENT_RELEASED_SETUP');
          } catch (value) {
            if (!(value instanceof Error) || !('code' in value) || value.code !== 'ENOENT')
              throw value;
          }
        }
        try {
          const path = join(directory, name + '.json');
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
            throw new Error('FRAME_CHANNEL_CAPACITY');
          const result: unknown = JSON.parse(await readFile(path, 'utf8'));
          if (!result || typeof result !== 'object' || !('value' in result))
            throw new Error('FRAME_CHANNEL_INVALID');
          await current();
          return result.value;
        } catch (value) {
          if (!(value instanceof Error) || !('code' in value) || value.code !== 'ENOENT')
            throw value;
        }
        // Polling observes an actual worker handshake; it supplies no readiness or measurement.
        await pause(25, undefined, { signal });
      }
    },
  });
}

/** Enter all independent cleanup before joining; first falsy body/cleanup cause remains exact. */
export async function withOriginalFrameDrain<T>(
  body: () => Promise<T>,
  release: () => Promise<void>,
  closes: readonly (() => Promise<void>)[]
): Promise<T> {
  let first: { value: unknown } | undefined, result: T | undefined;
  try {
    result = await body();
  } catch (value) {
    first = { value };
  }
  const jobs: Promise<void>[] = [];
  for (const close of [release, ...closes]) {
    try {
      jobs.push(close());
    } catch (value) {
      first ??= { value };
    }
  }
  for (const job of jobs)
    void job.catch((value) => {
      first ??= { value };
    });
  for (const settled of await Promise.allSettled(jobs))
    if (settled.status === 'rejected') first ??= { value: settled.reason };
  if (first) throw first.value;
  return result!;
}

/** Actual observer counters only; absent/invalid statistics cannot become an idle success. */
export function parseOriginalFrameStatistics(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    !('frames' in value) ||
    !('bytes' in value) ||
    !Number.isSafeInteger(value.frames) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.frames) < 1 ||
    Number(value.bytes) < 1
  )
    throw new Error('FRAME_ORIGINAL_PRODUCER_STATS_REQUIRED');
  return { frames: Number(value.frames), bytes: Number(value.bytes) };
}

/** Stop the captured worker independently of parent signal; always join its original return. */
export async function stopAndJoinOriginalFrameWorker(child: ChildProcess, returned: Promise<void>) {
  let first: { value: unknown } | undefined;
  try {
    if (child.exitCode === null && child.signalCode === null && !child.kill('SIGTERM'))
      throw new Error('FRAME_ORIGINAL_WORKER_STOP_REFUSED');
  } catch (value) {
    first = { value };
  }
  try {
    await returned;
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}

/** Join original worker/pipe returns and log close without replacing the first boxed cause. */
export async function joinOriginalFrameWorkerReturns(
  returns: readonly Promise<void>[],
  closeLog: () => Promise<void>,
  stopOriginal: () => void = () => {}
) {
  let first: { value: unknown } | undefined;
  for (const original of returns)
    void original.catch((value) => {
      first ??= { value };
      // A failed original pipe cannot wait for a worker held on the parent handshake.
      // Enter captured stop before the aggregate waits for its original exit/other pipe.
      try {
        stopOriginal();
      } catch (stopCause) {
        first ??= { value: stopCause };
      }
    });
  for (const result of await Promise.allSettled(returns))
    if (result.status === 'rejected') first ??= { value: result.reason };
  try {
    await closeLog();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}

/** A failed release cannot leave the captured worker waiting for a file that cannot arrive. */
export async function releaseOriginalFrameWorker(
  publishRelease: () => Promise<void>,
  original: ChildProcess,
  returned: Promise<void>
) {
  try {
    await publishRelease();
  } catch (cause) {
    await Promise.allSettled([stopAndJoinOriginalFrameWorker(original, returned)]);
    throw cause;
  }
}
