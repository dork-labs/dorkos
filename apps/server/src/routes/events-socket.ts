/**
 * The unified global event stream, `GET /api/events`, as a WebSocket.
 *
 * One multiplexed connection carrying every real-time broadcast the server
 * produces — session-list changes, room activity, relay traffic, tunnel status,
 * approvals. Clients filter by the frame's event name rather than opening a
 * connection per resource, which is why one window needs one of these however
 * many features it is showing.
 *
 * Each message is one `DorkOsEvent` envelope with its resume cursor beside it
 * as `id` (DOR-5474), unlike the chat and room sockets' `{ event, data, id }`;
 * the keepalive is a `heartbeat` envelope too.
 *
 * It moved off SSE with the other two durable streams (ADR 260805-041016). This
 * one mattered most: every window opens it unconditionally, so it was two of
 * the six sockets a three-window cockpit spent before it stopped responding.
 *
 * @module routes/events-socket
 */
import type { WebSocket } from 'ws';
import { upgradeCaller } from '../services/core/streams/stream-upgrade-auth.js';
import { STREAM_RESUME_PARAM } from '@dorkos/shared/stream-socket';
import { encodeBroadcast, eventFanOut, type FanOutClient } from '../services/core/event-fan-out.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { openGlobalStream } from './global-events-connect.js';
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

  authorize({ url, headers, locals }: UpgradeAttempt): UpgradeDecision {
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
        // Its keepalive is a `heartbeat` envelope like every other frame here.
        const socket = new DurableStreamSocket(ws, () => encodeBroadcast('heartbeat', null).json);
        const client = fanOutClient(ws);
        // `StreamUpgradeLocals` carries a request's identity fields precisely so
        // this reads the same principal an HTTP request would, with no second
        // notion of who a caller is (`stream-upgrade-auth.ts`).
        const principal = readCallerPrincipal(upgradeCaller(headers, locals));
        // Registration, the preamble, any replay from `?resume=` and the
        // fleet's current lifecycles (DOR-1136), in one tick, so a live
        // transition cannot land ahead of the snapshot it supersedes.
        const unsubscribe = openGlobalStream(
          client,
          principal,
          url.searchParams.get(STREAM_RESUME_PARAM) ?? undefined
        );
        socket.signal.addEventListener('abort', unsubscribe, { once: true });
      },
    };
  },
};
