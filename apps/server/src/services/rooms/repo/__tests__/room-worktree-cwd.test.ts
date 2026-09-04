/**
 * The rooms domain's side of the room rung (DOR-1624).
 *
 * Two things are pinned here that the route test above cannot see, because both
 * are about what the port refuses rather than what it answers: the one throw it
 * translates, and the one it must let through. A `NOT_A_PROJECT_ROOM` read as a
 * failure would report a degradation on every turn in every ordinary room; a
 * real git failure read as "this room has no files" would hide the thing the
 * operator needs to know.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuthorRecord } from '../../author-registry.js';
import type { RoomWorktreeManager } from '../room-worktree-manager.js';
import { RoomError } from '../../room-errors.js';
import { ensureRoomWorktreePath, roomSessionPlace } from '../room-worktree-cwd.js';

const AGENT = '/home/agents/api-bot';
const WORKTREE = '/home/.dork/rooms/room-1/worktrees/api-bot-1a2b3c4d';

/** A manager that answers, or throws, whatever the test hands it. */
function manager(answer: () => Promise<{ path: string }>): RoomWorktreeManager {
  return { ensureWorktree: () => answer() } as unknown as RoomWorktreeManager;
}

/** An author row of one kind, minus the render fields nothing here reads. */
function author(kind: AuthorRecord['kind'], displayName: string): AuthorRecord {
  return {
    id: 'author-1',
    kind,
    naturalKey: AGENT,
    displayName,
    handle: null,
    emoji: null,
    color: null,
    imageUrl: null,
    mintedForManifestId: null,
    retiredAt: null,
  } as AuthorRecord;
}

describe('ensureRoomWorktreePath', () => {
  it('hands back the working copy the manager made', async () => {
    const path = await ensureRoomWorktreePath(
      manager(() => Promise.resolve({ path: WORKTREE })),
      'room-1',
      AGENT,
      'API Bot'
    );

    expect(path).toBe(WORKTREE);
  });

  it('reads "this room has no files of its own" as nothing to give', async () => {
    const path = await ensureRoomWorktreePath(
      manager(() => Promise.reject(new RoomError('NOT_A_PROJECT_ROOM', 'no files'))),
      'room-1',
      AGENT,
      'API Bot'
    );

    expect(path).toBeNull();
  });

  // The resolver degrades this one and says why. Swallowing it would put the
  // turn in the agent's folder with nothing in the log to explain it.
  it('lets a real failure through', async () => {
    await expect(
      ensureRoomWorktreePath(
        manager(() => Promise.reject(new Error('git is not installed'))),
        'room-1',
        AGENT,
        'API Bot'
      )
    ).rejects.toThrow('git is not installed');
  });

  it('answers nothing on an install with no worktree manager', async () => {
    expect(await ensureRoomWorktreePath(null, 'room-1', AGENT, 'API Bot')).toBeNull();
  });
});

describe('roomSessionPlace', () => {
  const worktrees = () => manager(() => Promise.resolve({ path: WORKTREE }));

  it('names the room and the label the room shows for the agent', () => {
    const place = roomSessionPlace({
      bindings: {
        bindingForSession: () => ({ roomId: 'room-1', authorId: 'author-1', sessionId: 's1' }),
      },
      authors: { getById: () => author('agent', 'Ana the Reviewer') },
      worktrees,
    });

    expect(place.roomFor('s1')).toEqual({ roomId: 'room-1', agentName: 'Ana the Reviewer' });
  });

  it('answers nothing for a session no room is bound to', () => {
    const place = roomSessionPlace({
      bindings: { bindingForSession: () => undefined },
      authors: { getById: vi.fn(() => author('agent', 'API Bot')) },
      worktrees,
    });

    expect(place.roomFor('s1')).toBeNull();
  });

  // A room binding always names an agent member, so a human row here means the
  // id has been reused or the row has changed hands — and inventing a working
  // copy for a person is not the recovery.
  it('answers nothing when the bound author is not an agent', () => {
    const place = roomSessionPlace({
      bindings: {
        bindingForSession: () => ({ roomId: 'room-1', authorId: 'author-1', sessionId: 's1' }),
      },
      authors: { getById: () => author('human', 'You') },
      worktrees,
    });

    expect(place.roomFor('s1')).toBeNull();
  });

  it('answers nothing when the bound author has no row at all', () => {
    const place = roomSessionPlace({
      bindings: {
        bindingForSession: () => ({ roomId: 'room-1', authorId: 'gone', sessionId: 's1' }),
      },
      authors: { getById: () => null },
      worktrees,
    });

    expect(place.roomFor('s1')).toBeNull();
  });
});
