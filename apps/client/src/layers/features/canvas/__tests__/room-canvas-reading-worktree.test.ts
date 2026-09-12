/**
 * Which document on a room's table becomes a review, and which stays a card
 * (spec `canvas-agent-seat` §8).
 *
 * Four things have to be true together, and each of the negative cases here
 * rules one of them out — because getting any of them wrong sends somebody to a
 * surface that offers a merge for work that is not there:
 *
 * - it is a `diff`, not a file somebody opened to read;
 * - the tree is a room WORKTREE — `room-main` is the shared copy with nothing to
 *   merge, `agent-cwd` is a room with no files of its own;
 * - the copy is measurably AHEAD. `null` means nobody asked, which is a
 *   different claim from "level with the room" and must never be shown as one;
 * - the row actually recorded the directory, which only a worktree row does.
 *
 * Seeded defect: reading `aheadOfMain` as truthy rather than "a number greater
 * than zero" reddens the not-measured case, which is the one that matters — it
 * is the difference between "there is nothing to merge" and "nobody checked".
 *
 * @module features/canvas/tests/room-canvas-reading-worktree
 */
import { describe, it, expect } from 'vitest';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import { roomDocumentReading } from '../lib/room-canvas-reading';

/** A diff document on a room's table, with the tree facts a case varies. */
function diffDocument(tree: Partial<CanvasDocument>): CanvasDocument {
  return {
    id: 'doc-1',
    scope: 'room:room-1',
    roomId: 'room-1',
    content: { type: 'diff', sourcePath: 'src/App.tsx' },
    title: 'App.tsx',
    contentType: 'diff',
    authorId: 'author-ana',
    pinned: false,
    rev: 1,
    lastTouchedBy: 'author-ana',
    lastTouchedAt: '2026-09-12T00:00:00.000Z',
    openedAt: '2026-09-12T00:00:00.000Z',
    lastActiveAt: '2026-09-12T00:00:00.000Z',
    ...tree,
  };
}

/** The shape a worktree row really has: a directory and a measured count. */
const AHEAD = {
  treeKind: 'worktree' as const,
  aheadOfMain: 3,
  resolvedCwd: '/dork/rooms/room-1/worktrees/ana',
  sourceLabel: 'Ana’s copy · 3 ahead of main',
};

describe('roomDocumentReading for a worktree diff', () => {
  it('sends an agent’s copy that is ahead of the room to the review', () => {
    const reading = roomDocumentReading(diffDocument(AHEAD));

    expect(reading.kind).toBe('worktree-diff');
    expect(reading).toMatchObject({
      sourcePath: 'src/App.tsx',
      cwd: '/dork/rooms/room-1/worktrees/ana',
    });
  });

  it('leaves a copy that is level with the room as a card', () => {
    expect(roomDocumentReading(diffDocument({ ...AHEAD, aheadOfMain: 0 })).kind).toBe('elsewhere');
  });

  it('leaves a copy nobody measured as a card', () => {
    // `null` is "git could not be asked", which is not the same as "nothing to
    // merge" and must not be treated as zero OR as something to merge.
    expect(roomDocumentReading(diffDocument({ ...AHEAD, aheadOfMain: null })).kind).toBe(
      'elsewhere'
    );
  });

  it('leaves somebody’s own project alone', () => {
    expect(roomDocumentReading(diffDocument({ ...AHEAD, treeKind: 'agent-cwd' })).kind).toBe(
      'elsewhere'
    );
  });

  it('leaves the room’s own shared copy as the room file it is', () => {
    expect(
      roomDocumentReading(
        diffDocument({ treeKind: 'room-main', aheadOfMain: null, sourceLabel: undefined })
      ).kind
    ).toBe('room-file');
  });

  it('leaves a worktree row that recorded no directory as a card', () => {
    const { resolvedCwd: _dropped, ...withoutCwd } = AHEAD;
    expect(roomDocumentReading(diffDocument(withoutCwd)).kind).toBe('elsewhere');
  });

  it('leaves a FILE somebody opened from the same copy as a card', () => {
    const document = diffDocument({
      ...AHEAD,
      content: { type: 'file', sourcePath: 'src/App.tsx' },
      contentType: 'file',
    });
    expect(roomDocumentReading(document).kind).toBe('elsewhere');
  });
});
