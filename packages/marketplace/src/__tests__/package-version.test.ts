import { describe, it, expect } from 'vitest';
import {
  isRealCommitSha,
  resolvePackageVersion,
  RELATIVE_PATH_SENTINEL_SHA,
} from '../package-version.js';

const SHA = 'a'.repeat(40);

describe('resolvePackageVersion', () => {
  it('uses the version the package declares, as Claude Code does first', () => {
    // Purpose: step 1 of the chain. plugin.json's version is what Claude Code
    // loads the plugin by, so it must win.
    expect(resolvePackageVersion({ declaredVersion: '0.7.2' })).toEqual({
      version: '0.7.2',
      source: 'package',
    });
  });

  it("falls back to the marketplace entry's version when the package declares none", () => {
    // Purpose: step 2 of the chain, for third-party marketplaces that set a
    // version on the entry and nowhere else.
    expect(resolvePackageVersion({ entryVersion: '1.2.0', commitSha: SHA })).toEqual({
      version: '1.2.0',
      source: 'index',
    });
  });

  it("prefers the package's own version over the entry's", () => {
    // Purpose: plugin.json silently wins over the entry in Claude Code; a
    // resolver that preferred the entry would report a version nobody runs.
    expect(resolvePackageVersion({ declaredVersion: '2.0.0', entryVersion: '1.0.0' })).toEqual({
      version: '2.0.0',
      source: 'package',
    });
  });

  it('uses the full commit SHA when neither the package nor the entry states a version', () => {
    // Purpose: step 3. A package that declares no version is identified by the
    // commit it was fetched at, never by a masking '0.0.0'.
    expect(resolvePackageVersion({ commitSha: SHA })).toEqual({ version: SHA, source: 'commit' });
  });

  it('never treats a placeholder commit as a version', () => {
    // Purpose: a failed ls-remote writes tmp-<ms>; comparing two placeholders
    // would report an update every time the network hiccups.
    expect(resolvePackageVersion({ commitSha: 'tmp-123' })).toBeUndefined();
  });

  it('returns undefined when nothing is known, and treats empty strings as absent', () => {
    // Purpose: "unknown" must be distinguishable from any real version.
    expect(resolvePackageVersion({})).toBeUndefined();
    expect(
      resolvePackageVersion({ declaredVersion: '', entryVersion: '', commitSha: '' })
    ).toBeUndefined();
  });
});

describe('isRealCommitSha', () => {
  it('rejects every placeholder the fetchers write in place of a commit', () => {
    // Purpose: each sentinel is a fabricated value (DOR-147); letting one
    // through records or compares a commit that never existed.
    expect(isRealCommitSha(undefined)).toBe(false);
    expect(isRealCommitSha('tmp-1737000000000')).toBe(false);
    expect(isRealCommitSha('local')).toBe(false);
    expect(isRealCommitSha('relative-path')).toBe(false);
    expect(isRealCommitSha(RELATIVE_PATH_SENTINEL_SHA)).toBe(false);
    expect(isRealCommitSha('')).toBe(false);
  });

  it('accepts a real 40-hex commit SHA', () => {
    // Purpose: the guard must not reject the values it exists to let through.
    expect(isRealCommitSha('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });
});
