/**
 * Whose identity a session carries, given where it stands (DOR-2091).
 *
 * The rule in `identity-anchor.ts`, pinned at the seam every runtime now asks.
 * The worktree manager's own half — that it records an owner when it hands a
 * tree out, and only then — is pinned beside the manager in
 * `rooms/repo/__tests__/room-worktree-manager.test.ts`, against real git; the
 * whole chain, from a room turn's launch to a post landing under the right name,
 * in `rooms/__tests__/room-worktree-identity.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  anchorPath,
  resolveIdentityAnchor,
  setWorkingCopyOwnerPort,
  type WorkingCopyOwnerPort,
} from '../identity-anchor.js';

const ANA = '/agents/ana';
const BEN = '/agents/ben';
const WORKTREES = '/dork/rooms/01ROOM/worktrees';
const ANA_WORKTREE = `${WORKTREES}/ana-1a2b3c4d`;
const STRAY_WORKTREE = `${WORKTREES}/ana-00000000`;

/** A port with the manager's shape: location decides "a working copy", a record decides whose. */
function portFor(owners: Record<string, string>): WorkingCopyOwnerPort {
  return {
    ownerOf: (dir) =>
      path.dirname(path.resolve(dir)) === WORKTREES
        ? { owner: owners[path.resolve(dir)] ?? null }
        : null,
  };
}

describe('resolveIdentityAnchor', () => {
  afterEach(() => {
    setWorkingCopyOwnerPort(undefined);
  });

  it('anchors an ordinary directory to itself, exactly as the lookup always did', () => {
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveIdentityAnchor(ANA)).toEqual({ kind: 'path', agentPath: ANA });
    expect(resolveIdentityAnchor('/somewhere/plain')).toEqual({
      kind: 'path',
      agentPath: '/somewhere/plain',
    });
  });

  it('anchors a room working copy to the agent it was handed to', () => {
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveIdentityAnchor(ANA_WORKTREE)).toEqual({ kind: 'path', agentPath: ANA });
    expect(resolveIdentityAnchor(ANA_WORKTREE, ANA)).toEqual({ kind: 'path', agentPath: ANA });
  });

  it('never anchors by prefix: a directory inside an agent, or inside its worktree, is itself', () => {
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(anchorPath(resolveIdentityAnchor(`${ANA}/src`))).toBe(`${ANA}/src`);
    expect(anchorPath(resolveIdentityAnchor(`${ANA_WORKTREE}/src`))).toBe(`${ANA_WORKTREE}/src`);
  });

  it('refuses a working copy nobody can vouch for, rather than reading it as nobody', () => {
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveIdentityAnchor(STRAY_WORKTREE)).toEqual({
      kind: 'refused',
      reason: 'unowned-working-copy',
    });
    // Naming the right agent does not buy a working copy an owner.
    expect(resolveIdentityAnchor(STRAY_WORKTREE, ANA).kind).toBe('refused');
  });

  it("refuses agent A's working copy for a turn that is for agent B", () => {
    setWorkingCopyOwnerPort(portFor({ [ANA_WORKTREE]: ANA }));

    expect(resolveIdentityAnchor(ANA_WORKTREE, BEN)).toEqual({
      kind: 'refused',
      reason: 'not-the-turns-agent',
    });
  });

  it("refuses agent A's own folder, or any other directory, for a turn that is for agent B", () => {
    // The room-turn cross-check is not only about worktrees: a turn for Ben
    // that ends up standing in Ana's folder — or in a default directory that
    // happens to be hers — must not act as her either.
    expect(resolveIdentityAnchor(ANA, BEN).kind).toBe('refused');
    expect(resolveIdentityAnchor('/default/cwd', BEN).kind).toBe('refused');
    // The same agent spelled with a trailing slash is still the same agent.
    expect(resolveIdentityAnchor(`${BEN}/`, BEN)).toEqual({ kind: 'path', agentPath: `${BEN}/` });
  });

  it('fails CLOSED when the working-copy lookup throws', () => {
    setWorkingCopyOwnerPort({
      ownerOf: () => {
        throw new Error('the manager is gone');
      },
    });

    expect(resolveIdentityAnchor(ANA).kind).toBe('refused');
  });

  it('refuses a turn that names its agent but stands nowhere, rather than reading it as nobody', () => {
    expect(resolveIdentityAnchor(undefined, ANA)).toEqual({
      kind: 'refused',
      reason: 'not-the-turns-agent',
    });
  });

  it('answers none for no directory, and treats every directory as itself with no port wired', () => {
    expect(resolveIdentityAnchor(undefined)).toEqual({ kind: 'none' });
    expect(resolveIdentityAnchor(ANA_WORKTREE)).toEqual({ kind: 'path', agentPath: ANA_WORKTREE });
  });
});
