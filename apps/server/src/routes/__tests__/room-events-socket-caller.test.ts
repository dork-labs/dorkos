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
import type { Db } from '@dorkos/db';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { roomEventsRoute } from '../room-events-socket.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import type { StreamUpgradeLocals } from '../../services/core/streams/stream-upgrade-auth.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

/** A token shaped like the real thing that resolves to nobody: a revoked agent. */
const UNVERIFIABLE = 'dork_agent_this-token-resolves-to-nothing';

describe('the room stream upgrade', () => {
  let db: Db;
  let roomId: string;

  beforeEach(() => {
    resetAgentIdentityService();
    db = createTestDb();
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    initAgentIdentityService(db);
    const owner = rooms.authors.localHuman().id;
    roomId = rooms.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      owner
    ).id;
  });

  /**
   * Ask the route, the way the upgrade router asks it.
   *
   * `locals` is empty for every case here on purpose: it is what
   * `authorizeStreamUpgrade` produces for a token that did not resolve, which is
   * precisely the state the route has to tell apart from "no header at all".
   */
  function authorize(headers: Record<string, string>) {
    return roomEventsRoute.authorize({
      url: new URL(`http://localhost/api/rooms/${roomId}/events`),
      headers,
      match: /^\/api\/rooms\/([^/]+)\/events$/.exec(`/api/rooms/${roomId}/events`)!,
      locals: {} satisfies StreamUpgradeLocals,
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

  it('opens for the same room with no header at all', async () => {
    // The negative control. Without it the refusal above would also pass for a
    // stream that was simply broken for everybody.
    const decision = await authorize({});

    expect(decision.ok).toBe(true);
  });

  it('still answers "no such room" for a room the caller cannot see', async () => {
    // The other refusal on this path, unchanged: an unknown room is 404 and says
    // so, which is what pins the 401 above as being about the token.
    const decision = await roomEventsRoute.authorize({
      url: new URL('http://localhost/api/rooms/01NOSUCHROOM/events'),
      headers: {},
      match: /^\/api\/rooms\/([^/]+)\/events$/.exec('/api/rooms/01NOSUCHROOM/events')!,
      locals: {} satisfies StreamUpgradeLocals,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.status).toBe(404);
    expect(decision.message).toBe('No such room');
  });
});
