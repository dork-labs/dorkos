/**
 * `/api/session-relay` as the app serves it, for a route test: the mount's
 * doors (`session-relay-capabilities.ts`, DOR-4978), then the hand routes, over
 * one set of seams.
 *
 * @module routes/__tests__/session-relay-groups
 */
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import type { MountedGroup } from '../../http/__tests__/hono-group-listener.js';
import { sessionRelayDomain } from '../../services/core/session-relay-doors/session-relay-capabilities.js';
import {
  createSessionRelayRoutes,
  sessionRelayDoorDeps,
  type SessionRelayRouteDeps,
} from '../session-relay.js';

export type { SessionRelayRouteDeps };

/**
 * The mount's doors and the hand routes, in the app's order.
 *
 * @param deps - The seams both read.
 */
export function sessionRelayGroups(deps: SessionRelayRouteDeps): MountedGroup[] {
  return [
    capabilityGroup(sessionRelayDomain, { sessionRelayDeps: sessionRelayDoorDeps(deps) }),
    { path: '/api/session-relay', routes: createSessionRelayRoutes(deps) },
  ];
}
