/**
 * Tests for the marketplace path-safety guards.
 *
 * These are the guards that stand between a caller-supplied package name and
 * a `path.join` into `dorkHome` or the marketplace cache, so the cases below
 * are written as traversal attempts rather than as validation trivia.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  assertContainedIn,
  assertPackageName,
  assertPathSegment,
  InvalidPackageNameError,
  MarketplacePathError,
  PathEscapeError,
} from '../package-paths.js';

describe('assertPackageName', () => {
  it('accepts the kebab-case names every installed package directory uses', () => {
    for (const name of ['sentry', 'code-review-suite', 'a', 'plugin9', 'a1-b2-c3']) {
      expect(assertPackageName(name)).toBe(name);
    }
  });

  it.each([
    ['../../../etc', 'parent traversal'],
    ['..%2F..%2Fvictim', 'encoded traversal (already decoded by Express)'],
    ['a/../../b', 'embedded traversal'],
    ['/etc/passwd', 'absolute path'],
    ['..\\..\\windows', 'windows traversal'],
    ['..', 'bare parent'],
    ['.', 'bare self'],
    ['', 'empty'],
    ['pkg\0.txt', 'null byte'],
    ['Sentry', 'uppercase — never an install directory'],
    ['my plugin', 'space'],
  ])('refuses %s (%s)', (name) => {
    expect(() => assertPackageName(name)).toThrow(InvalidPackageNameError);
  });

  it('names the offending value in the message so the 400 is actionable', () => {
    expect(() => assertPackageName('../evil')).toThrow(/\.\.\/evil/);
  });
});

describe('assertPathSegment', () => {
  it('accepts repo-shaped names that are only ever cache keys', () => {
    // Deliberately looser than assertPackageName: `github:user/My.Repo` and
    // `Some_Plugin@https://…` resolve to names that never become an install
    // directory, and refusing them would break working installs.
    for (const name of ['My.Repo', 'Some_Plugin', 'repo.git', 'UPPER', 'a..b']) {
      expect(assertPathSegment(name)).toBe(name);
    }
  });

  it.each([
    ['a/../../../../x', 'the cache-key escape'],
    ['../x', 'parent traversal'],
    ['nested/name', 'forward slash'],
    ['nested\\name', 'backslash'],
    ['..', 'bare parent'],
    ['.', 'bare self'],
    ['', 'empty'],
    ['x\0y', 'null byte'],
    ['x'.repeat(129), 'absurd length'],
  ])('refuses %s (%s)', (name) => {
    expect(() => assertPathSegment(name)).toThrow(InvalidPackageNameError);
  });
});

describe('assertContainedIn', () => {
  const root = path.join(path.sep, 'cache', 'packages');

  it('accepts the root itself and anything nested under it', () => {
    expect(assertContainedIn(root, root)).toBe(root);
    const child = path.join(root, 'pkg@sha');
    expect(assertContainedIn(root, child)).toBe(child);
  });

  it('refuses a sibling directory that merely shares a name prefix', () => {
    expect(() => assertContainedIn(root, `${root}-evil`)).toThrow(PathEscapeError);
  });

  it('refuses a path that climbs out of the root', () => {
    expect(() => assertContainedIn(root, path.join(root, '..', '..', 'etc'))).toThrow(
      PathEscapeError
    );
  });

  it('shares a base class with the name guards so one catch covers both', () => {
    expect(new PathEscapeError('a', 'b')).toBeInstanceOf(MarketplacePathError);
    expect(new InvalidPackageNameError('a', 'b')).toBeInstanceOf(MarketplacePathError);
  });
});
