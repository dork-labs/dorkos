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
import {
  getOrCreateProjector,
  disposeProjector,
  type RawSessionEvent,
} from '../../services/session/session-state-projector.js';

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

/** Open the route against a recording socket and return what it wrote. */
async function connect(): Promise<{ event: string; data?: unknown }[]> {
  // This route's `authorize` reads nothing off the attempt — it asks the
  // fan-out for capacity and nothing else — so an empty one is the honest
  // fixture rather than a stub that would have to be kept in sync.
  const decision = await globalEventsRoute.authorize({} as never);
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
