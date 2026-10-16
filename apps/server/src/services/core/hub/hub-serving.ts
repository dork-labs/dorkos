/**
 * Whether a hub serves anybody right now (DOR-2934).
 *
 * A hub serves only once it holds an assignment it has confirmed. Before that
 * it is pooled (nobody's yet), and after a fault (Cloud named a different
 * owner) or an ended assignment it stops for good. Until it serves, every
 * request but the health check is refused, so a pooled hub cannot be used by
 * whoever reaches it first and an ended one cannot be used by anybody.
 *
 * The live keys of the assignment (its address and front-door proof) are
 * kept here in memory only, never on disk: a hub that restarts reads them from
 * Cloud again. A person's own computer always serves; nothing here applies to
 * it.
 *
 * @module services/core/hub/hub-serving
 */
import type { HubAssignment } from '@dork-labs/cloud-api';

import { currentServerRole } from '../../../lib/server-role.js';

/** An assigned hub's live keys. */
export type LiveHubAssignment = Extract<HubAssignment, { state: 'assigned' }>;

/**
 * Where a hub is:
 *
 * - `starting` — it has not read its assignment yet;
 * - `pooled` — nobody owns it yet;
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

/** Where this hub is. Meaningful only on a hub; see {@link hubRefusesRequest}. */
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
  current = next;
}

/** The body a hub answers with while it does not serve. */
export const HUB_NOT_SERVING_BODY = {
  error: 'This DorkOS is not ready yet.',
  code: 'HUB_NOT_SERVING',
} as const;

/**
 * Whether a request is refused because this hub does not serve yet, or any
 * more. Always `false` on a person's own computer, and for the health check,
 * which Cloud reads to know the hub is up.
 *
 * @param path - The request path.
 */
export function hubRefusesRequest(path: string): boolean {
  if (currentServerRole() !== 'hub') return false;
  if (current.state === 'serving') return false;
  return path !== '/api/health';
}

/**
 * Put the state back to `starting`. Tests only: a real hub never leaves
 * `ended` or `refused` without a restart.
 *
 * @internal
 */
export function resetHubServingStateForTests(): void {
  current = { state: 'starting' };
}
