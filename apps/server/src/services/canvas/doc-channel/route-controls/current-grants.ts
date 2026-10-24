/**
 * Which grant currently admits each route's events, as both the route controls
 * and the work review read it.
 *
 * @module services/canvas/doc-channel/route-controls/current-grants
 */
import { CanvasAppManifestError } from '@dorkos/shared/canvas-app-manifest';
import { DocChannelNotFoundError } from '../authorization.js';
import type { DocChannelGrants } from '../grants.js';
import { DocRouteGrantError, type DocGrantActor } from '../grant-policy.js';

/**
 * An expected refusal while reading authority, never a storage fault.
 *
 * @param error - What was thrown.
 */
export function isDocAuthorityRefusal(error: unknown): error is Error {
  return (
    error instanceof DocRouteGrantError ||
    error instanceof DocChannelNotFoundError ||
    error instanceof CanvasAppManifestError
  );
}

/**
 * Grant ids that admit events right now, by route id. Empty when authority
 * cannot be read: a changed or unreadable app manifest suspends every grant.
 *
 * @param grants - The grant service.
 * @param documentId - The document.
 * @param actor - The verified caller.
 */
export function currentRouteGrants(
  grants: Pick<DocChannelGrants, 'getCurrentRoutes'>,
  documentId: string,
  actor: DocGrantActor
): Map<string, string> {
  const current = new Map<string, string>();
  try {
    for (const route of grants.getCurrentRoutes(documentId, undefined, actor))
      if (route.grantId && !route.reason) current.set(route.route.id, route.grantId);
  } catch (error) {
    if (!isDocAuthorityRefusal(error)) throw error;
  }
  return current;
}
