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
 * found. No computer has a pin before the owner links it to a hub (B3), and
 * nothing dials while the `sessionRelay.enabled` experiment is off or the
 * owner has paused the link, pin or not.
 *
 * @module services/core/session-relay
 */
import WebSocket from 'ws';
import { SESSION_RELAY_MAX_FRAME_LENGTH } from '@dorkos/shared/session-relay';
import { logger } from '../../../lib/logger.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import { canExpose } from '../auth/exposure-guard.js';
import { configManager } from '../config-manager.js';
import {
  computerSigningKey,
  readRelayPin,
  updateRelayPin,
  withRelayPinLock,
  type RelayPin,
} from './pin-store.js';
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

/**
 * Whether the person turned on chatting from the web (`sessionRelay.enabled`,
 * an experiment, off by default). Read on every call, so turning it off stops
 * the next dial and the next viewer report closes an open connection.
 */
export function sessionRelayEnabled(): boolean {
  return configManager.get('sessionRelay')?.enabled === true;
}

/**
 * The pin the dialer may use: none while the experiment is off or the owner
 * has paused the link, so the dialer's every check (at the dial and on each
 * viewer report) treats either as no pin.
 *
 * @param read - Reads the stored pin; the live file by default.
 */
export function dialablePin(read: () => RelayPin | null = () => readRelayPin()): RelayPin | null {
  if (!sessionRelayEnabled()) return null;
  const pin = read();
  return pin && !pin.paused ? pin : null;
}

let dialer: RelayDialer | null = null;

/** This computer's relay dialer, made on first use. */
export function sessionRelayDialer(): RelayDialer {
  dialer ??= new RelayDialer({
    readPin: () => dialablePin(),
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

/**
 * Close the relay, if it was ever started. At shutdown, when the pin is
 * removed, and when the owner pauses it.
 */
export function closeSessionRelay(): void {
  dialer?.close();
}

let stopWatching: (() => void) | null = null;

/**
 * Close a live relay the moment the person switches the experiment off,
 * rather than at the next frame from the hub, and pause the link (under the
 * pin lock, if there is one), so switching it back on never dials again
 * without the owner's Resume and password. Called once at startup; a later
 * call replaces the earlier watch.
 *
 * @param onChange - Subscribe to config writes; the live config by default.
 * @param dorkHome - The data folder; the live one by default.
 */
export function watchSessionRelaySwitch(
  onChange: typeof configManager.onChange = (listener) => configManager.onChange(listener),
  dorkHome?: string
): void {
  stopWatching?.();
  stopWatching = onChange((change) => {
    if (!change.paths.some((p) => p === 'sessionRelay' || p.startsWith('sessionRelay.'))) return;
    if (sessionRelayEnabled()) return;
    closeSessionRelay();
    void withRelayPinLock(async () => {
      const pin = readRelayPin(dorkHome);
      if (pin && !pin.paused) await updateRelayPin({ paused: true }, dorkHome);
    }).catch((error: unknown) => {
      logger.warn('[SessionRelay] Could not pause the link when switched off', {
        error: (error as Error).name,
      });
    });
  });
}

/** Whether the relay connection is open right now; `false` when it never started. */
export function sessionRelayConnected(): boolean {
  return dialer?.connected ?? false;
}
