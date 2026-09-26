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
/** Another registered agent, not in the room, and where its worktree WOULD be. */
const OTHER = '/home/agents/ben';
const OTHER_WORKTREE = '/home/.dork/rooms/room-1/worktrees/api-bot-9f8e7d6c';

/** A port that answers for one room, with a worktree the test names. */
function place(overrides: Partial<RoomSessionPlacePort> = {}): RoomSessionPlacePort {
  return {
    roomFor: () => ({ roomId: 'room-1', agentName: 'API Bot', agentPath: AGENT }),
    ensureRoomWorktree: () => Promise.resolve(WORKTREE),
    // Each agent's own working copy, computed as the manager does: per agent.
    roomWorktreePath: (_roomId, agentPath) => (agentPath === AGENT ? WORKTREE : OTHER_WORKTREE),
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

  describe('a turn that names its directory (DOR-2091)', () => {
    // The client resends the directory it last showed, so an app-resumed room
    // session names its worktree and takes the explicit rung. The worktree
    // manager only learns whose a tree is when it hands one out, so after a
    // restart that session would be refused its agent's identity until the
    // room's next turn. Seeded: dropping the vouch reddens the first case;
    // vouching for any named directory reddens the second.
    it('vouches for the worktree it names, and still runs exactly there', async () => {
      const ensureRoomWorktree = vi.fn(() => Promise.resolve(WORKTREE));

      const resolved = await resolveSessionCwdWithRoom(
        { cwd: `${WORKTREE}/`, agentPath: AGENT, sessionId: 's1' },
        place({ ensureRoomWorktree })
      );

      expect(ensureRoomWorktree).toHaveBeenCalledWith('room-1', AGENT, 'API Bot');
      expect(resolved).toEqual({ cwd: `${WORKTREE}/`, rung: 'explicit' });
    });

    it('makes no worktree for a turn that names any other directory', async () => {
      const ensureRoomWorktree = vi.fn(() => Promise.resolve(WORKTREE));

      const resolved = await resolveSessionCwdWithRoom(
        { cwd: AGENT, agentPath: AGENT, sessionId: 's1' },
        place({ ensureRoomWorktree })
      );

      expect(ensureRoomWorktree).not.toHaveBeenCalled();
      expect(resolved).toEqual({ cwd: AGENT, rung: 'explicit' });
    });

    it('still runs the turn when vouching fails', async () => {
      const resolved = await resolveSessionCwdWithRoom(
        { cwd: WORKTREE, agentPath: AGENT, sessionId: 's1' },
        place({ ensureRoomWorktree: () => Promise.reject(new Error('no git')) })
      );

      expect(resolved).toEqual({ cwd: WORKTREE, rung: 'explicit' });
    });
  });

  describe('a message that names a different agent than its room session (DOR-2091)', () => {
    // The route checks only that a body `agentPath` is SOME registered agent.
    // The room's binding decides which agent a room session is; a body naming
    // another is ignored, so it can neither make that agent a worktree in a
    // room it is not in nor act as it there. Seeded: taking `req.agentPath`
    // over the binding reddens both.
    it("vouches for nobody when it names that agent's worktree", async () => {
      const ensureRoomWorktree = vi.fn(() => Promise.resolve(OTHER_WORKTREE));

      await resolveSessionCwdWithRoom(
        { cwd: OTHER_WORKTREE, agentPath: OTHER, sessionId: 's1' },
        place({ ensureRoomWorktree })
      );

      expect(ensureRoomWorktree).not.toHaveBeenCalled();
    });

    it("runs the room step for the room's agent, not the named one", async () => {
      const ensureRoomWorktree = vi.fn(() => Promise.resolve(WORKTREE));

      const resolved = await resolveSessionCwdWithRoom(
        { agentPath: OTHER, sessionId: 's1' },
        place({ ensureRoomWorktree })
      );

      expect(ensureRoomWorktree).toHaveBeenCalledWith('room-1', AGENT, 'API Bot');
      expect(ensureRoomWorktree).not.toHaveBeenCalledWith('room-1', OTHER, expect.anything());
      expect(resolved).toMatchObject({ cwd: WORKTREE, rung: 'room-worktree' });
    });
  });
});
