/**
 * Stops a contract server child and removes its data folder, in that order.
 *
 * Under load a server can still be writing into its `DORK_HOME` while the
 * folder is removed, and the remove fails with `ENOTEMPTY` (DOR-4502). So the
 * folder goes only after the child's `exit` event, a child that ignores
 * SIGTERM is killed after a grace period, and the remove itself retries.
 *
 * @module http/__tests__/contract/stop-server
 */
import type { ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';

/** How long a child gets to exit on SIGTERM before it is killed. */
export const STOP_GRACE_MS = 10_000;

/** How long to wait for confirmed `exit` after SIGKILL before refusing cleanup. */
export const KILL_WAIT_MS = 5_000;

/**
 * Resolves once `child` has exited, whenever that happens. Call it right after
 * spawning: an `exit` that fires before anyone listens is otherwise missed.
 *
 * @param child - The spawned server.
 * @returns A promise that settles on the child's `exit` event.
 */
export function whenExited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** True once the child has exited, by its own hand or a signal. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Waits for `exited`, or `ms`, whichever comes first; true when the child exited. */
async function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([exited.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stops `child` (SIGTERM, then SIGKILL after `graceMs`), waits for its `exit`,
 * then removes `dir` with retries.
 *
 * @param child - The spawned server.
 * @param exited - The child's {@link whenExited} promise, made at spawn.
 * @param dir - The server's data folder.
 * @param graceMs - How long SIGTERM gets before SIGKILL.
 */
export async function stopServerAndRemove(
  child: ChildProcess,
  exited: Promise<void>,
  dir: string,
  graceMs = STOP_GRACE_MS
): Promise<void> {
  if (!hasExited(child)) {
    child.kill('SIGTERM');
    if (!(await exitedWithin(exited, graceMs))) {
      child.kill('SIGKILL');
      if (!(await exitedWithin(exited, KILL_WAIT_MS)) && !hasExited(child)) {
        throw new Error(
          `Contract server ${child.pid ?? 'without a PID'} did not confirm exit; its data folder was retained.`
        );
      }
    }
  }
  if (!hasExited(child)) {
    throw new Error(
      `Contract server ${child.pid ?? 'without a PID'} did not confirm exit; its data folder was retained.`
    );
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
