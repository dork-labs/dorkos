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
import { decodeDorkOsEventFrame, type DorkOsEventFrame } from '@dorkos/shared/dorkos-event-frame';
import { SSE } from '../../config/constants.js';

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
import { AGENT_IDENTITY_HEADER } from '../../lib/http/agent-identity-header.js';
import {
  getOrCreateProjector,
  disposeProjector,
  type RawSessionEvent,
} from '../../services/session/session-state-projector.js';
import type { UpgradeAttempt } from '../../services/core/streams/upgrade-router.js';

const ERRORED_ID = '88888888-8888-4888-8888-888888888888';
const IDLE_ID = '99999999-9999-4999-8999-999999999999';

/**
 * A recording stand-in for an upgraded socket; collects every frame sent. Each
 * is a whole `DorkOsEvent`, with its cursor as `id` when it has one; a message
 * that is not one is dropped, so a frame in the old shape fails the case.
 */
function recordingSocket(): {
  ws: WebSocket;
  frames: () => DorkOsEventFrame[];
} {
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
        const frame = decodeDorkOsEventFrame(raw);
        return frame ? [frame] : [];
      }),
  };
}

/**
 * An upgrade as the router hands it to this route, from this computer.
 *
 * The route reads `facts`, which the router builds from the headers and the
 * identity its credential gate resolved (`upgradeRequestFacts`), so the
 * person bar and the principal it registers read exactly what the gate saw.
 *
 * @param attempt - The headers, identity and URL this case wants to vary.
 */
function upgradeAttempt(
  attempt: Partial<Pick<UpgradeAttempt, 'url' | 'headers' | 'locals'>> = {}
): UpgradeAttempt {
  const headers = attempt.headers ?? {};
  const locals = attempt.locals ?? {};
  return {
    url: attempt.url ?? new URL('http://localhost/api/events'),
    headers,
    locals,
    facts: {
      headers: { host: 'localhost', ...headers },
      peerAddress: '127.0.0.1',
      forwardedAddress: '127.0.0.1',
      connectionEncrypted: false,
      method: 'GET',
      ingress: 'direct',
      user: locals.user,
      agentIdentity: locals.agentIdentity,
    },
  } as UpgradeAttempt;
}

/**
 * Open the route against a recording socket and return what it wrote.
 *
 * @param attempt - The upgrade to authorize; a credential-free cockpit by
 *   default.
 */
async function connect(
  attempt: Parameters<typeof upgradeAttempt>[0] = {}
): Promise<DorkOsEventFrame[]> {
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

    expect(frames[0]).toMatchObject({ seq: null, type: 'connected' });
    expect(frames[0]).not.toHaveProperty('id');
    expect(frames.slice(1)).toContainEqual(
      expect.objectContaining({
        seq: null,
        type: 'session_status',
        payload: expect.objectContaining({
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
      .filter((frame) => frame.type === 'session_status')
      .map((frame) => frame.payload as { sessionId: string });

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
  async function principalOf(attempt: Parameters<typeof upgradeAttempt>[0]): Promise<unknown> {
    const addClient = vi.spyOn(eventFanOut, 'addClient').mockReturnValue(() => {});
    await connect(attempt);
    return addClient.mock.calls[0]?.[1];
  }

  it('registers a credential-free cockpit as the operator', async () => {
    expect(await principalOf({})).toEqual({ kind: 'operator' });
  });

  it('refuses a connection presenting an agent header, and registers nothing', async () => {
    const addClient = vi.spyOn(eventFanOut, 'addClient');
    const decision = await globalEventsRoute.authorize(
      upgradeAttempt({
        headers: { [AGENT_IDENTITY_HEADER]: 'tok_agent' },
        locals: { agentIdentity: { agentId: 'agent_ana' } as never },
      })
    );
    expect(decision).toMatchObject({ ok: false, status: 403, deliver: 'close-frame' });
    expect(addClient).not.toHaveBeenCalled();
  });

  it('registers a connection holding a per-user API key as a program', async () => {
    const principal = await principalOf({
      locals: { user: { userId: 'user_owner', credential: 'api-key' } },
    });
    expect(principal).toEqual({ kind: 'program', userId: 'user_owner' });
  });
});

describe('globalEventsRoute — resuming from ?resume=', () => {
  it('replays what came after the cursor, then carries on live in order', async () => {
    const first = recordingSocket();
    const decision = await globalEventsRoute.authorize(upgradeAttempt());
    if (!decision.ok) throw new Error('refused');
    decision.open(first.ws);
    eventFanOut.broadcast('tasks_changed', { n: 1 });
    const cursor = first.frames().at(-1)!.id!;
    eventFanOut.broadcast('tasks_changed', { n: 2 });

    const url = new URL(`http://localhost/api/events?resume=${encodeURIComponent(cursor)}`);
    const resumed = await globalEventsRoute.authorize(upgradeAttempt({ url }));
    if (!resumed.ok) throw new Error('refused');
    const second = recordingSocket();
    resumed.open(second.ws);
    eventFanOut.broadcast('tasks_changed', { n: 3 });

    const frames = second.frames();
    expect(frames[0]).toMatchObject({ type: 'connected', payload: { resumed: true } });
    const numbered = frames.filter((frame) => frame.id !== undefined);
    expect(numbered.map((frame) => frame.payload)).toEqual([{ n: 2 }, { n: 3 }]);
    // The client reads `seq` from the frame, never from the id.
    expect(numbered[1]!.seq).toBe(numbered[0]!.seq! + 1);
  });

  it('gets its snapshot through a reader that drops frames at or below the last seq it saw', async () => {
    // A common client: skip what it already has. The opening frames carry
    // `seq: null`, so such a reader never takes them for repeats.
    let lastSeq = 0;
    const kept: DorkOsEventFrame[] = [];
    const read = (frames: DorkOsEventFrame[]): void => {
      for (const frame of frames) {
        if (frame.seq !== null && frame.seq <= lastSeq) continue;
        if (frame.seq !== null) lastSeq = frame.seq;
        kept.push(frame);
      }
    };
    const first = recordingSocket();
    const opened = await globalEventsRoute.authorize(upgradeAttempt());
    if (!opened.ok) throw new Error('refused');
    opened.open(first.ws);
    eventFanOut.broadcast('tasks_changed', { n: 1 });
    read(first.frames());
    expect(lastSeq).toBeGreaterThan(0);

    // The server restarted: the old cursor names nothing, so this is a cold connect.
    const errored = getOrCreateProjector(ERRORED_ID, '/work/alpha');
    errored.ingest({ type: 'turn_start' });
    errored.ingest({ type: 'turn_end', terminalReason: 'error' } as RawSessionEvent);
    kept.length = 0;
    read(await connect({ url: new URL('http://localhost/api/events?resume=events-1-g999999-1') }));

    expect(kept[0]).toMatchObject({ seq: null, type: 'connected' });
    expect(kept).toContainEqual(
      expect.objectContaining({
        type: 'session_status',
        payload: expect.objectContaining({ sessionId: ERRORED_ID }),
      })
    );
  });
});

describe('globalEventsRoute — keepalive', () => {
  it('is a heartbeat envelope, not the chat and room sockets’ frame', async () => {
    vi.useFakeTimers();
    try {
      const socket = recordingSocket();
      const decision = await globalEventsRoute.authorize(upgradeAttempt());
      if (!decision.ok) throw new Error('refused');
      decision.open(socket.ws);
      vi.advanceTimersByTime(SSE.HEARTBEAT_INTERVAL_MS);
      expect(socket.frames().at(-1)).toMatchObject({ seq: null, type: 'heartbeat', payload: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
