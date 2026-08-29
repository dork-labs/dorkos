/**
 * What the explorer's pending-work badge actually claims (spec `project-rooms`
 * §3.9).
 *
 * The reduction is small and the stakes are not symmetric: under-reporting
 * leaves somebody's work sitting in a directory nobody opens, and over-reporting
 * is how a badge becomes something people stop reading. So both directions are
 * pinned, including the two shapes the server's own two answers disagree about.
 */
import { describe, it, expect } from 'vitest';
import type { RoomBranchStatus, RoomRepoStatus } from '@dorkos/shared/room-repo';
import {
  pendingWorkIn,
  pendingWorkLabel,
  pendingWorkNames,
  pendingWorkSummary,
} from '../model/pending-work';

/** One agent's branch, level with the room unless a test says otherwise. */
function branch(overrides: Partial<RoomBranchStatus> & { slug: string }): RoomBranchStatus {
  return {
    branch: `room/${overrides.slug}`,
    agent: 'Ana',
    authorId: 'author-ana',
    mine: false,
    hasWorktree: true,
    ahead: 0,
    behind: 0,
    dirty: false,
    stranded: false,
    ...overrides,
  };
}

/** A room's files, with nothing unmerged unless a test says otherwise. */
function status(overrides: Partial<RoomRepoStatus> = {}): RoomRepoStatus {
  return {
    mainCommit: 'abc1234',
    mainCommittedAt: '2026-08-28T09:00:00.000Z',
    branches: [],
    strandedWorktrees: [],
    size: { usedBytes: 1024, maxRepoBytes: 500, maxFileBytes: 5 },
    ...overrides,
  };
}

describe('pendingWorkIn', () => {
  it('says nothing when everybody has merged', () => {
    expect(pendingWorkIn(status({ branches: [branch({ slug: 'ana-1' })] }))).toEqual([]);
  });

  it('reports a branch the room has not got', () => {
    const pending = pendingWorkIn(
      status({
        branches: [branch({ slug: 'ana-1', agent: 'Ana', ahead: 2, stranded: true })],
      })
    );
    expect(pending).toEqual([{ slug: 'ana-1', who: 'Ana', member: true, ahead: 2, dirty: false }]);
  });

  it('reports uncommitted changes as work too', () => {
    // A dirty working copy is unmerged work by the same definition the server
    // uses, and it is the one an agent can lose: nothing merges it, and the
    // reap spares it forever without anybody being told.
    const pending = pendingWorkIn(
      status({ branches: [branch({ slug: 'bo-2', agent: 'Bo', dirty: true, stranded: true })] })
    );
    expect(pending[0]).toMatchObject({ who: 'Bo', dirty: true, ahead: 0 });
  });

  it('reports a working copy no current member owns', () => {
    // The other half of the server's answer, and the half only it can see: an
    // agent that was renamed or left leaves its tree behind, and the work in it
    // is still somebody's. The roster walk cannot see it at all.
    const pending = pendingWorkIn(status({ strandedWorktrees: ['ghost-9f3d'] }));
    expect(pending).toEqual([
      { slug: 'ghost-9f3d', who: 'ghost-9f3d', member: false, ahead: 0, dirty: false },
    ]);
  });

  it('shows a working copy once when both answers name it', () => {
    // The common case, and the one a naive concatenation gets wrong: the roster
    // walk and the directory walk agree about a live agent, and a badge reading
    // "Ana, ana-1" would be reporting one person twice.
    const pending = pendingWorkIn(
      status({
        branches: [branch({ slug: 'ana-1', agent: 'Ana', ahead: 1, stranded: true })],
        strandedWorktrees: ['ana-1'],
      })
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ who: 'Ana', member: true });
  });
});

describe('pendingWorkLabel', () => {
  it('says nothing when there is nothing to say', () => {
    expect(pendingWorkLabel([])).toBeNull();
  });

  it('names everybody up to three', () => {
    const pending = pendingWorkIn(status({ strandedWorktrees: ['Ana', 'Bo', 'Kai'] }));
    expect(pendingWorkLabel(pending)).toBe('Ana, Bo, Kai');
  });

  it('counts the rest past three, so a header stays a header', () => {
    const pending = pendingWorkIn(status({ strandedWorktrees: ['Ana', 'Bo', 'Kai', 'Zed'] }));
    expect(pendingWorkLabel(pending)).toBe('Ana, Bo +2');
  });
});

describe('pendingWorkNames', () => {
  it('leaves distinct names alone', () => {
    const pending = pendingWorkIn(status({ strandedWorktrees: ['ana-1a2b', 'bo-3c4d'] }));
    expect(pendingWorkNames(pending)).toEqual(['ana-1a2b', 'bo-3c4d']);
  });

  it('tells two rows with the same display name apart', () => {
    // Display names are not unique, and telling people apart is the badge's
    // whole job. "Claude, Claude" reads as a rendering bug and answers nobody's
    // question. A slug ends in the digest of the agent's workspace path, so its
    // tail is the one thing that genuinely differs.
    const pending = pendingWorkIn(
      status({
        branches: [
          branch({ slug: 'claude-1a2b', agent: 'Claude', ahead: 1, stranded: true }),
          branch({ slug: 'claude-9f3d', agent: 'Claude', dirty: true, stranded: true }),
        ],
      })
    );
    expect(pendingWorkNames(pending)).toEqual(['Claude (1a2b)', 'Claude (9f3d)']);
    expect(pendingWorkLabel(pending)).toBe('Claude (1a2b), Claude (9f3d)');
  });

  it('marks only the colliding rows', () => {
    // The disambiguation is bought where it is needed and nowhere else, so a
    // room whose names are all distinct reads exactly as it did.
    const pending = pendingWorkIn(
      status({
        branches: [
          branch({ slug: 'claude-1a2b', agent: 'Claude', ahead: 1, stranded: true }),
          branch({ slug: 'claude-9f3d', agent: 'Claude', ahead: 1, stranded: true }),
          branch({ slug: 'ana-5e6f', agent: 'Ana', ahead: 1, stranded: true }),
        ],
      })
    );
    expect(pendingWorkNames(pending)).toEqual(['Claude (1a2b)', 'Claude (9f3d)', 'Ana']);
  });
});

describe('pendingWorkSummary', () => {
  it('counts one commit as one', () => {
    expect(
      pendingWorkSummary({ slug: 'a', who: 'Ana', member: true, ahead: 1, dirty: false })
    ).toBe('1 commit not merged');
  });

  it('says both halves when both are true', () => {
    // They need different things done about them: committed work is one merge
    // away, and uncommitted work has to be committed first.
    expect(pendingWorkSummary({ slug: 'a', who: 'Ana', member: true, ahead: 3, dirty: true })).toBe(
      '3 commits not merged, changes not committed'
    );
  });

  it('is honest about a working copy nothing could read', () => {
    expect(
      pendingWorkSummary({ slug: 'ghost', who: 'ghost', member: false, ahead: 0, dirty: false })
    ).toBe('work the room has not got');
  });
});
