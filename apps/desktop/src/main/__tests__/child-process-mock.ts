import { vi } from 'vitest';
import { MockServerProcess, type SpawnOptions } from './server-child-mock';

/**
 * Test double for `node:child_process`, mounted via
 * `vi.mock('node:child_process', () => import('./child-process-mock'))`.
 *
 * Covers the dev spawn path (`fork` under tsx) and the one-shot login-shell
 * probe (`spawnSync`, see `shell-path.ts`). Every forked child is recorded in
 * {@link forkedChildren} in spawn order, so a test can drive the first child's
 * exit and then inspect the replacement a restart spawned.
 */

/** Every child `fork()` has returned, in spawn order. */
export const forkedChildren: MockServerProcess[] = [];

/** When set, `fork()` throws it — models a spawn failure. */
let forkError: Error | null = null;
/** Whether {@link forkError} keeps applying after the first throw. */
let forkErrorIsPersistent = false;

/** Make the next `fork()` call throw. */
export function failNextFork(err: Error): void {
  forkError = err;
  forkErrorIsPersistent = false;
}

/**
 * Make every `fork()` call throw — models a failure no retry can get past,
 * such as another server already holding the data directory.
 */
export function failEveryFork(err: Error): void {
  forkError = err;
  forkErrorIsPersistent = true;
}

export const fork = vi.fn((entry: string, _args: string[], options: SpawnOptions) => {
  if (forkError) {
    const err = forkError;
    if (!forkErrorIsPersistent) forkError = null;
    throw err;
  }
  const child = new MockServerProcess(entry, options);
  forkedChildren.push(child);
  return child;
});

/**
 * What a synchronous child process reported, narrowed to what `shell-path.ts`
 * reads. `error` models a spawn that never ran (a missing shell) or one the
 * timeout killed; `signal` is set when it was killed.
 */
export interface SpawnSyncResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Test double for `spawnSync`, used only by the login-shell PATH probe.
 *
 * The default models a shell that started and printed nothing — the branch
 * where the probe gives up and passes the inherited PATH through untouched.
 * That keeps every test that does not care about PATH resolution (the whole of
 * `server-process.test.ts`) on the behaviour it had before the probe existed;
 * tests that do care call `.mockReturnValue(...)` with a real payload.
 */
/** The `spawnSync` options `shell-path.ts` passes, narrowed to what tests assert on. */
export interface SpawnSyncOptions {
  encoding?: string;
  /** How long the child may run before it is killed. */
  timeout?: number;
  /** Signal used to kill it when the timeout fires. */
  killSignal?: string;
  stdio?: unknown;
}

export const spawnSync = vi.fn(
  (_command: string, _args: string[], _options: SpawnSyncOptions): SpawnSyncResult => ({
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
  })
);

/**
 * Test double for `execFileSync`, used only by
 * `@dorkos/shared/process-liveness`'s `processStartTime` — the corroboration
 * `buildServerEnv` (DOR-552) runs against this process's own pid when it
 * captures `DORKOS_PARENT_STARTED_AT`. A real `ps -o lstart=` invocation is
 * exactly what {@link execFileSync} in `../process-liveness.test.ts` (in
 * `packages/shared`) exercises against a real process; here the concern is
 * only "does `buildServerEnv` forward what it got", so a fixed, parseable
 * `lstart`-shaped line is enough and keeps this suite off real OS behavior.
 */
export const execFileSync = vi.fn(
  (_command: string, _args: string[], _options: unknown): string => 'Mon Jan  1 00:00:00 2024\n'
);

/** Reset all mock state between tests — call from `beforeEach`. */
export function resetChildProcessMock(): void {
  forkedChildren.length = 0;
  forkError = null;
  forkErrorIsPersistent = false;
  fork.mockClear();
  spawnSync.mockReset();
  execFileSync.mockClear();
}
