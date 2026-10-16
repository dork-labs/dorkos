/**
 * The session relay on this computer, wired to the live pieces: the pin and
 * key in the data folder, the owner check, a real WebSocket, and the request
 * server that answers relayed requests as the `relayed` caller
 * (`relay-request-server.ts`).
 *
 * Nothing is built at import: the dialer and its request server are made on
 * first use, and the request server reads Mesh, the origin lookups and the
 * room port from {@link wireSessionRelay}, which the server calls once they
 * exist. Before that there are no agents, so every request is answered as not
 * found. No computer has a pin before the owner turns the relay on (B3), so
 * nothing dials yet either.
 *
 * @module services/core/session-relay
 */
import WebSocket from 'ws';
import { SESSION_RELAY_MAX_FRAME_LENGTH } from '@dorkos/shared/session-relay';
import { SERVER_VERSION } from '../../../lib/version.js';
import { canExpose } from '../auth/exposure-guard.js';
import { computerSigningKey, readRelayPin } from './pin-store.js';
import { liveRelayDeps, type SessionRelayWiring } from './live-deps.js';
import { RelayDialer, type RelaySocket } from './relay-dialer.js';
import { SessionRelayRequestServer } from './relay-request-server.js';

export type { SessionRelayWiring } from './live-deps.js';

let wiring: SessionRelayWiring | null = null;

/**
 * Hand the relay the server's startup pieces. Called once, after the session
 * routes' origin lookups and the room port are set up; read on every request.
 *
 * @param pieces - See {@link SessionRelayWiring}.
 */
export function wireSessionRelay(pieces: SessionRelayWiring): void {
  wiring = pieces;
}

let dialer: RelayDialer | null = null;

/** This computer's relay dialer, made on first use. */
export function sessionRelayDialer(): RelayDialer {
  dialer ??= new RelayDialer({
    readPin: () => readRelayPin(),
    // One source for "an owner exists for other devices to sign in as" (ADR rule 5).
    ownerExists: () => canExpose(),
    computerKey: () => computerSigningKey(),
    appVersion: SERVER_VERSION,
    server: new SessionRelayRequestServer(liveRelayDeps(() => wiring)),
    connect: (url, headers) =>
      new WebSocket(url, {
        headers,
        // Bounded before the hub is verified: one sealed frame at most, never
        // the library's 100 MB, and no compression to inflate.
        maxPayload: RELAY_MAX_SOCKET_PAYLOAD,
        perMessageDeflate: false,
        // Never follow a redirect: the relay secret goes only to the pinned origin.
        followRedirects: false,
      }) as unknown as RelaySocket,
  });
  return dialer;
}

/**
 * The largest WebSocket message accepted: one sealed frame at the protocol's
 * cap, with room for the base64url and the frame's own JSON around it.
 */
const RELAY_MAX_SOCKET_PAYLOAD = SESSION_RELAY_MAX_FRAME_LENGTH + 4096;

/** Close the relay, if it was ever started. At shutdown, and when the pin is removed. */
export function closeSessionRelay(): void {
  dialer?.close();
}
