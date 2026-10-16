/**
 * The session relay on this computer, wired to the live pieces: the pin and
 * key in the data folder, the owner check, a real WebSocket, and the request
 * server that answers relayed requests.
 *
 * The request server here serves no features yet: the relayed caller's
 * adapter (chats, the session stream, send, interrupt) is the next step of
 * DOR-2945. Until it lands, a hub that dials in is told this computer needs an
 * update for everything, and nothing on this computer can be reached. No
 * computer has a pin before the owner turns the relay on (B3), so nothing
 * dials yet either.
 *
 * @module services/core/session-relay
 */
import WebSocket from 'ws';
import { SESSION_RELAY_MAX_FRAME_LENGTH } from '@dorkos/shared/session-relay';
import { SERVER_VERSION } from '../../../lib/version.js';
import { canExpose } from '../auth/exposure-guard.js';
import { computerSigningKey, readRelayPin } from './pin-store.js';
import { RelayDialer, type RelayRequestServer, type RelaySocket } from './relay-dialer.js';

/** A request server with no features: every request waits on the adapter. */
const NO_FEATURES: RelayRequestServer = {
  features: () => [],
  handle: (frame, emit) => {
    if (frame.type !== 'request') return;
    emit({
      type: 'error',
      id: frame.id,
      ok: false,
      error: {
        status: 501,
        code: 'needs_update',
        message: 'This computer needs an update to serve this over the relay.',
      },
    });
  },
  closeAll: () => undefined,
};

let dialer: RelayDialer | null = null;

/** This computer's relay dialer, made on first use. */
export function sessionRelayDialer(): RelayDialer {
  dialer ??= new RelayDialer({
    readPin: () => readRelayPin(),
    // One source for "an owner exists for other devices to sign in as" (ADR rule 5).
    ownerExists: () => canExpose(),
    computerKey: () => computerSigningKey(),
    appVersion: SERVER_VERSION,
    server: NO_FEATURES,
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
