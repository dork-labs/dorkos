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
 * @module routes/events
 */
import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import { SSE } from '../config/constants.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { initSSEStream } from '../services/core/streams/stream-adapter.js';
import { eventFanOut, encodeBroadcast, type FanOutClient } from '../services/core/event-fan-out.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { sendSessionStatusSnapshot } from '../services/session/catalog/session-list-broadcaster.js';

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
 * `connected` frame and the fleet's current session lifecycles. Held open until
 * the client leaves.
 */
router.get('/', (c) => {
  // Answer BEFORE sending SSE headers, so a server at capacity returns a
  // readable 503 rather than a 200 that immediately fails.
  if (!eventFanOut.hasCapacity()) return c.json({ error: 'Too many SSE clients' }, 503);

  // The principal comes from the chain that already ran the session gate and
  // agent identity, so an addressed event (`interaction_pending`,
  // `config_changed`) can tell this connection apart from an agent's.
  const principal = readCallerPrincipal(honoRequestFacts(c));

  return streamToNodeResponse(c, async (res, { signal }) => {
    initSSEStream(res);
    const client = sseFanOutClient(res);
    // Registration comes BEFORE the preamble below, and that ordering is the
    // one that matters: it is what makes it impossible to MISS a transition
    // that fires while the connect is being served. The reverse — snapshot,
    // then register — has a window in which a transition reaches nobody.
    const unsubscribe = eventFanOut.addClient(client, principal);

    // Keepalive heartbeat to prevent proxies/browsers from closing the connection
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write('event: heartbeat\ndata: \n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, SSE.HEARTBEAT_INTERVAL_MS);

    try {
      // The connect preamble: `connected`, then the fleet's current lifecycles.
      client.send(encodeBroadcast('connected', { connectedAt: new Date().toISOString() }));
      sendSessionStatusSnapshot(client, principal);
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
