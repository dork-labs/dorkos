/**
 * Who is offered the merge, and what a copy that has fallen behind is told
 * instead (spec `canvas-agent-seat` §8, ADR `260912-025253`).
 *
 * Three rules, one case each, and each one is something the screen could get
 * wrong in a way nobody would notice until it mattered:
 *
 * - a member who is not the operator being offered an action the server will
 *   refuse;
 * - a copy behind the room being offered a merge that cannot work, instead of
 *   the merge service's own sentence saying why;
 * - a room with no working copy for this author showing an affordance with
 *   nothing behind it.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Reading `viewerIsOperator` as truthy-or-not rather than "only an explicit
 *   `false` withholds" reddens the member case… and the absent case the other
 *   way, which is why both are here.
 * - Dropping the `behind > 0` guard reddens the behind case with a button.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('@/layers/shared/model', () => ({
  useIsMobile: () => false,
  useResolvedTheme: () => 'light' as const,
}));

/** What the room read answers about the viewer, per case. */
const room = { viewerIsOperator: undefined as boolean | undefined };
vi.mock('@/layers/entities/room', () => ({
  useRoom: () => ({ data: { viewerIsOperator: room.viewerIsOperator } }),
}));

/** What the review hook answers, per case. */
const review = {
  data: { base: 'const a = 1;\n', current: 'const a = 2;\n', currentHash: 'h' },
  isLoading: false,
  error: null as unknown,
  branch: {
    slug: 'ana',
    branch: 'room/ana',
    agent: 'Ana',
    authorId: 'author-ana',
    mine: false,
    hasWorktree: true,
    ahead: 3,
    behind: 0,
    dirty: false,
    stranded: true,
  } as Record<string, unknown> | null,
  hasNoBranch: false,
  conflict: false,
  writeFailed: false,
  writing: false,
  rejectHunk: vi.fn(),
  refresh: vi.fn(),
  merge: vi.fn(),
  merging: false,
  mergeRefusal: null as string | null,
  merged: false,
};
vi.mock('../model/use-worktree-diff', () => ({ useWorktreeDiff: () => review }));

// The heavy `@codemirror/merge` surface never renders under jsdom; stub it, and
// give the reject callback a handle so the write path stays reachable.
vi.mock('../ui/CodeMirrorDiff', () => ({
  CodeMirrorDiff: ({ onRejectHunk }: { onRejectHunk: (text: string) => void }) => (
    <button type="button" data-testid="cm-diff" onClick={() => onRejectHunk('reverted\n')}>
      diff
    </button>
  ),
}));

import type { UiCanvasContent } from '@dorkos/shared/types';
import { RoomWorktreeDiff } from '../ui/RoomWorktreeDiff';

const diff: Extract<UiCanvasContent, { type: 'diff' }> = {
  type: 'diff',
  sourcePath: 'src/App.tsx',
  mediaKind: 'text',
};

/** Render the surface with whatever the case has set up. */
function draw() {
  return render(
    <RoomWorktreeDiff roomId="room-1" content={diff} documentId="doc-1" authorId="author-ana" />
  );
}

beforeEach(() => {
  room.viewerIsOperator = true;
  review.branch = {
    slug: 'ana',
    branch: 'room/ana',
    agent: 'Ana',
    authorId: 'author-ana',
    mine: false,
    hasWorktree: true,
    ahead: 3,
    behind: 0,
    dirty: false,
    stranded: true,
  };
  review.hasNoBranch = false;
  review.mergeRefusal = null;
  review.merged = false;
  review.conflict = false;
  review.merge.mockReset();
  review.rejectHunk.mockReset();
});
afterEach(cleanup);

describe('RoomWorktreeDiff', () => {
  it('offers the merge to the operator', async () => {
    draw();
    expect(await screen.findByRole('button', { name: /merge into the room/i })).toBeInTheDocument();
  });

  it('offers it to nobody else', () => {
    room.viewerIsOperator = false;
    draw();
    expect(screen.queryByRole('button', { name: /merge into the room/i })).not.toBeInTheDocument();
  });

  it('still offers it when the room could not say who is looking', () => {
    // Absent means "this source cannot say", never `false` — hiding it on a
    // guess hides it from the one person who can take it.
    room.viewerIsOperator = undefined;
    draw();
    expect(screen.queryByRole('button', { name: /merge into the room/i })).toBeInTheDocument();
  });

  it('shows the merge service’s own sentence and no button when the copy is behind', () => {
    review.branch = { ...(review.branch as Record<string, unknown>), behind: 3, ahead: 2 };
    draw();

    expect(screen.getByText(/main is 3 commits ahead of your branch/i)).toBeInTheDocument();
    expect(screen.getByText(/ask Ana to do it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /merge into the room/i })).not.toBeInTheDocument();
  });

  it('offers nothing when the room names no working copy for this author', () => {
    review.branch = null;
    review.hasNoBranch = true;
    draw();
    expect(screen.queryByRole('button', { name: /merge into the room/i })).not.toBeInTheDocument();
  });

  it('offers nothing when the copy holds nothing the room has not got', () => {
    review.branch = { ...(review.branch as Record<string, unknown>), ahead: 0 };
    draw();
    expect(screen.queryByRole('button', { name: /merge into the room/i })).not.toBeInTheDocument();
  });

  it('asks what the work does before it merges, and sends what was typed', async () => {
    const user = userEvent.setup();
    draw();

    await user.click(screen.getByRole('button', { name: /merge into the room/i }));
    const field = screen.getByRole('textbox', { name: /what this work does/i });
    expect(field).toHaveValue('Merge ana');

    await user.clear(field);
    await user.type(field, 'Add the signup form');
    await user.click(screen.getByRole('button', { name: /^merge$/i }));

    expect(review.merge).toHaveBeenCalledWith('Add the signup form');
  });

  it('does not tell the operator to catch up on a merge that just worked', () => {
    // The merge commit moves `main` past the branch that produced it, so a
    // freshly merged copy IS behind — and answering a merge that worked with
    // "the room has moved on, ask them to catch up" is nonsense. Measured in the
    // browser, stacked under the line saying the work had landed.
    review.merged = true;
    review.branch = { ...(review.branch as Record<string, unknown>), behind: 1, ahead: 0 };
    draw();

    expect(screen.getByText(/This work is in the room now/i)).toBeInTheDocument();
    expect(screen.queryByText(/The room has moved on/i)).not.toBeInTheDocument();
  });

  it('shows the room’s own words for a merge it refused', () => {
    review.mergeRefusal = 'Your working copy has changes you have not committed.';
    draw();
    expect(screen.getByText(/changes you have not committed/i)).toBeInTheDocument();
  });

  it('shows the conflict banner when the file moved underneath the diff', () => {
    review.conflict = true;
    draw();
    expect(screen.getByText(/changed since the diff was computed/i)).toBeInTheDocument();
  });

  it('routes a rejected hunk to the review’s write', async () => {
    const user = userEvent.setup();
    draw();
    await user.click(await screen.findByTestId('cm-diff'));
    expect(review.rejectHunk).toHaveBeenCalledWith('reverted\n');
  });
});
