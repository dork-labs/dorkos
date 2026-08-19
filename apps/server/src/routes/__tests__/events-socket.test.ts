/**
 * The global event stream's WebSocket half, at its connect boundary.
 *
 * This is the route the cockpit actually opens (ADR 260805-041016) — the SSE
 * twin in `events-status.test.ts` is the public integration contract — so the
 * connect preamble has to be proven on BOTH, or a reload keeps forgetting on
 * the one surface that ships.
 *
 * The route is exercised through `authorize().open(ws)` against a recording
 * socket rather than a real upgrade: `open` IS the whole connect path, and
 * standing up an HTTP server to reach it would test the upgrade router (which
 * has its own suite) rather than this.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { decodeStreamFrame } from '@dorkos/shared/stream-socket';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { globalEventsRoute } from '../events-socket.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import {
  getOrCreateProjector,
  disposeProjector,
  type RawSessionEvent,
} from '../../services/session/session-state-projector.js';
import type { UpgradeAttempt } from '../../services/core/streams/upgrade-router.js';

const ERRORED_ID = '88888888-8888-4888-8888-888888888888';
const IDLE_ID = '99999999-9999-4999-8999-999999999999';

/** A recording stand-in for an upgraded socket; collects every frame sent. */
function recordingSocket(): { ws: WebSocket; frames: () => { event: string; data?: unknown }[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (payload: string) => sent.push(payload),
    on: () => {},
    terminate: () => {},
  } as unknown as WebSocket;
  return {
    ws,
    frames: () =>
      sent.flatMap((raw) => {
        const frame = decodeStreamFrame(raw);
        return frame ? [frame] : [];
      }),
  };
}

/**
 * An upgrade as the router hands it to this route.
 *
 * `headers` and `locals` are the two the route reads, because the principal it
 * registers with the fan-out comes from exactly the facts the credential gate
 * resolved (`StreamUpgradeLocals` is `res.locals`-shaped for this reason).
 *
 * @param attempt - Whatever this case wants to vary.
 */
function upgradeAttempt(attempt: Partial<UpgradeAttempt> = {}): UpgradeAttempt {
  return { headers: {}, locals: {}, ...attempt } as UpgradeAttempt;
}

/**
 * Open the route against a recording socket and return what it wrote.
 *
 * @param attempt - The upgrade to authorize; a credential-free cockpit by
 *   default.
 */
async function connect(
  attempt: Partial<UpgradeAttempt> = {}
): Promise<{ event: string; data?: unknown }[]> {
  const decision = await globalEventsRoute.authorize(upgradeAttempt(attempt));
  if (!decision.ok) throw new Error('the fan-out refused the connection');
  const { ws, frames } = recordingSocket();
  decision.open(ws);
  return frames();
}

afterEach(() => {
  disposeProjector(ERRORED_ID);
  disposeProjector(IDLE_ID);
  vi.restoreAllMocks();
});

describe('globalEventsRoute — connect preamble', () => {
  it('opens with connected, then the lifecycle of a session that errored earlier', async () => {
    const projector = getOrCreateProjector(ERRORED_ID, '/work/alpha');
    projector.ingest({ type: 'turn_start' });
    projector.ingest({ type: 'turn_end', terminalReason: 'error' } as RawSessionEvent);

    const frames = await connect();

    expect(frames[0]?.event).toBe('connected');
    expect(frames.slice(1)).toContainEqual(
      expect.objectContaining({
        event: 'session_status',
        data: expect.objectContaining({
          sessionId: ERRORED_ID,
          cwd: '/work/alpha',
          status: expect.objectContaining({ lifecycle: 'error' }),
        }),
      })
    );
  });

  it('says nothing about an idle session, while still announcing an errored one', async () => {
    const idle = getOrCreateProjector(IDLE_ID, '/work/gamma');
    idle.ingest({ type: 'turn_start' });
    idle.ingest({ type: 'turn_end', terminalReason: 'completed' } as RawSessionEvent);
    const errored = getOrCreateProjector(ERRORED_ID, '/work/alpha');
    errored.ingest({ type: 'turn_start' });
    errored.ingest({ type: 'turn_end', terminalReason: 'error' } as RawSessionEvent);

    const statuses = (await connect())
      .filter((frame) => frame.event === 'session_status')
      .map((frame) => frame.data as { sessionId: string });

    // The errored one is what proves the preamble ran at all, so the silence
    // about the idle one below is a decision rather than an empty stream.
    expect(statuses.map((status) => status.sessionId)).toContain(ERRORED_ID);
    expect(statuses.map((status) => status.sessionId)).not.toContain(IDLE_ID);
  });
});

describe('globalEventsRoute — the principal it registers', () => {
  /**
   * Register a connection and report what principal the fan-out was told.
   *
   * Spying on `addClient` rather than broadcasting is deliberate: the wiring is
   * what an exploit reaches, and a route that resolved the principal correctly
   * but registered a different one would broadcast an Ask to an agent while
   * every policy test stayed green.
   *
   * @param attempt - The upgrade to authorize.
   */
  async function principalOf(attempt: Partial<UpgradeAttempt>): Promise<unknown> {
    const addClient = vi.spyOn(eventFanOut, 'addClient').mockReturnValue(() => {});
    await connect(attempt);
    return addClient.mock.calls[0]?.[1];
  }

  it('registers a credential-free cockpit as the operator', async () => {
    expect(await principalOf({})).toEqual({ kind: 'operator' });
  });

  it('registers a connection presenting an agent header as an agent', async () => {
    const principal = await principalOf({
      headers: { [AGENT_IDENTITY_HEADER]: 'tok_agent' },
      locals: { agentIdentity: { agentId: 'agent_ana' } as never },
    });
    expect(principal).toEqual({ kind: 'agent' });
  });

  it('registers a connection holding a per-user API key as a program', async () => {
    const principal = await principalOf({
      locals: { user: { userId: 'user_owner', credential: 'api-key' } },
    });
    expect(principal).toEqual({ kind: 'program', userId: 'user_owner' });
  });
});
