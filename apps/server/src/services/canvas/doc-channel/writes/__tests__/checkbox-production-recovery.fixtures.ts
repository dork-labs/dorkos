/**
 * Shared setup for the checkbox-production-recovery suites: everything the original file declared or
 * registered outside its tests.
 */
import { afterEach, vi } from 'vitest';
import { fixture } from './checkbox-fixture.js';

const sourceReadHoldHoisted = vi.hoisted(() => ({
  path: '',
  armed: false,
  afterStop: false,
  lateReads: 0,
  entered: () => {},
  released: Promise.resolve(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (sourceReadHoldHoisted.afterStop) sourceReadHoldHoisted.lateReads++;
      const result = await actual.lstat(...args);
      if (sourceReadHoldHoisted.armed && String(args[0]) === sourceReadHoldHoisted.path) {
        sourceReadHoldHoisted.armed = false;
        sourceReadHoldHoisted.entered();
        await sourceReadHoldHoisted.released;
      }
      return result;
    },
  };
});

export function holdSourceRead(path: string) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  sourceReadHoldHoisted.released = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.assign(sourceReadHoldHoisted, { path, armed: true, entered: enter });
  return {
    entered,
    release: () => {
      sourceReadHoldHoisted.armed = false;
      release();
    },
  };
}

export const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sourceReadHoldHoisted.afterStop = false;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

export async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const h = await fixture(options);
  cleanups.push(h.cleanup);
  return h;
}

/** Exported view of the hoisted `sourceReadHold` (vitest refuses to export a hoisted binding). */
export const sourceReadHold = sourceReadHoldHoisted;
