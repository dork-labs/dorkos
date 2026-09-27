/**
 * An app-resumed room session, reached from a bare session id (DOR-1624, spec
 * `agent-home-desk` §5.7).
 *
 * `resolve-session-cwd.test.ts` next door owns the chain itself. What this file
 * pins is what the room adds: a room-bound session stands in its agent's HOME,
 * carries that agent as `forAgent`, and is granted exactly the folders a room
 * turn is — and a room lookup, a database read on the hot path of every message
 * a person sends, can never fail the turn.
 *
 * Seeded defects: keeping a named copy as the cwd reddens "replaces a named copy
 * of the room's files with the home"; taking `req.agentPath` over the binding
 * reddens "places the room's agent, not the one the message named"; dropping
 * the refusal for a session standing in the copy reddens "refuses an OpenCode
 * session…"; dropping the desk guard on a named folder reddens "refuses a named
 * folder that is not the agent's own".
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import {
  resolveSessionCwdWithRoom,
  ROOM_SESSION_MOVED_MESSAGE,
  type RoomSessionPlacePort,
} from '../room-session-place.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';

vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));

const AGENT = '/home/agents/api-bot';
const WORKTREE = '/home/.dork/rooms/room-1/worktrees/api-bot-1a2b3c4d';
/** Another registered agent, not in the room. */
const OTHER = '/home/agents/ben';
const GRANTS: DirectoryGrant[] = [
  { path: WORKTREE, access: 'write' },
  { path: '/home/.dork/rooms/room-1/repo', access: 'read' },
];

/** A port that answers for one room, placing its agent at home with GRANTS. */
function place(overrides: Partial<RoomSessionPlacePort> = {}): RoomSessionPlacePort {
  return {
    roomFor: () => ({ roomId: 'room-1', agentName: 'API Bot', agentPath: AGENT }),
    placeTurn: (_roomId, agentPath) =>
      Promise.resolve({
        cwd: agentPath,
        additionalDirectories: agentPath === AGENT ? GRANTS : [],
        worktree: agentPath === AGENT ? WORKTREE : null,
      }),
    ...overrides,
  };
}

describe('resolveSessionCwdWithRoom', () => {
  it('stands a room-bound session at home, with the room’s grants and its agent', async () => {
    const resolved = await resolveSessionCwdWithRoom({ sessionId: 's1' }, place());

    expect(resolved).toEqual({
      cwd: AGENT,
      rung: 'agent-home',
      additionalDirectories: GRANTS,
      forAgent: AGENT,
    });
  });

  it('carries no grants for a room without files', async () => {
    const resolved = await resolveSessionCwdWithRoom(
      { sessionId: 's1' },
      place({
        placeTurn: () => Promise.resolve({ cwd: AGENT, additionalDirectories: [], worktree: null }),
      })
    );

    expect(resolved).toEqual({ cwd: AGENT, rung: 'agent-home', forAgent: AGENT });
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
    expect(resolved).not.toHaveProperty('additionalDirectories');
  });

  describe('a turn that names its directory', () => {
    it('replaces a named copy of the room’s files with the home, keeping the grants', async () => {
      // The client resends the directory it last showed, which before this
      // change was the agent's copy (spec §5.7).
      const resolved = await resolveSessionCwdWithRoom(
        { cwd: `${WORKTREE}/`, sessionId: 's1' },
        place()
      );

      expect(resolved).toEqual({
        cwd: AGENT,
        rung: 'agent-home',
        additionalDirectories: GRANTS,
        forAgent: AGENT,
      });
    });

    it('replaces a folder INSIDE the copy with the home too', async () => {
      const resolved = await resolveSessionCwdWithRoom(
        { cwd: `${WORKTREE}/docs`, sessionId: 's1' },
        place()
      );

      expect(resolved).toMatchObject({ cwd: AGENT, rung: 'agent-home' });
    });

    it('refuses an OpenCode session that stands in the copy, pointing back to the room', async () => {
      // OpenCode cannot move a session to a new folder (spec §8.1), and no turn
      // stands in a room's files — so this one does not start.
      const placeTurn = vi.fn(() =>
        Promise.resolve({
          cwd: WORKTREE,
          additionalDirectories: [],
          worktree: WORKTREE,
          standsInCopy: true,
        })
      );

      const resolved = await resolveSessionCwdWithRoom({ sessionId: 's1' }, place({ placeTurn }));

      expect(placeTurn).toHaveBeenCalledWith('room-1', AGENT, 'API Bot', 's1');
      expect(resolved.refusal).toEqual({
        code: 'ROOM_SESSION_MOVED',
        message: ROOM_SESSION_MOVED_MESSAGE,
      });
    });

    it('keeps the grants for a turn that names the home itself', async () => {
      const resolved = await resolveSessionCwdWithRoom({ cwd: AGENT, sessionId: 's1' }, place());

      expect(resolved).toMatchObject({ cwd: AGENT, additionalDirectories: GRANTS });
    });

    describe('a named folder other than the home (the desk guard)', () => {
      afterEach(() => clearTestHomes());

      it('runs in a private copy of the agent`s own project, with no grants but as the room’s agent', async () => {
        const own = '/home/.dork/workspaces/api-bot/fix-1';
        registerTestHomes([AGENT, OTHER], {
          roomsDir: '/home/.dork/rooms',
          managed: { [own]: AGENT },
        });

        const resolved = await resolveSessionCwdWithRoom({ cwd: own, sessionId: 's1' }, place());

        expect(resolved).toEqual({ cwd: own, rung: 'explicit', forAgent: AGENT });
      });

      it('refuses a named folder that is not the agent`s own: another agent`s, a room`s, or anywhere', async () => {
        registerTestHomes([AGENT, OTHER], { roomsDir: '/home/.dork/rooms' });

        for (const cwd of [OTHER, '/home/.dork/rooms/room-1/repo', '/work/elsewhere']) {
          const resolved = await resolveSessionCwdWithRoom({ cwd, sessionId: 's1' }, place());
          expect(resolved.refusal?.code, cwd).toBe('DESK_NOT_OWN');
          expect(resolved.refusal?.message).toContain(`API Bot's own folder ("${AGENT}")`);
        }
      });
    });
  });

  describe('a message that names a different agent than its room session (DOR-2091)', () => {
    // The route checks only that a body `agentPath` is SOME registered agent.
    // The room's binding decides which agent a room session is; a body naming
    // another is ignored.
    it('places the room’s agent, not the one the message named', async () => {
      const placeTurn = vi.fn(place().placeTurn);

      const resolved = await resolveSessionCwdWithRoom(
        { agentPath: OTHER, sessionId: 's1' },
        place({ placeTurn })
      );

      expect(placeTurn).toHaveBeenCalledWith('room-1', AGENT, 'API Bot', 's1');
      expect(placeTurn).not.toHaveBeenCalledWith('room-1', OTHER, expect.anything());
      expect(resolved).toMatchObject({ cwd: AGENT, forAgent: AGENT });
    });
  });
});
