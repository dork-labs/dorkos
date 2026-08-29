import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { roomKeys } from '@/layers/entities/room';
import { createRoomFilesSource } from '../model/room-files-source';
import { ROOM_FILES_REFRESH_INTERVAL_MS } from '../model/room-entry-watch';

const ROOM_ID = 'room-1';

function build() {
  const transport = createMockTransport();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const source = createRoomFilesSource({ transport, queryClient, roomId: ROOM_ID });
  return { transport, queryClient, source };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the room files source', () => {
  it('declares what a commit can and cannot do', () => {
    const { source } = build();
    expect(source.scopeKey).toBe('room:room-1');
    // No directory on disk to write into, so nothing is writable and nothing
    // reveals — and the pane asks these rather than inferring them.
    expect(source.cwd).toBeNull();
    expect(source.writable).toBe(false);
    // The two the session source cannot claim, and the reason this exists.
    expect(source.provenance).toBe(true);
    expect(source.filtersHidden).toBe(false);
    expect(source.preview).toBe('inline');
  });

  it('asks for the root as no path at all, not as an empty one', async () => {
    const { transport, source } = build();
    transport.readRoomFiles = vi.fn().mockResolvedValue({ path: '', commit: 'a', entries: [] });
    await source.list('', { showHidden: false });
    expect(transport.readRoomFiles).toHaveBeenCalledWith(ROOM_ID, undefined);
    await source.list('docs', { showHidden: false });
    expect(transport.readRoomFiles).toHaveBeenCalledWith(ROOM_ID, 'docs');
  });

  it('answers "this room has no files" as a listing, not as a failure', async () => {
    const { transport, source } = build();
    transport.readRoomFiles = vi.fn().mockRejectedValue(
      Object.assign(new Error('This room does not have files of its own.'), {
        code: 'ROOM_HAS_NO_REPO',
        status: 409,
      })
    );

    // The ordinary answer for most rooms, so it must not travel the rejection
    // path: left there it was retried, logged as a query error, and dropped a
    // breadcrumb into the next bug report — once per repo-less room opened.
    await expect(source.list('', { showHidden: false })).resolves.toEqual({
      entries: [],
      absent: true,
    });
  });

  it('still rejects a refusal that is not "no files" — those are real', async () => {
    const { transport, source } = build();
    transport.readRoomFiles = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('no git here'), { code: 'ROOM_REPO_GIT_UNAVAILABLE' })
      );
    await expect(source.list('', { showHidden: false })).rejects.toThrow('no git here');
  });

  it('lists a symlink and a submodule as leaves, never as things to open into', async () => {
    const { transport, source } = build();
    transport.readRoomFiles = vi.fn().mockResolvedValue({
      path: '',
      commit: 'a',
      entries: [
        { name: 'docs', path: 'docs', kind: 'dir', size: 0, lastCommit: null },
        { name: 'link', path: 'link', kind: 'symlink', size: 9, lastCommit: null },
        { name: 'vendor', path: 'vendor', kind: 'submodule', size: 0, lastCommit: null },
      ],
    });
    const listing = await source.list('', { showHidden: false });
    expect(listing.entries.map((e) => [e.name, e.type, e.isSymlink])).toEqual([
      ['docs', 'dir', false],
      // A link is listed, never followed — so it gets no chevron, and it says
      // it is a link.
      ['link', 'file', true],
      ['vendor', 'file', false],
    ]);
  });

  it('carries provenance through untouched, null included', async () => {
    const { transport, source } = build();
    const lastCommit = { sha: 'abc', author: 'Kai', at: '2026-08-27T09:00:00Z', subject: 'Add it' };
    transport.readRoomFiles = vi.fn().mockResolvedValue({
      path: '',
      commit: 'a',
      entries: [
        { name: 'a.md', path: 'a.md', kind: 'file', size: 1, lastCommit },
        { name: 'b.md', path: 'b.md', kind: 'file', size: 1, lastCommit: null },
      ],
    });
    const listing = await source.list('', { showHidden: false });
    expect(listing.entries[0].lastCommit).toEqual(lastCommit);
    expect(listing.entries[1].lastCommit).toBeNull();
  });

  it('passes the three honest read answers through as bodies', async () => {
    const { transport, source } = build();
    const base = { path: 'a.md', commit: 'c', lastCommit: null };
    transport.readRoomFileContent = vi
      .fn()
      .mockResolvedValueOnce({
        ...base,
        size: 3,
        body: { kind: 'text', encoding: 'utf-8', text: 'hi\n' },
      })
      .mockResolvedValueOnce({ ...base, size: 10, body: { kind: 'binary' } })
      .mockResolvedValueOnce({ ...base, size: 99, body: { kind: 'too-large', maxBytes: 50 } });

    expect((await source.read!('a.md')).body).toEqual({ kind: 'text', text: 'hi\n' });
    expect((await source.read!('a.md')).body).toEqual({ kind: 'binary' });
    expect((await source.read!('a.md')).body).toEqual({ kind: 'too-large', maxBytes: 50 });
  });

  it('turns "there is nothing here to show" into a body, not a failure', async () => {
    const { transport, source } = build();
    transport.readRoomFileContent = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('nope'), { code: 'ROOM_FILE_NOT_READABLE' }));
    const file = await source.read!('link');
    expect(file.body).toEqual({
      kind: 'not-readable',
      reason: "This isn't a file that can be shown here.",
    });
  });

  it('does not mistake a prototype key for copy it has written', async () => {
    const { transport, source } = build();
    // 'constructor' is a string like any other coming off a thrown error. An
    // object literal would have answered it from its prototype and rendered a
    // function as the reason there is nothing to show.
    transport.readRoomFileContent = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('weird'), { code: 'constructor' }));
    await expect(source.read!('a.md')).rejects.toThrow('weird');
  });

  it('still rejects a refusal that is about the request rather than the file', async () => {
    const { transport, source } = build();
    transport.readRoomFileContent = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('nope'), { code: 'ROOM_NOT_FOUND' }));
    await expect(source.read!('a.md')).rejects.toThrow('nope');
  });
});

describe('the room files source, watching the room', () => {
  it('looks again when the room stream delivers something', () => {
    const { queryClient, source } = build();
    const onChange = vi.fn();
    const unsubscribe = source.events!(onChange);

    queryClient.setQueryData(roomKeys.entries(ROOM_ID), [{ seq: 1 }]);
    expect(onChange).not.toHaveBeenCalled(); // trailing, never leading
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('ignores another room, and every other cache entry', () => {
    const { queryClient, source } = build();
    const onChange = vi.fn();
    const unsubscribe = source.events!(onChange);

    queryClient.setQueryData(roomKeys.entries('some-other-room'), [{ seq: 1 }]);
    queryClient.setQueryData(roomKeys.detail(ROOM_ID), { id: ROOM_ID });
    vi.advanceTimersByTime(ROOM_FILES_REFRESH_INTERVAL_MS * 2);
    expect(onChange).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('buys one listing per interval however loud the room gets', () => {
    const { queryClient, source } = build();
    const onChange = vi.fn();
    const unsubscribe = source.events!(onChange);

    queryClient.setQueryData(roomKeys.entries(ROOM_ID), [{ seq: 1 }]);
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Twenty messages in the next second must not be twenty git listings.
    for (let seq = 2; seq <= 21; seq++) {
      queryClient.setQueryData(roomKeys.entries(ROOM_ID), [{ seq }]);
    }
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    // …but the last of them is not dropped: it lands once the window is up.
    vi.advanceTimersByTime(ROOM_FILES_REFRESH_INTERVAL_MS);
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('stops watching, and cancels what it was about to do, when let go', () => {
    const { queryClient, source } = build();
    const onChange = vi.fn();
    const unsubscribe = source.events!(onChange);

    queryClient.setQueryData(roomKeys.entries(ROOM_ID), [{ seq: 1 }]);
    unsubscribe();
    vi.advanceTimersByTime(ROOM_FILES_REFRESH_INTERVAL_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('saving through the room files source', () => {
  it('declares that the FILES are editable even though the tree is not', () => {
    const { source } = build();
    // The opposite pair from a session's, and both halves are true at once:
    // merging is what adds and removes entries here, while a person's own edit
    // goes through §3.10's door.
    expect(source.writable).toBe(false);
    expect(source.editable).toBe(true);
    expect(source.save).toBeTypeOf('function');
  });

  it('carries the commit a read answered with, which is what a save locks against', async () => {
    const { transport, source } = build();
    transport.readRoomFileContent = vi.fn().mockResolvedValue({
      path: 'ROOM.md',
      commit: 'aaa1111',
      size: 3,
      lastCommit: null,
      body: { kind: 'text', encoding: 'utf-8', text: 'hi\n' },
    });
    await expect(source.read!('ROOM.md')).resolves.toMatchObject({ commit: 'aaa1111' });
  });

  it('turns a lost race into a choice, with the room’s current commit on it', async () => {
    const { transport, source } = build();
    transport.saveRoomFile = vi.fn().mockRejectedValue(
      Object.assign(new Error('changed'), {
        code: 'FILE_CHANGED',
        status: 409,
        body: {
          error: 'changed',
          code: 'FILE_CHANGED',
          conflict: {
            path: 'ROOM.md',
            commit: 'ddd4444',
            lastCommit: { sha: 'b', author: 'Ana', at: '2026-08-28T00:00:00.000Z', subject: 's' },
          },
        },
      })
    );
    await expect(
      source.save!({ path: 'ROOM.md', baseCommit: 'aaa1111', text: 'x' })
    ).resolves.toMatchObject({ status: 'conflict', commit: 'ddd4444' });
  });

  it('refuses to offer a choice it cannot honour', async () => {
    const { transport, source } = build();
    // A `FILE_CHANGED` whose body did not survive the trip has no commit to
    // re-read at and none to save against, so offering the two buttons would be
    // offering two dead ends.
    transport.saveRoomFile = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('changed'), { code: 'FILE_CHANGED', status: 409 })
      );
    const outcome = await source.save!({ path: 'ROOM.md', baseCommit: 'a1b2c3d', text: 'x' });
    expect(outcome.status).toBe('refused');
  });

  it('turns each refusal it knows into a sentence, and rethrows the ones it does not', async () => {
    const { transport, source } = build();
    for (const code of [
      'REQUEST_TOO_LARGE',
      'FILE_TOO_LARGE',
      'MAIN_CHECKOUT_DIRTY',
      'PEOPLE_ONLY',
    ]) {
      transport.saveRoomFile = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error(code), { code, status: 409 }));
      const outcome = await source.save!({ path: 'ROOM.md', baseCommit: null, text: 'x' });
      expect(outcome).toMatchObject({ status: 'refused' });
      expect((outcome as { reason: string }).reason.length).toBeGreaterThan(0);
    }

    // A refusal nobody wrote copy for is a bug, not a rule: dressing it up as an
    // ordinary answer is how a bug becomes invisible.
    transport.saveRoomFile = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('boom'), { code: 'SOMETHING_NEW', status: 500 }));
    await expect(source.save!({ path: 'ROOM.md', baseCommit: null, text: 'x' })).rejects.toThrow(
      'boom'
    );
  });

  it('re-asks the room where it stands when a save says the room is stuck', async () => {
    const { transport, queryClient, source } = build();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    transport.saveRoomFile = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('dirty'), { code: 'MAIN_CHECKOUT_DIRTY', status: 409 })
      );
    await source.save!({ path: 'ROOM.md', baseCommit: null, text: 'x' });
    // The same cache entry the pending-work badge reads (DOR-1599's key), not a
    // second one: two keys would mean the warning and the badge could disagree
    // about the room they are both describing.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: roomKeys.repoStatus(ROOM_ID) });
  });
});
