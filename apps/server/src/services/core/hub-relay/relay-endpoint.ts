/**
 * The hub's computer relay endpoint (B1, DOR-2944): `/api/relay/computer`, the
 * WebSocket a linked computer dials when a viewer is open
 * (`session-relay/relay-dialer.ts`).
 *
 * It is not a browser socket and not a signed-in user. It authenticates only
 * by the relay secret in `Authorization: Bearer …`, matched against the hash
 * the hub keeps for each linked computer (`computer-store.ts`), and it grants
 * nothing beyond the relay connection itself: no session, cookie or principal,
 * and it reads and writes no sign-in tables.
 *
 * Every check the upgrade router runs for every socket still runs first:
 * admission, Cloud's front door (the edge proof and the assigned `Host`, in
 * `hub/hub-serving.ts`) and the origin policy. On top of those it refuses:
 *
 * - on a person's own computer, which serves no relay endpoint (404);
 * - anything a browser sent (an `Origin` or `Sec-Fetch-Site` header), since a
 *   computer's dial sends neither (403);
 * - every dial while the hub has no signing key yet (503), checked before the
 *   secret so that a right and a wrong secret get the same answer;
 * - a missing, malformed or unknown secret (401), the same answer for each.
 *
 * **The origin in the transcript** is the address of the assignment the hub
 * serves now, never one it has been offered and not yet confirmed
 * (`offerHubAssignment`). So during an address change, a computer that pinned
 * the new address fails verification (closed, nothing served) until the
 * change is confirmed, and one that pinned the old address fails from then on
 * until it re-links. Both fail closed; neither is ever answered under an
 * origin it did not pin.
 *
 * @module services/core/hub-relay/relay-endpoint
 */
import { WebSocketServer } from 'ws';
import { SESSION_RELAY_MAX_FRAME_LENGTH } from '@dorkos/shared/session-relay';
import type { IncomingHttpHeaders } from 'node:http';
import type { UpgradeDecision, UpgradeRoute } from '../streams/upgrade-router.js';
import { currentServerRole } from '../../../lib/server-role.js';
import { hubServingState } from '../hub/hub-serving.js';
import { RELAY_COMPUTER_PATH } from '../session-relay/relay-dialer.js';
import { findComputerBySecret, type LinkedComputer } from './computer-store.js';
import {
  HubComputerConnection,
  type HubRelaySigner,
  type HubRelaySocket,
} from './computer-connection.js';
import {
  forgetConnection,
  notePendingConnection,
  promoteConnection,
} from './hub-relay-registry.js';

/** A relay secret as computers present it: 32 random bytes, base64url. */
const SECRET_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** What the endpoint reads, injectable for tests. */
export interface HubRelayEndpointDeps {
  /** Whether this server is a hub. */
  isHub: () => boolean;
  /** The hub's origin while it serves, as computers pin it; `null` otherwise. */
  servingOrigin: () => string | null;
  /** The linked computer a secret belongs to. */
  findComputer: (secret: string) => LinkedComputer | null;
  /** The hub's signing function, or `null` while it has none. */
  sign: () => HubRelaySigner['sign'] | null;
  /** Take over an accepted socket. */
  accept: (socket: HubRelaySocket, computer: LinkedComputer, signer: HubRelaySigner) => void;
}

let hubSign: HubRelaySigner['sign'] | null = null;

/**
 * Give the relay the hub's long-lived Ed25519 signing function. **The one
 * wiring point for the hub key** (lane A's `signWithHubKey`): until it is
 * called, every computer's dial is refused with 503. Pass `null` to withdraw it.
 *
 * @param sign - Signs relay transcripts with the hub's key, and nothing else.
 */
export function setHubRelaySigner(sign: HubRelaySigner['sign'] | null): void {
  hubSign = sign;
}

/**
 * The serving hub's origin, from the assignment it serves now: the origin the
 * transcript is signed over (see the module doc on address changes).
 */
function liveServingOrigin(): string | null {
  const state = hubServingState();
  return state.state === 'serving' ? new URL(state.assignment.address).origin : null;
}

/** Start a connection and register it, live. */
function acceptLive(
  socket: HubRelaySocket,
  computer: LinkedComputer,
  signer: HubRelaySigner
): void {
  notePendingConnection(
    new HubComputerConnection({
      socket,
      computer,
      signer,
      onOpen: promoteConnection,
      onClose: forgetConnection,
    })
  );
}

const liveDeps: HubRelayEndpointDeps = {
  isHub: () => currentServerRole() === 'hub',
  servingOrigin: liveServingOrigin,
  findComputer: (secret) => findComputerBySecret(secret),
  sign: () => hubSign,
  accept: acceptLive,
};

/** A refusal at the handshake, saying no more than its status. */
function refuse(status: 401 | 403 | 404 | 503): UpgradeDecision {
  const message = {
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    503: 'Service Unavailable',
  }[status];
  return { ok: false, status, message, deliver: 'handshake' };
}

/** Whether a header a browser always sends on a WebSocket handshake is present. */
function fromBrowser(headers: IncomingHttpHeaders): boolean {
  return headers.origin !== undefined || headers['sec-fetch-site'] !== undefined;
}

/**
 * The upgrade route for `/api/relay/computer`.
 *
 * @param deps - Override for tests; defaults to the live store, role and key.
 */
export function hubRelayComputerRoute(deps: HubRelayEndpointDeps = liveDeps): UpgradeRoute {
  return {
    name: 'hub-relay-computer',
    pattern: new RegExp(`^${RELAY_COMPUTER_PATH.replaceAll('/', '\\/')}$`),
    // The relay secret is the bearer, checked in `authorize`; the sign-in gate
    // has nothing to say about a computer, which is never a signed-in user.
    credential: 'bearer-of-id',
    // One sealed frame at most, never `ws`'s 100 MB default, and no compression.
    webSocketServer: new WebSocketServer({
      noServer: true,
      maxPayload: SESSION_RELAY_MAX_FRAME_LENGTH + 4096,
      perMessageDeflate: false,
    }),
    authorize({ headers }): UpgradeDecision {
      if (!deps.isHub()) return refuse(404);
      const origin = deps.servingOrigin();
      if (!origin) return refuse(503);
      if (fromBrowser(headers)) return refuse(403);
      // Before the secret: with no key, a right and a wrong secret read the same.
      const sign = deps.sign();
      if (!sign) return refuse(503);
      const secret = SECRET_PATTERN.exec(headers.authorization ?? '')?.[1];
      const computer = secret ? deps.findComputer(secret) : null;
      if (!computer) return refuse(401);
      return {
        ok: true,
        open: (ws) => deps.accept(ws as unknown as HubRelaySocket, computer, { sign, origin }),
      };
    },
  };
}
