/**
 * @vitest-environment node
 *
 * Who the room stream's WebSocket half lets connect (DOR-1361).
 *
 * The cockpit opens this route, not the SSE twin, so the caller rule has to be
 * proven here as well as on `GET /:id/events` — and an upgrade runs NO Express
 * middleware, so the identity the HTTP path takes for granted is hand-filled by
 * `authorizeStreamUpgrade`. That is exactly the gap a revoked agent fell
 * through: `resolveCaller` read its unresolvable token as "no agent presented"
 * and handed it the operator's membership, so it subscribed to every room the
 * person is in.
 *
 * Exercised through `authorize()` against a synthetic {@link UpgradeAttempt},
 * the same shape `events-socket.test.ts` uses: `authorize` IS the decision, and
 * standing up an HTTP server to reach it would test the upgrade router, which
 * has its own suite.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Drop `resolveCaller`'s refusal -> the unverifiable row goes `{ ok: true }`.
 * - Pin the catch back to `refuse(404, 'No such room')` -> the unverifiable row
 *   reports 404, and the close code the client reads becomes 4404: a credential
 *   problem described as a missing room.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STREAM_CLOSE_CODE_BASE } from '@dorkos/shared/stream-socket';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { roomEventsRoute } from '../room-events-socket.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { authorizeStreamUpgrade } from '../../services/core/streams/stream-upgrade-auth.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

/** A token shaped like the real thing that resolves to nobody: a revoked agent. */
const UNVERIFIABLE = 'dork_agent_this-token-resolves-to-nothing';

const ANA_PATH = '/agents/ana';

/** Register an agent so a room can resolve it by directory. */
function registerAgent(db: Db, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: 'ULID_ANA',
      name: 'ana',
      displayName: 'Ana',
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('the room stream upgrade', () => {
  let db: Db;
  let roomId: string;

  beforeEach(() => {
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, ANA_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    initAgentIdentityService(db);
    const owner = rooms.authors.localHuman().id;
    // Ana is a MEMBER, so a token that resolves to her opens the stream on its
    // own merits — without that the valid-token row below would pass for the
    // wrong reason (a non-member is refused 404 whatever its token).
    roomId = rooms.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA_PATH] },
      owner
    ).id;
  });

  /**
   * Ask the route the way `attachUpgradeRouter` asks it: run the credential gate
   * over the headers FIRST, then hand the route what it produced.
   *
   * Running the real {@link authorizeStreamUpgrade} rather than hand-writing
   * `locals` is the point of this file. That function is the upgrade path's
   * stand-in for the whole Express middleware chain, and it is where a valid
   * token becomes an identity and an unverifiable one becomes nothing at all —
   * so a test that filled `locals` itself would decide the very fact under test.
   *
   * @param headers - The upgrade request's headers.
   * @param path - The path to route, defaulting to this test's room.
   */
  async function authorize(headers: Record<string, string>, path = `/api/rooms/${roomId}/events`) {
    const gate = await authorizeStreamUpgrade(headers);
    if (!gate.ok) throw new Error(`the credential gate refused: ${gate.status}`);
    return roomEventsRoute.authorize({
      url: new URL(`http://localhost${path}`),
      headers,
      match: /^\/api\/rooms\/([^/]+)\/events$/.exec(path)!,
      locals: gate.locals,
    });
  }

  it('refuses an unverifiable agent token with a 401 the browser can read', async () => {
    const decision = await authorize({ 'x-dorkos-agent': UNVERIFIABLE });

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.status).toBe(401);
    // A close frame, not a failed handshake: a browser cannot read the status of
    // a failed one, and this refusal is the whole reason the distinction exists.
    expect(decision.deliver).toBe('close-frame');
    expect(STREAM_CLOSE_CODE_BASE + decision.status).toBe(4401);
    // And it does NOT say "no such room" about a room that is perfectly fine.
    expect(decision.message).not.toContain('No such room');
  });

  it('opens for an agent whose token DOES resolve, as that agent', async () => {
    // Branch 1 still works over the socket: this is what a refusal keyed on the
    // header alone would have broken, and an agent reading the room it is in is
    // the reason the header exists at all.
    const token = await initAgentIdentityService(db).mint({
      agentPath: ANA_PATH,
      displayName: 'Ana',
    });

    const decision = await authorize({ 'x-dorkos-agent': token });

    expect(decision.ok).toBe(true);
  });

  it('opens for the same room with no header at all', async () => {
    // The negative control. Without it the refusal above would also pass for a
    // stream that was simply broken for everybody.
    const decision = await authorize({});

    expect(decision.ok).toBe(true);
  });

  it('still answers "no such room" for a room the caller cannot see', async () => {
    // The other refusal on this path, unchanged: an unknown room is 404 and says
    // so, which is what pins the 401 above as being about the token.
    const decision = await authorize({}, '/api/rooms/01NOSUCHROOM/events');

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.status).toBe(404);
    expect(decision.message).toBe('No such room');
  });
});
