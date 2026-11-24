/**
 * Shared setup for the authority-real-boundary suites: everything the original file declared or
 * registered outside its tests.
 */
import { afterEach, vi } from 'vitest';
import { authorityFixture } from '../authority-fixtures.js';
import { DocCheckboxAuthority } from '../../authority.js';

export const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

export async function fixture(room = false) {
  const h = await authorityFixture(room);
  cleanups.push(h.cleanup);
  let clock = h.deps.now;
  const authority = new DocCheckboxAuthority({ ...h.deps, now: () => clock() });
  return {
    ...h,
    authority,
    setClock: (next: () => Date) => {
      clock = next;
    },
  };
}
