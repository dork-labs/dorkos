/**
 * The room rung reached from a bare session id (DOR-1624).
 *
 * `resolve-session-cwd.test.ts` next door owns the chain itself. What this file
 * pins is the one thing the wrapper adds: a room lookup is a database read on
 * the hot path of every message a person sends, and it must not be able to fail
 * a turn. The chain's own rule — failure never fails the turn — has to hold for
 * the half of it that lives outside the resolver too.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveSessionCwdWithRoom, type RoomSessionPlacePort } from '../room-session-cwd.js';

vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));

const AGENT = '/home/agents/api-bot';
const WORKTREE = '/home/.dork/rooms/room-1/worktrees/api-bot-1a2b3c4d';

/** A port that answers for one room, with a worktree the test names. */
function place(overrides: Partial<RoomSessionPlacePort> = {}): RoomSessionPlacePort {
  return {
    roomFor: () => ({ roomId: 'room-1', agentName: 'API Bot' }),
    ensureRoomWorktree: () => Promise.resolve(WORKTREE),
    ...overrides,
  };
}

describe('resolveSessionCwdWithRoom', () => {
  it('puts a room-bound session in the room worktree', async () => {
    const resolved = await resolveSessionCwdWithRoom(
      { agentPath: AGENT, sessionId: 's1' },
      place()
    );

    expect(resolved).toMatchObject({ cwd: WORKTREE, rung: 'room-worktree' });
  });

  it('leaves the chain alone on an install with no rooms subsystem', async () => {
    const resolved = await resolveSessionCwdWithRoom(
      { cwd: '/work/thing', sessionId: 's1' },
      undefined
    );

    expect(resolved).toEqual({ cwd: '/work/thing', rung: 'explicit' });
  });

  // The whole reason the lookup is wrapped: a binding that cannot be read is one
  // less thing to go on, never a 500 on a person's message.
  it('runs the turn anyway when the room lookup throws', async () => {
    const resolved = await resolveSessionCwdWithRoom(
      { agentPath: AGENT, sessionId: 's1' },
      place({
        roomFor: () => {
          throw new Error('the database is locked');
        },
      })
    );

    expect(resolved).toMatchObject({ cwd: AGENT, rung: 'agent-home' });
  });
});
