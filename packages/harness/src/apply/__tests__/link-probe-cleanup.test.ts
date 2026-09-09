/**
 * The capability probe survives a filesystem that will not let it tidy up.
 *
 * Its own file because it mocks `node:fs` wholesale, which the suite beside it
 * must not: `windows-links.test.ts` stages real links on a real disk, and a
 * mocked module there would let the fixture and the engine agree with each other
 * while both were wrong.
 *
 * The case is not hypothetical on the platform this code is for. Windows refuses
 * to remove a directory another process has open — an indexer, an antivirus
 * scanner, a file watcher — and the probe's own removal used to run in a
 * `finally` with nothing around it, so an `EPERM` there replaced the answer the
 * probe had already worked out with a thrown error, out of a function whose
 * whole promise is that it never throws. Every skill link in the sync would then
 * fail on the tidying-up of a temporary directory nobody asked about.
 *
 * @module apply/__tests__/link-probe-cleanup
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }),
  };
});

const { canSymlinkDirs, setDirSymlinkProbe } = await import('../windows-links.js');

afterEach(() => {
  setDirSymlinkProbe(undefined);
});

describe('the directory-link capability probe', () => {
  it('AP-06: answers even when the probe directory cannot be removed', () => {
    // The real probe, on a filesystem whose `rmSync` always refuses. It made a
    // link or it did not; the leftover temp directory is not the caller's
    // problem and is certainly not an answer.
    setDirSymlinkProbe(undefined);

    expect(typeof canSymlinkDirs()).toBe('boolean');
  });
});
