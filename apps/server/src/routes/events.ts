/**
 * `GET /api/events` over Server-Sent Events — the unified global event stream.
 *
 * One multiplexed connection carrying every real-time broadcast the server
 * produces; clients filter by the `event:` field rather than opening a
 * connection per resource.
 *
 * The same path is also served over a WebSocket (`events-socket.ts`), which is
 * what the cockpit connects to (ADR 260805-041016). This SSE route stays as the
 * public integration contract (`docs/integrations/sse-protocol.mdx`) and is what
 * the Electron main process reads for its tray count. Both register with the
 * same {@link eventFanOut}, so one broadcast reaches every reader on either
 * protocol.
 *
 * The stream is written straight to the Node response
 * (`http/raw-node-stream.ts`), so the frames are the same bytes Express wrote.
 *
 * Every frame's `data:` is one whole `DorkOsEvent`, `{ seq, at, type, payload }`,
 * and its `event:` repeats the type (DOR-5474). Every broadcast frame carries an
 * `id:`, `events-<epoch>-<generation>-<seq>`. A reader that reconnects with it as
 * `Last-Event-ID` is sent what it missed from the bounded window
 * (`routes/global-events-connect.ts`).
 *
 * @module routes/events
 */
import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import { problem } from '@dorkos/http-kit';
import { SSE } from '../config/constants.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { initSSEStream } from '../services/core/streams/stream-adapter.js';
import { encodeBroadcast, eventFanOut, type FanOutClient } from '../services/core/event-fan-out.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { openGlobalStream } from './global-events-connect.js';

/**
 * Adapt a Node response to the fan-out's {@link FanOutClient} port.
 *
 * @param res - The SSE response to write to.
 */
function sseFanOutClient(res: ServerResponse): FanOutClient {
  return {
    send: (broadcast) => {
      res.write(broadcast.sse);
    },
    get bufferedBytes(): number {
      return res.writableLength;
    },
    get gone(): boolean {
      return res.writableEnded;
    },
    drop: () => res.destroy(),
  };
}

const router = new Hono<ApiEnv>();

/**
 * GET / — Open a unified SSE stream for all real-time events, opening with the
 * `connected` frame, the events missed since `Last-Event-ID` when the window
 * still holds them, and the fleet's current session lifecycles. Held open until
 * the client leaves.
 */
router.get('/', (c) => {
  // Answer BEFORE sending SSE headers, so a server at capacity returns a
  // readable 503 rather than a 200 that immediately fails.
  if (!eventFanOut.hasCapacity()) {
    return problem(c, 'temporarily_unavailable', {
      detail: 'Too many live connections are open. Try again soon.',
    });
  }

  // The principal comes from the chain that already ran the session gate and
  // agent identity, so an addressed event (`interaction_pending`,
  // `config_changed`) can tell this connection apart from an agent's.
  const facts = honoRequestFacts(c);
  const principal = readCallerPrincipal(facts);
  // The header an EventSource re-sends, or `?resume=`, which the socket uses.
  const header = facts.headers['last-event-id'];
  const cursor =
    (typeof header === 'string' ? header : undefined) ?? c.req.query(STREAM_RESUME_PARAM);

  return streamToNodeResponse(c, async (res, { signal }) => {
    initSSEStream(res);
    const client = sseFanOutClient(res);
    // Registers, then sends the preamble and any replay in the same tick, so no
    // transition fired while the connect is served is missed or misordered.
    const unsubscribe = openGlobalStream(client, principal, cursor);

    // Keepalive heartbeat to prevent proxies/browsers from closing the connection
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(encodeBroadcast('heartbeat', null).sse);
      } catch {
        clearInterval(heartbeat);
      }
    }, SSE.HEARTBEAT_INTERVAL_MS);

    try {
      if (!signal.aborted) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

export default router;
