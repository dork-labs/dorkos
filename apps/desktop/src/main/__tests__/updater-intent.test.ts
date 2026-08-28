/**
 * The install-intent file and the ordering the next-launch verdict is made of
 * (spec `desktop-updater-overhaul` D1/D2).
 *
 * Driven against the REAL `node:fs` in a throwaway `userData` directory rather
 * than a mocked one. The whole point of this file is that it survives a process
 * exit, so a test that asserted "`writeFileSync` was called" would prove the
 * call and not the property — and the JSON round-trip, the attempts arithmetic
 * that reads back what it wrote, and the delete are exactly where this can go
 * wrong.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { app, resetElectronMock, mockUserDataPath } from './electron-mock';
import {
  clearUpdateIntent,
  isAtLeastVersion,
  isNewerVersion,
  readUpdateIntent,
  writeUpdateIntent,
} from '../updater-intent';

/** The file the module owns, in whichever throwaway directory this test got. */
function intentFile(): string {
  return join(mockUserDataPath(), 'updater-intent.json');
}

beforeEach(() => {
  // A fresh, non-existent userData directory per test — see `electron-mock.ts`.
  resetElectronMock();
});

describe('the install-intent file', () => {
  it('reads as nothing on a machine that has never attempted an install', () => {
    expect(readUpdateIntent()).toBeNull();
    // And nothing was created just by asking.
    expect(existsSync(intentFile())).toBe(false);
  });

  it('records the first attempt as attempt 1, and reads back exactly what it wrote', () => {
    const written = writeUpdateIntent('0.63.0');

    expect(written).toMatchObject({ offeredVersion: '0.63.0', attempts: 1 });
    expect(readUpdateIntent()).toEqual(written);
    // Timestamped in a form a person reading a diagnostic report can use.
    expect(new Date(written?.attemptedAt ?? '').toString()).not.toBe('Invalid Date');
  });

  it('counts a second attempt at the same version', () => {
    writeUpdateIntent('0.63.0');
    const second = writeUpdateIntent('0.63.0');

    expect(second?.attempts).toBe(2);
    expect(readUpdateIntent()?.attempts).toBe(2);
  });

  it('starts over when a different version is offered', () => {
    writeUpdateIntent('0.63.0');
    writeUpdateIntent('0.63.0');
    const fresh = writeUpdateIntent('0.64.0');

    // Carrying the old count forward would push a brand-new update straight
    // past the "stop re-offering the restart" threshold on its first try.
    expect(fresh).toMatchObject({ offeredVersion: '0.64.0', attempts: 1 });
  });

  it('forgets the attempt when asked, and tolerates being asked twice', () => {
    writeUpdateIntent('0.63.0');
    clearUpdateIntent();

    expect(readUpdateIntent()).toBeNull();
    expect(existsSync(intentFile())).toBe(false);
    expect(() => clearUpdateIntent()).not.toThrow();
  });

  it('treats a corrupt file as no record at all', () => {
    mkdirSync(mockUserDataPath(), { recursive: true });
    writeFileSync(intentFile(), '{ this is not json');

    // The verdict this feeds accuses the updater of failing; it must never
    // rest on a file we could not read.
    expect(readUpdateIntent()).toBeNull();
  });

  it('treats a well-formed file with the wrong shape as no record at all', () => {
    mkdirSync(mockUserDataPath(), { recursive: true });
    writeFileSync(intentFile(), JSON.stringify({ offeredVersion: 7, attempts: 'lots' }));

    expect(readUpdateIntent()).toBeNull();
  });

  it.each([
    ['an empty version', ''],
    ['a version that is not one', 'latest'],
    ['a truncated version', '0.63'],
  ])('deletes a record naming %s, instead of wedging the card on it for ever', (_name, version) => {
    // A typed-but-unreadable version passed the old guard, and every comparison
    // against it answers `false` — so the card showed a failed install that no
    // amount of successful updating could clear. Nothing else deletes this
    // file: the success path only removes a record it could read.
    mkdirSync(mockUserDataPath(), { recursive: true });
    writeFileSync(
      intentFile(),
      JSON.stringify({ offeredVersion: version, attemptedAt: 'now', attempts: 1 })
    );

    expect(readUpdateIntent()).toBeNull();
    expect(existsSync(intentFile())).toBe(false);
  });

  it('rejects an attempt count that is not a real count', () => {
    mkdirSync(mockUserDataPath(), { recursive: true });
    writeFileSync(
      intentFile(),
      JSON.stringify({ offeredVersion: '0.63.0', attemptedAt: 'now', attempts: 0 })
    );

    expect(readUpdateIntent()).toBeNull();
  });

  it('never throws out of a quit sequence when the directory cannot be written', () => {
    // A userData path that cannot be created (a file stands where the
    // directory would go) — the shape of a locked-down or full disk.
    const blocked = join(mockUserDataPath(), '..', 'blocked');
    mkdirSync(join(blocked, '..'), { recursive: true });
    writeFileSync(blocked, 'not a directory');
    app.getPath = vi.fn(() => blocked);

    expect(writeUpdateIntent('0.63.0')).toBeNull();
    expect(readUpdateIntent()).toBeNull();
  });
});

describe('version ordering (the verdict)', () => {
  it('calls the update installed when the running version reached it', () => {
    expect(isAtLeastVersion('0.63.0', '0.63.0')).toBe(true);
    expect(isAtLeastVersion('0.63.1', '0.63.0')).toBe(true);
    expect(isAtLeastVersion('0.64.0', '0.63.9')).toBe(true);
    expect(isAtLeastVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('calls the update failed when the running version is still behind', () => {
    expect(isAtLeastVersion('0.62.0', '0.63.0')).toBe(false);
    expect(isAtLeastVersion('0.63.0', '0.63.1')).toBe(false);
    // The reporting user's actual state: stuck on 0.58 while 0.63 was staged.
    expect(isAtLeastVersion('0.58.0', '0.63.0')).toBe(false);
  });

  it('compares numerically, not as text', () => {
    // '0.9.0' > '0.63.0' as strings, which is how a naive comparison declares a
    // ten-version-old app up to date.
    expect(isAtLeastVersion('0.9.0', '0.63.0')).toBe(false);
    expect(isAtLeastVersion('0.63.0', '0.9.0')).toBe(true);
  });

  it('orders a prerelease below the release it leads to', () => {
    expect(isAtLeastVersion('1.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isAtLeastVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isAtLeastVersion('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true);
    expect(isAtLeastVersion('1.0.0-rc.10', '1.0.0-rc.9')).toBe(true);
    expect(isAtLeastVersion('1.0.0-alpha', '1.0.0-beta')).toBe(false);
    expect(isAtLeastVersion('1.0.0-alpha.1', '1.0.0-alpha')).toBe(true);
  });

  it('ignores build metadata, which semver does not order by', () => {
    expect(isAtLeastVersion('1.0.0+build.7', '1.0.0')).toBe(true);
    expect(isAtLeastVersion('1.0.0', '1.0.0+build.7')).toBe(true);
  });

  it('refuses to call an unreadable version a success', () => {
    // Erring toward "the update did not land" shows a person a card they can
    // act on; erring the other way is the silence this feature exists to end.
    expect(isAtLeastVersion('not-a-version', '0.63.0')).toBe(false);
    expect(isAtLeastVersion('0.63.0', '')).toBe(false);
    expect(isAtLeastVersion('0.63', '0.63.0')).toBe(false);
  });

  it('is strict about NEWER, so re-downloading the same version is not progress', () => {
    // The updater re-stages the version that just failed on its next check.
    expect(isNewerVersion('0.63.0', '0.63.0')).toBe(false);
    expect(isNewerVersion('0.63.1', '0.63.0')).toBe(true);
    expect(isNewerVersion('0.62.0', '0.63.0')).toBe(false);
    expect(isNewerVersion('nonsense', '0.63.0')).toBe(false);
  });
});
