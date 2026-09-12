/**
 * What a canvas row tells a reader about the tree it came out of (spec
 * `canvas-agent-seat` §8).
 *
 * One asymmetry, asserted both ways because it is a need-to-know rule rather
 * than an implementation detail. A room's WORKING COPIES are the room's own —
 * DorkOS made them under the room's home, and every member can already read
 * their slugs off the repo status — so the review surface is told which one to
 * read and write. An `agent-cwd` is somebody's own project directory, which is
 * not the room's to publish and which nothing in the app could open anyway.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Sending `resolvedCwd` for every row reddens the `agent-cwd` and `room-main`
 *   cases.
 * - Sending it for none reddens the worktree case, and the whole review surface
 *   with it: a reject would have no tree to land in.
 *
 * @module server/services/canvas/tests/document-projection
 */
import { describe, it, expect } from 'vitest';
import { toCanvasDocument, type CanvasDocumentRow } from '../canvas-document-store.js';
import { CANVAS_EDIT_TTL_MS } from '../canvas-service.js';

/** A stored row, with whatever tree facts a case is about. */
function row(tree: Partial<CanvasDocumentRow>): CanvasDocumentRow {
  return {
    id: 'doc-1',
    scope: 'room:room-1',
    roomId: 'room-1',
    content: { type: 'diff', sourcePath: 'src/App.tsx' },
    title: 'App.tsx',
    contentType: 'diff',
    authorId: 'author-ana',
    sourceKey: 'diff:src/App.tsx',
    sourceLabel: null,
    resolvedCwd: '/dork/rooms/room-1/worktrees/ana',
    treeKind: null,
    aheadOfMain: null,
    pinned: false,
    rev: 1,
    lastTouchedBy: 'author-ana',
    lastTouchedAt: '2026-09-12T00:00:00.000Z',
    editingBy: null,
    editingHeartbeatAt: null,
    openedAt: '2026-09-12T00:00:00.000Z',
    lastActiveAt: '2026-09-12T00:00:00.000Z',
    ...tree,
  };
}

/** Project one row the way every reader is handed it. */
function project(tree: Partial<CanvasDocumentRow>) {
  return toCanvasDocument(row(tree), Date.parse('2026-09-12T00:00:00.000Z'), CANVAS_EDIT_TTL_MS);
}

describe('toCanvasDocument and the tree a document came from', () => {
  it('tells a reader which working copy a room worktree document is in', () => {
    const document = project({ treeKind: 'worktree', aheadOfMain: 3 });

    expect(document.resolvedCwd).toBe('/dork/rooms/room-1/worktrees/ana');
    expect(document).toMatchObject({ treeKind: 'worktree', aheadOfMain: 3 });
  });

  it('withholds somebody’s own project directory', () => {
    expect(project({ treeKind: 'agent-cwd', aheadOfMain: null }).resolvedCwd).toBeUndefined();
  });

  it('withholds the room’s own checkout, which nothing needs to be told', () => {
    expect(project({ treeKind: 'room-main', aheadOfMain: null }).resolvedCwd).toBeUndefined();
  });

  it('withholds it for a document that names no tree at all', () => {
    expect(project({ treeKind: null }).resolvedCwd).toBeUndefined();
  });

  it('sends nothing for a worktree row that recorded no directory', () => {
    expect(
      project({ treeKind: 'worktree', aheadOfMain: 1, resolvedCwd: null }).resolvedCwd
    ).toBeUndefined();
  });
});
