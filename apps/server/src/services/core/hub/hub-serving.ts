/**
 * Whether a hub serves anybody right now (DOR-2934).
 *
 * A hub serves only once it holds an assignment it has confirmed. Before that
 * it is pooled (nobody's yet), and after a fault (Cloud named a different
 * owner) or an ended assignment it stops for good. Until it serves, every
 * request but the health check is refused, so a pooled hub cannot be used by
 * whoever reaches it first and an ended one cannot be used by anybody.
 *
 * Once it serves, a request must also have come through Cloud's front door:
 * exactly one copy of the front-door proof header, carrying the assignment's
 * secret, which is removed before anything else reads the request. And its
 * `Host` must be the assignment's address, and nothing else. A new
 * assignment's proof and address are accepted from the moment the hub reads
 * them ({@link offerHubAssignment}), before it confirms, since the front door
 * may switch the moment Cloud records the confirmation. The old proof stays
 * accepted until `REMOTE_EDGE_PROOF_OVERLAP_SECONDS` after the confirmation
 * succeeds, as the contract says (`@dork-labs/cloud-api`
 * `HubAssignmentSchema`). The check is the managed
 * edge's own (`services/core/remote/edge-proof.ts`).
 *
 * The live keys of the assignment (its address and front-door proof) are
 * kept here in memory only, never on disk: a hub that restarts reads them from
 * Cloud again. A person's own computer always serves; nothing here applies to
 * it.
 *
 * @module services/core/hub/hub-serving
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { HubAssignment } from '@dork-labs/cloud-api';

import { currentServerRole } from '../../../lib/server-role.js';
import { REMOTE_EDGE_PROOF_OVERLAP_SECONDS } from '@dork-labs/cloud-api';

import { logger } from '../../../lib/logger.js';
import {
  checkEdgeProof,
  rotateEdgeProofState,
  stripEdgeProofHeaders,
  type EdgeProofState,
} from '../remote/edge-proof.js';

/** An assigned hub's live keys. */
export type LiveHubAssignment = Extract<HubAssignment, { state: 'assigned' }>;

/**
 * Where a hub is:
 *
 * - `starting` — it has not read its assignment yet;
 * - `pooled` — nobody owns it yet, or its last answer from Cloud made no
 *   sense to this release;
 * - `serving` — it serves its owner with `assignment`;
 * - `ended` — Cloud ended its assignment;
 * - `refused` — Cloud named a different owner than the one it serves. It
 *   never serves the new owner from the old owner's data.
 */
export type HubServingState =
  | { state: 'starting' }
  | { state: 'pooled' }
  | { state: 'serving'; assignment: LiveHubAssignment }
  | { state: 'ended' }
  | { state: 'refused' };

let current: HubServingState = { state: 'starting' };

/** The front-door proofs a serving hub accepts: the current one, and briefly the last. */
let proofs: EdgeProofState | null = null;

/** A new address read but not yet confirmed, accepted beside the current one. */
let offeredAddress: string | null = null;

/**
 * Every connection open to this hub. A hub that stops serving drops them all,
 * so a stream opened while it served carries nothing more once it no longer
 * does.
 */
const openConnections = new Set<Duplex>();

/** Where this hub is. Meaningful only on a hub; see {@link admitHubRequest}. */
export function hubServingState(): HubServingState {
  return current;
}

/**
 * Move this hub to a new state. An `ended` or `refused` hub stays there: only a
 * restart, and a fresh read of its assignment, can bring it back.
 *
 * @param next - The state to move to.
 */
export function setHubServingState(next: HubServingState): void {
  if (current.state === 'ended' || current.state === 'refused') return;
  const wasServing = current.state === 'serving';
  current = next;
  if (next.state === 'serving') {
    // Called once the assignment is confirmed, so the old proof's overlap runs
    // from now.
    const now = Date.now();
    proofs = rotateEdgeProofState(proofs, next.assignment.frontDoorProof, now);
    if (proofs.previous?.acceptUntil === Number.POSITIVE_INFINITY) {
      proofs = {
        current: proofs.current,
        previous: {
          proof: proofs.previous.proof,
          acceptUntil: now + REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 1000,
        },
      };
    }
    offeredAddress = null;
  } else {
    proofs = null;
    offeredAddress = null;
    if (wasServing) dropOpenConnections();
  }
}

/**
 * Accept a just-read assignment's proof and address before confirming it. The
 * proof it replaces stays accepted, with no deadline yet: the overlap starts
 * only once the confirmation succeeds ({@link setHubServingState}), so a
 * confirmation that fails, or whose answer is lost, refuses nobody.
 *
 * @param assignment - The assignment about to be confirmed.
 */
export function offerHubAssignment(assignment: LiveHubAssignment): void {
  if (current.state === 'ended' || current.state === 'refused') return;
  proofs = rotateEdgeProofState(proofs, assignment.frontDoorProof, Number.POSITIVE_INFINITY);
  offeredAddress = assignment.address;
}

/**
 * Track one connection, an HTTP request's or a stream upgrade's, so it is
 * dropped if this hub stops serving. Does nothing on a person's own computer.
 *
 * @param socket - The connection's socket.
 */
export function trackHubConnection(socket: Duplex): void {
  if (currentServerRole() !== 'hub' || socket.destroyed || openConnections.has(socket)) return;
  openConnections.add(socket);
  socket.once('close', () => openConnections.delete(socket));
}

/** Drop every tracked connection. */
function dropOpenConnections(): void {
  for (const socket of openConnections) socket.destroy();
  openConnections.clear();
}

/** The body a hub answers with while it does not serve. */
export const HUB_NOT_SERVING_BODY = {
  error: 'This DorkOS is not ready yet.',
  code: 'HUB_NOT_SERVING',
} as const;

/** The body a hub answers a request with that did not come through its front door. */
export const HUB_FRONT_DOOR_BODY = {
  error: 'This address does not serve that request.',
  code: 'HUB_FRONT_DOOR',
} as const;

/** Why a hub refused a request, and what to answer it with. */
export interface HubRefusal {
  status: 403 | 503;
  body: typeof HUB_NOT_SERVING_BODY | typeof HUB_FRONT_DOOR_BODY;
}

/** The one path a hub answers without serving: Cloud reads it to know the hub is up. */
const HEALTH_PATH = '/api/health';

/**
 * Admit one request or stream upgrade to this hub, or say why not. Call it
 * before anything else reads the request: an admitted request has had every
 * copy of the proof header removed.
 *
 * Always admits on a person's own computer. On a hub, the health check is
 * admitted as long as its target is exactly `/api/health`; everything else
 * must find the hub serving, carry exactly one matching proof, and name the
 * assignment's address as its `Host`.
 *
 * @param req - The request, as Node parsed it.
 */
export function admitHubRequest(req: IncomingMessage): HubRefusal | null {
  if (currentServerRole() !== 'hub') return null;
  if (isHealthCheck(req.url)) {
    // The front door adds its proof to the health check too; it never goes further.
    if (proofs) stripEdgeProofHeaders(req, proofs);
    return null;
  }
  if (current.state !== 'serving' || !proofs) {
    return { status: 503, body: HUB_NOT_SERVING_BODY };
  }
  const proof = checkEdgeProof(req.rawHeaders, proofs, Date.now());
  if (!proof.ok) {
    logger.warn('[Hub] Refused a request that did not come through the front door', {
      reason: proof.reason,
    });
    return { status: 403, body: HUB_FRONT_DOOR_BODY };
  }
  stripEdgeProofHeaders(req, proofs);
  if (!isAssignedHost(req.headers.host, [current.assignment.address, offeredAddress])) {
    logger.warn('[Hub] Refused a request for another address');
    return { status: 403, body: HUB_FRONT_DOOR_BODY };
  }
  return null;
}

/**
 * Whether a request target is exactly the health check, with or without a
 * query. Read from the raw target, never a parsed one, so nothing that routes
 * anywhere else can pass for it.
 */
function isHealthCheck(target: string | undefined): boolean {
  if (!target) return false;
  const query = target.indexOf('?');
  return (query === -1 ? target : target.slice(0, query)) === HEALTH_PATH;
}

/**
 * Whether a `Host` header names exactly one of the accepted addresses. An
 * explicit `:443` names the same https origin as none, so it is accepted too.
 */
function isAssignedHost(host: string | undefined, accepted: (string | null)[]): boolean {
  if (!host) return false;
  const named = host.toLowerCase().replace(/:443$/, '');
  return accepted.some((address) => {
    if (!address) return false;
    return named === new URL(address).host;
  });
}

/**
 * Put the state back to `starting`. Tests only: a real hub never leaves
 * `ended` or `refused` without a restart.
 *
 * @internal
 */
export function resetHubServingStateForTests(): void {
  current = { state: 'starting' };
  proofs = null;
  offeredAddress = null;
  openConnections.clear();
}
