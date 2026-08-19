/**
 * The unified global event stream, `GET /api/events`, as a WebSocket.
 *
 * One multiplexed connection carrying every real-time broadcast the server
 * produces — session-list changes, room activity, relay traffic, tunnel status,
 * approvals. Clients filter by the frame's event name rather than opening a
 * connection per resource, which is why one window needs one of these however
 * many features it is showing.
 *
 * It moved off SSE with the other two durable streams (ADR 260805-041016). This
 * one mattered most: every window opens it unconditionally, so it was two of
 * the six sockets a three-window cockpit spent before it stopped responding.
 *
 * @module routes/events-socket
 */
import type { WebSocket } from 'ws';
import { eventFanOut, encodeBroadcast, type FanOutClient } from '../services/core/event-fan-out.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { sendSessionStatusSnapshot } from '../services/session/session-list-broadcaster.js';
import { DurableStreamSocket } from '../services/core/streams/stream-socket.js';
import type {
  UpgradeAttempt,
  UpgradeDecision,
  UpgradeRoute,
} from '../services/core/streams/upgrade-router.js';

/** Matches `/api/events` — the whole path, no captures. */
const EVENTS_PATH = /^\/api\/events$/;

/** `WebSocket.readyState` for an open connection (mirrors `ws`'s `WebSocket.OPEN`). */
const WS_OPEN = 1;

/**
 * Adapt a WebSocket to the fan-out's {@link FanOutClient} port.
 *
 * @param ws - The connected socket.
 */
function fanOutClient(ws: WebSocket): FanOutClient {
  return {
    send: (broadcast) => {
      if (ws.readyState === WS_OPEN) ws.send(broadcast.json);
    },
    get bufferedBytes(): number {
      return ws.bufferedAmount;
    },
    get gone(): boolean {
      return ws.readyState !== WS_OPEN;
    },
    drop: () => ws.terminate(),
  };
}

/** The upgrade route for the global broadcast stream. */
export const globalEventsRoute: UpgradeRoute = {
  name: 'global-events',
  pattern: EVENTS_PATH,
  // The router runs the credential gate before this is called.
  credential: 'required',

  authorize({ headers, locals }: UpgradeAttempt): UpgradeDecision {
    // Refusals go out as a close frame rather than a failed handshake: a
    // browser cannot read the status of a failed one, and "you are signed out"
    // has to be distinguishable from "the server is briefly down".
    const refuse = (status: number, message: string): UpgradeDecision => ({
      ok: false,
      status,
      message,
      deliver: 'close-frame',
    });

    if (!eventFanOut.hasCapacity()) return refuse(503, 'Service Unavailable');

    return {
      ok: true,
      open: (ws) => {
        // Heartbeats and close teardown come from the shared socket wrapper; the
        // fan-out only ever pushes, so nothing here drives a send loop.
        const socket = new DurableStreamSocket(ws);
        const client = fanOutClient(ws);
        // `StreamUpgradeLocals` is `res.locals`-shaped precisely so this reads
        // the same principal an HTTP request would, with no second notion of
        // who a caller is (`stream-upgrade-auth.ts`).
        const principal = readCallerPrincipal({ headers }, { locals });
        const unsubscribe = eventFanOut.addClient(client, principal);
        socket.signal.addEventListener('abort', unsubscribe, { once: true });
        // The connect preamble: `connected`, then the fleet's current
        // lifecycles, so a window that opened after a session errored or
        // blocked still learns about it (DOR-1136). Registration first and no
        // await in between, so a live transition cannot land ahead of the
        // snapshot it supersedes.
        client.send(encodeBroadcast('connected', { connectedAt: new Date().toISOString() }));
        sendSessionStatusSnapshot(client, principal);
      },
    };
  },
};
