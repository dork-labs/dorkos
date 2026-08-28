/**
 * The `room-worktree` rung: where one room turn is placed, and what it falls
 * back to when it cannot be placed there.
 *
 * The claim under test is a pair, and both halves matter equally. A repo-enabled
 * room puts the turn in that agent's working copy; EVERYTHING else — no repo, no
 * manager wired, git broken — puts it in the agent's own directory, byte for
 * byte what a room turn did before this rung existed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RoomWorktreeManager } from '../room-worktree-manager.js';
import { resolveRoomTurnCwd } from '../room-turn-cwd.js';
import { RoomError } from '../../room-errors.js';

/** A manager stub whose `ensureWorktree` does whatever the test needs. */
function managerThat(
  ensureWorktree: (roomId: string, agentPath: string, agentName: string) => Promise<unknown>
): RoomWorktreeManager {
  return { ensureWorktree } as unknown as RoomWorktreeManager;
}

const request = { roomId: 'room-1', agentPath: '/agents/ana', agentName: 'Ana' };

describe('resolveRoomTurnCwd', () => {
  it('runs a project room’s turn in that agent’s own working copy', async () => {
    const ensureWorktree = vi.fn().mockResolvedValue({
      slug: 'ana-abcd1234',
      path: '/dork/rooms/room-1/worktrees/ana-abcd1234',
      branch: 'room/ana-abcd1234',
      created: true,
      projection: null,
    });

    const resolved = await resolveRoomTurnCwd(request, {
      worktrees: () => managerThat(ensureWorktree),
    });

    expect(resolved).toEqual({
      cwd: '/dork/rooms/room-1/worktrees/ana-abcd1234',
      rung: 'room-worktree',
    });
    // The agent's own directory is what names the worktree — its identity
    // anchor — and it is passed through unchanged.
    expect(ensureWorktree).toHaveBeenCalledWith('room-1', '/agents/ana', 'Ana');
  });

  it('leaves a room with no files exactly where it was, and calls it nothing worse', async () => {
    // The overwhelmingly common case today. `NOT_A_PROJECT_ROOM` is how
    // `ensureWorktree` says "this room has no files", and it is not a failure:
    // reporting it as `degraded` would put a reason in the log for every room
    // turn on every install that has never used this feature.
    const resolved = await resolveRoomTurnCwd(request, {
      worktrees: () =>
        managerThat(() =>
          Promise.reject(new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files.'))
        ),
    });

    expect(resolved).toEqual({ cwd: '/agents/ana', rung: 'agent-home' });
    expect(resolved.degraded).toBeUndefined();
  });

  it('leaves an install with no worktree manager exactly where it was', async () => {
    const resolved = await resolveRoomTurnCwd(request, { worktrees: () => null });

    expect(resolved).toEqual({ cwd: '/agents/ana', rung: 'agent-home' });
  });

  it('degrades to the agent’s own directory rather than failing the turn', async () => {
    // Git missing, a disk error, a worktree that cannot be built: a room that
    // stops answering is far worse than an agent answering from its own folder,
    // so the turn still runs and the reason is carried out loud.
    const resolved = await resolveRoomTurnCwd(request, {
      worktrees: () => managerThat(() => Promise.reject(new Error('git is not installed'))),
    });

    expect(resolved.cwd).toBe('/agents/ana');
    expect(resolved.rung).toBe('agent-home');
    expect(resolved.degraded).toContain('git is not installed');
  });

  it('degrades on a non-Error throw too', async () => {
    const resolved = await resolveRoomTurnCwd(request, {
      worktrees: () => managerThat(() => Promise.reject('nope')),
    });

    expect(resolved.cwd).toBe('/agents/ana');
    expect(resolved.degraded).toContain('nope');
  });

  it('degrades rather than swallowing a room error that is not "no repo"', async () => {
    // Only `NOT_A_PROJECT_ROOM` is the quiet one. Any other refusal from the
    // repo domain is something a person may need to see.
    const resolved = await resolveRoomTurnCwd(request, {
      worktrees: () =>
        managerThat(() => Promise.reject(new RoomError('ROOM_NOT_FOUND', 'no such room'))),
    });

    expect(resolved.rung).toBe('agent-home');
    expect(resolved.degraded).toContain('no such room');
  });
});
