/**
 * The one validator for a turn's folder grants (spec `agent-home-desk` §4.1,
 * §11 "Grant validation").
 *
 * Each rejection is paired with the nearest set that passes, so a rule that
 * started rejecting everything would fail the pass case rather than looking
 * like a working guard.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertValidDirectoryGrants,
  directoryGrantsFingerprint,
  DirectoryGrantError,
  isSameOrInside,
} from '../directory-grants.js';
import type { DirectoryGrant } from '../agent-runtime.js';

// A root that exists on no machine, so `realpath` resolves every fixture path
// to itself (a real `/home` is a symlink on macOS).
const ROOT = '/dorkos-grant-fixture';
const HOME = `${ROOT}/ana`;
const CWD = `${HOME}/.dork/agents/ana`;

function check(grants: DirectoryGrant[]): void {
  assertValidDirectoryGrants(grants, CWD, HOME);
}

describe('assertValidDirectoryGrants', () => {
  it('accepts absolute, normalized, distinct folders outside the cwd', () => {
    expect(() =>
      check([
        { path: `${HOME}/.dork/rooms/r1/worktrees/ana`, access: 'write' },
        { path: `${HOME}/.dork/rooms/r1/repo`, access: 'read' },
        // Nested inside another grant is legal: the room's `repo/.git`.
        { path: `${HOME}/.dork/rooms/r1/repo/.git`, access: 'write' },
        // A sibling of the cwd's parent.
        { path: `${HOME}/.dork/shared`, access: 'read' },
      ])
    ).not.toThrow();
  });

  it('accepts an empty set', () => {
    expect(() => check([])).not.toThrow();
  });

  it.each([
    ['a relative path', [{ path: 'rooms/r1', access: 'write' }], /not an absolute path/],
    ['an unnormalized path', [{ path: `${HOME}/rooms/../x`, access: 'read' }], /normalized/],
    ['a trailing separator', [{ path: `${HOME}/rooms/`, access: 'read' }], /normalized/],
    ['the filesystem root', [{ path: '/', access: 'read' }], /filesystem root/],
    ['the home folder itself', [{ path: HOME, access: 'read' }], /home folder/],
    ['a folder above the home folder', [{ path: ROOT, access: 'write' }], /contains it/],
    [
      'a folder that contains the cwd',
      [{ path: `${HOME}/.dork/agents`, access: 'write' }],
      /contains the turn's own directory/,
    ],
    [
      'a read grant inside a write grant',
      [
        { path: `${HOME}/.dork/rooms/r1`, access: 'write' },
        { path: `${HOME}/.dork/rooms/r1/repo`, access: 'read' },
      ],
      /read-only inside the write grant/,
    ],
    ['the cwd itself', [{ path: CWD, access: 'write' }], /own directory or inside it/],
    ['a folder inside the cwd', [{ path: `${CWD}/src`, access: 'read' }], /inside it/],
    [
      'the same path twice, even with different access',
      [
        { path: `${ROOT}/srv/shared`, access: 'read' },
        { path: `${ROOT}/srv/shared`, access: 'write' },
      ],
      /more than once/,
    ],
    ['an unknown access', [{ path: `${ROOT}/srv/shared`, access: 'admin' }], /valid access/],
  ] as const)('rejects %s', (_label, grants, message) => {
    expect(() => check(grants as unknown as DirectoryGrant[])).toThrow(DirectoryGrantError);
    expect(() => check(grants as unknown as DirectoryGrant[])).toThrow(message);
  });

  it('refuses a grant spelled through a symlink, naming the resolved spelling', async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-grant-link-')));
    try {
      await mkdir(path.join(base, 'room'));
      await symlink(path.join(base, 'room'), path.join(base, 'linked'));
      const home = path.join(base, 'home');
      const cwd = path.join(home, 'agent');
      expect(() =>
        assertValidDirectoryGrants([{ path: path.join(base, 'linked'), access: 'read' }], cwd, home)
      ).toThrow(/not realpath-resolved .*room/);
      expect(() =>
        assertValidDirectoryGrants([{ path: path.join(base, 'room'), access: 'read' }], cwd, home)
      ).not.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
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
