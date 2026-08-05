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
import { eventFanOut, type FanOutClient } from '../services/core/event-fan-out.js';

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

/** GET / — Open a unified SSE stream for all real-time events. */
router.get('/', (req, res) => {
  // Answer BEFORE sending SSE headers, so a server at capacity returns a
  // readable 503 rather than a 200 that immediately fails.
  if (!eventFanOut.hasCapacity()) {
    res.status(503).json({ error: 'Too many SSE clients' });
    return;
  }

  initSSEStream(res);
  const unsubscribe = eventFanOut.addClient(sseFanOutClient(res));

  // Send initial connected event
  res.write(
    `event: connected\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`
  );

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
});

export default router;
