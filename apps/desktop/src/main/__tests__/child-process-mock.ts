import { vi } from 'vitest';
import { MockServerProcess, type SpawnOptions } from './server-child-mock';

/**
 * Test double for `node:child_process`, mounted via
 * `vi.mock('node:child_process', () => import('./child-process-mock'))`.
 *
 * Covers the dev spawn path only (`fork` under tsx). Every forked child is
 * recorded in {@link forkedChildren} in spawn order, so a test can drive the
 * first child's exit and then inspect the replacement a restart spawned.
 */

/** Every child `fork()` has returned, in spawn order. */
export const forkedChildren: MockServerProcess[] = [];

/** When set, the next `fork()` throws it — models a synchronous spawn failure. */
let nextForkError: Error | null = null;

/** Make the next `fork()` call throw. */
export function failNextFork(err: Error): void {
  nextForkError = err;
}

export const fork = vi.fn((entry: string, _args: string[], options: SpawnOptions) => {
  if (nextForkError) {
    const err = nextForkError;
    nextForkError = null;
    throw err;
  }
  const child = new MockServerProcess(entry, options);
  forkedChildren.push(child);
  return child;
});

/** Reset all mock state between tests — call from `beforeEach`. */
export function resetChildProcessMock(): void {
  forkedChildren.length = 0;
  nextForkError = null;
  fork.mockClear();
}
