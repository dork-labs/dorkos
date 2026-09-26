/**
 * The one validator for a turn's folder grants (spec `agent-home-desk` §4.1,
 * §11 "Grant validation").
 *
 * Each rejection is paired with the nearest set that passes, so a rule that
 * started rejecting everything would fail the pass case rather than looking
 * like a working guard.
 */
import { describe, it, expect } from 'vitest';
import {
  assertValidDirectoryGrants,
  directoryGrantsFingerprint,
  DirectoryGrantError,
  isSameOrInside,
} from '../directory-grants.js';
import type { DirectoryGrant } from '../agent-runtime.js';

const CWD = '/home/ana/agents/ana';
const HOME = '/home/ana';

function check(grants: DirectoryGrant[]): void {
  assertValidDirectoryGrants(grants, CWD, HOME);
}

describe('assertValidDirectoryGrants', () => {
  it('accepts absolute, normalized, distinct folders outside the cwd', () => {
    expect(() =>
      check([
        { path: '/home/ana/.dork/rooms/r1/worktrees/ana', access: 'write' },
        { path: '/home/ana/.dork/rooms/r1/repo', access: 'read' },
        // Nested inside another grant is legal: the room's `repo/.git`.
        { path: '/home/ana/.dork/rooms/r1/repo/.git', access: 'write' },
        // An ANCESTOR of the cwd is not inside it.
        { path: '/home/ana/agents', access: 'read' },
      ])
    ).not.toThrow();
  });

  it('accepts an empty set', () => {
    expect(() => check([])).not.toThrow();
  });

  it.each([
    ['a relative path', [{ path: 'rooms/r1', access: 'write' }], /not an absolute path/],
    ['an unnormalized path', [{ path: '/home/ana/rooms/../x', access: 'read' }], /normalized/],
    ['a trailing separator', [{ path: '/home/ana/rooms/', access: 'read' }], /normalized/],
    ['the filesystem root', [{ path: '/', access: 'read' }], /filesystem root/],
    ['the home folder itself', [{ path: HOME, access: 'read' }], /home folder/],
    ['the cwd itself', [{ path: CWD, access: 'write' }], /own directory or inside it/],
    ['a folder inside the cwd', [{ path: `${CWD}/src`, access: 'read' }], /inside it/],
    [
      'the same path twice, even with different access',
      [
        { path: '/srv/shared', access: 'read' },
        { path: '/srv/shared', access: 'write' },
      ],
      /more than once/,
    ],
    ['an unknown access', [{ path: '/srv/shared', access: 'admin' }], /valid access/],
  ] as const)('rejects %s', (_label, grants, message) => {
    expect(() => check(grants as unknown as DirectoryGrant[])).toThrow(DirectoryGrantError);
    expect(() => check(grants as unknown as DirectoryGrant[])).toThrow(message);
  });

  it('does not mistake a sibling that shares a prefix for the cwd', () => {
    expect(() => check([{ path: `${CWD}-notes`, access: 'read' }])).not.toThrow();
  });
});

describe('isSameOrInside', () => {
  it('matches by path segment, not by string prefix', () => {
    expect(isSameOrInside('/a/b', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/b/c.txt', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/bc', '/a/b')).toBe(false);
    expect(isSameOrInside('/a', '/a/b')).toBe(false);
    // A folder literally named `..x` is still inside.
    expect(isSameOrInside('/a/b/..x', '/a/b')).toBe(true);
  });
});

describe('directoryGrantsFingerprint', () => {
  const a: DirectoryGrant = { path: '/srv/a', access: 'write' };
  const b: DirectoryGrant = { path: '/srv/b', access: 'read' };

  it('is the same for the same set in a different order', () => {
    expect(directoryGrantsFingerprint([a, b])).toBe(directoryGrantsFingerprint([b, a]));
  });

  it('moves when a path or its access changes', () => {
    const base = directoryGrantsFingerprint([a, b]);
    expect(directoryGrantsFingerprint([a])).not.toBe(base);
    expect(directoryGrantsFingerprint([a, { ...b, access: 'write' }])).not.toBe(base);
  });

  it('treats absent and empty alike', () => {
    expect(directoryGrantsFingerprint(undefined)).toBe(directoryGrantsFingerprint([]));
  });
});
