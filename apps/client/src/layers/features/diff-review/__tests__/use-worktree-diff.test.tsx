/**
 * Reading and writing an agent's working copy from a room's canvas (spec
 * `canvas-agent-seat` §8).
 *
 * The read, the write and the merge, asserted at the seam they go through. The
 * point of each case is a place the hook could quietly do the wrong thing:
 *
 * - reach for the ORDINARY file API, which is confined to the operator's
 *   project boundary and refuses a working copy under the DorkOS data directory
 *   — measured in the browser as "this file's changes couldn't be loaded";
 * - write a reject without the hash the diff was computed at, which is a blind
 *   clobber of whatever the agent wrote in between;
 * - merge a branch that is not the one this document's author owns.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Calling `readFileContent`/`writeFile` instead of the room routes reddens the
 *   read case and the reject case: the mock transport's file methods are not
 *   wired here at all, which is the point.
 * - Dropping `expectedHash` from the write reddens the reject case.
 * - Joining the branch row on anything but `authorId` reddens "finds the branch
 *   row for this document's author".
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const readRoomCanvasDiff = vi.fn();
const writeRoomCanvasDiff = vi.fn();
const readRoomRepoStatus = vi.fn();
const mergeRoomMain = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useTransport: () => ({
    readRoomCanvasDiff,
    writeRoomCanvasDiff,
    readRoomRepoStatus,
    mergeRoomMain,
  }),
}));

import { useWorktreeDiff } from '../model/use-worktree-diff';

const ARGS = { roomId: 'room-1', documentId: 'doc-1', authorId: 'author-ana' };

/** One branch row, as the room's repo status reports it. */
const BRANCH = {
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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useWorktreeDiff', () => {
  beforeEach(() => {
    readRoomCanvasDiff.mockReset().mockResolvedValue({
      path: 'src/App.tsx',
      base: 'const a = 1;\n',
      current: 'const a = 2;\n',
      currentHash: 'worktree-hash',
    });
    readRoomRepoStatus.mockReset().mockResolvedValue({
      mainCommit: 'abc',
      mainCommittedAt: null,
      main: { branch: 'main', dirty: false, strays: [], strayCount: 0 },
      branches: [BRANCH],
      strandedWorktrees: ['ana'],
      size: { usedBytes: 0, maxRepoBytes: 1, maxFileBytes: 1 },
    });
    writeRoomCanvasDiff.mockReset().mockResolvedValue({ ok: true, hash: 'new-hash' });
    mergeRoomMain.mockReset().mockResolvedValue({
      branch: 'room/ana',
      commit: 'def',
      files: 1,
      insertions: 1,
      deletions: 1,
      seq: 9,
    });
  });

  it('asks the ROOM for both copies, by document rather than by directory', async () => {
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(readRoomCanvasDiff).toHaveBeenCalledWith('room-1', 'doc-1');
    expect(result.current.data).toMatchObject({
      base: 'const a = 1;\n',
      current: 'const a = 2;\n',
      currentHash: 'worktree-hash',
    });
  });

  it('surfaces a room that could not answer rather than drawing an empty diff', async () => {
    readRoomCanvasDiff.mockRejectedValue(
      Object.assign(new Error('not there any more'), { code: 'ROOM_FILE_NOT_FOUND' })
    );
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeUndefined();
  });

  it('finds the branch row for this document’s author', async () => {
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.branch).not.toBeNull());

    expect(result.current.branch?.slug).toBe('ana');
    expect(result.current.hasNoBranch).toBe(false);
  });

  it('says so when the room names no working copy for this author', async () => {
    readRoomRepoStatus.mockResolvedValue({
      mainCommit: 'abc',
      mainCommittedAt: null,
      main: { branch: 'main', dirty: false, strays: [], strayCount: 0 },
      branches: [{ ...BRANCH, authorId: 'author-somebody-else' }],
      strandedWorktrees: [],
      size: { usedBytes: 0, maxRepoBytes: 1, maxFileBytes: 1 },
    });
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });

    await waitFor(() => expect(result.current.hasNoBranch).toBe(true));
    expect(result.current.branch).toBeNull();
  });

  it('writes a rejected hunk into the agent’s copy, against the hash it was computed at', async () => {
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(async () => {
      await result.current.rejectHunk('const a = 1;\n');
    });

    expect(writeRoomCanvasDiff).toHaveBeenCalledWith('room-1', 'doc-1', {
      content: 'const a = 1;\n',
      expectedHash: 'worktree-hash',
    });
    expect(result.current.conflict).toBe(false);
  });

  it('surfaces a conflict when the file moved underneath the diff, and clobbers nothing', async () => {
    writeRoomCanvasDiff.mockResolvedValue({
      ok: false,
      conflict: { currentHash: 'moved', currentContent: 'something else\n' },
    });
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.rejectHunk('const a = 1;\n');
    });

    expect(outcome).toBe('conflict');
    await waitFor(() => expect(result.current.conflict).toBe(true));
  });

  it('merges the branch the row belongs to, by slug', async () => {
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.branch).not.toBeNull());

    act(() => result.current.merge('Add the thing'));

    await waitFor(() => expect(result.current.merged).toBe(true));
    expect(mergeRoomMain).toHaveBeenCalledWith('room-1', {
      summary: 'Add the thing',
      worktree: 'ana',
    });
  });

  it('keeps the room’s own words for a merge it refused', async () => {
    mergeRoomMain.mockRejectedValue(
      Object.assign(new Error('The room has moved on: main is 2 commits ahead of your branch.'), {
        code: 'BEHIND_MAIN',
      })
    );
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.branch).not.toBeNull());

    act(() => result.current.merge('Add the thing'));

    await waitFor(() => expect(result.current.mergeRefusal).not.toBeNull());
    expect(result.current.mergeRefusal).toContain('The room has moved on');
    expect(result.current.merged).toBe(false);
  });
});
