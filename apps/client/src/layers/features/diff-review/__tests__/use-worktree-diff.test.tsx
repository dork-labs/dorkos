/**
 * Reading and writing an agent's working copy from a room's canvas (spec
 * `canvas-agent-seat` §8).
 *
 * The two reads and the one write, asserted at the seam they go through. The
 * point of each case is a place the hook could quietly do the wrong thing:
 *
 * - read the file out of the WRONG tree, by re-deriving a directory instead of
 *   using the row's own;
 * - report every line of a new file as added because the room's copy could not
 *   be read, rather than because the room does not have it;
 * - write a reject without the hash the diff was computed at, which is a blind
 *   clobber of whatever the agent wrote in between.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Passing `roomId` instead of `cwd` to `readFileContent` reddens "reads the
 *   agent's copy out of the tree the row recorded".
 * - Returning `''` for a room copy that is binary reddens "a room copy that is
 *   not text is an error, not an empty base".
 * - Dropping `expectedHash` from the write reddens the reject case.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const readFileContent = vi.fn();
const readRoomFileContent = vi.fn();
const readRoomRepoStatus = vi.fn();
const writeFile = vi.fn();
const mergeRoomMain = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useTransport: () => ({
    readFileContent,
    readRoomFileContent,
    readRoomRepoStatus,
    writeFile,
    mergeRoomMain,
  }),
}));

import { useWorktreeDiff } from '../model/use-worktree-diff';

const ARGS = {
  roomId: 'room-1',
  cwd: '/dork/rooms/room-1/worktrees/ana',
  sourcePath: 'src/App.tsx',
  authorId: 'author-ana',
};

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
    readFileContent
      .mockReset()
      .mockResolvedValue({ content: 'const a = 2;\n', hash: 'worktree-hash', encoding: 'utf-8' });
    readRoomFileContent.mockReset().mockResolvedValue({
      path: 'src/App.tsx',
      commit: 'abc',
      size: 14,
      lastCommit: null,
      body: { kind: 'text', encoding: 'utf-8', text: 'const a = 1;\n' },
    });
    readRoomRepoStatus.mockReset().mockResolvedValue({
      mainCommit: 'abc',
      mainCommittedAt: null,
      main: { branch: 'main', dirty: false, strays: [], strayCount: 0 },
      branches: [BRANCH],
      strandedWorktrees: ['ana'],
      size: { usedBytes: 0, maxRepoBytes: 1, maxFileBytes: 1 },
    });
    writeFile.mockReset().mockResolvedValue({ ok: true, hash: 'new-hash' });
    mergeRoomMain.mockReset().mockResolvedValue({
      branch: 'room/ana',
      commit: 'def',
      files: 1,
      insertions: 1,
      deletions: 1,
      seq: 9,
    });
  });

  it('reads the agent’s copy out of the tree the row recorded, and the room’s out of the room', async () => {
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(readFileContent).toHaveBeenCalledWith(ARGS.cwd, 'src/App.tsx');
    expect(readRoomFileContent).toHaveBeenCalledWith('room-1', 'src/App.tsx');
    expect(result.current.data).toMatchObject({
      base: 'const a = 1;\n',
      current: 'const a = 2;\n',
      currentHash: 'worktree-hash',
    });
  });

  it('shows a file the branch ADDS against an empty base rather than failing', async () => {
    readRoomFileContent.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'ROOM_FILE_NOT_FOUND' })
    );
    const { result } = renderHook(() => useWorktreeDiff(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data?.base).toBe('');
  });

  it('refuses to draw a room copy that is not text as an empty base', async () => {
    readRoomFileContent.mockResolvedValue({
      path: 'src/logo.png',
      commit: 'abc',
      size: 900,
      lastCommit: null,
      body: { kind: 'binary' },
    });
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

    expect(writeFile).toHaveBeenCalledWith(ARGS.cwd, 'src/App.tsx', 'const a = 1;\n', {
      expectedHash: 'worktree-hash',
    });
    expect(result.current.conflict).toBe(false);
  });

  it('surfaces a conflict when the file moved underneath the diff, and clobbers nothing', async () => {
    writeFile.mockResolvedValue({
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
