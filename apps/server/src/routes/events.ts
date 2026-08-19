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
 * @module routes/events
 */
import type { Response } from 'express';
import { Router } from 'express';
import { SSE } from '../config/constants.js';
import { initSSEStream } from '../services/core/streams/stream-adapter.js';
import { eventFanOut, encodeBroadcast, type FanOutClient } from '../services/core/event-fan-out.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { sendSessionStatusSnapshot } from '../services/session/session-list-broadcaster.js';

/**
 * Adapt an Express response to the fan-out's {@link FanOutClient} port.
 *
 * @param res - The SSE response to write to.
 */
function sseFanOutClient(res: Response): FanOutClient {
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

const router = Router();

/**
 * GET / — Open a unified SSE stream for all real-time events, opening with the
 * `connected` frame and the fleet's current session lifecycles.
 */
router.get('/', (req, res) => {
  // Answer BEFORE sending SSE headers, so a server at capacity returns a
  // readable 503 rather than a 200 that immediately fails.
  if (!eventFanOut.hasCapacity()) {
    res.status(503).json({ error: 'Too many SSE clients' });
    return;
  }

  initSSEStream(res);
  const client = sseFanOutClient(res);
  // Registration comes BEFORE the preamble below, and that ordering is the one
  // that matters: it is what makes it impossible to MISS a transition that
  // fires while the connect is being served. The reverse — snapshot, then
  // register — has a window in which a transition reaches nobody.
  //
  // The principal comes from the same Express chain that already ran
  // `sessionGate` and `resolveAgentIdentity`, so an addressed event (today only
  // `interaction_pending`) can tell this connection apart from an agent's.
  const unsubscribe = eventFanOut.addClient(client, readCallerPrincipal(req, res));

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

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  // The connect preamble: `connected`, then the fleet's current lifecycles.
  //
  // Written LAST so the teardown above is already armed: a preamble is the one
  // place this handler writes more than a single frame, and it should not be
  // the one stretch with no close handler behind it.
  client.send(encodeBroadcast('connected', { connectedAt: new Date().toISOString() }));
  sendSessionStatusSnapshot(client);
});

export default router;
