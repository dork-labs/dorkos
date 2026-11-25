/**
 * The spaces gate's answer in the API document (`middleware/spaces-enabled.ts`): while the
 * spaces experiment is off, every route under its mounts answers 404 `spaces_disabled`,
 * whatever the route itself declares.
 *
 * @module services/core/openapi/spaces-gate-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problemResponse } from './problem-openapi.js';

/** The mounts the spaces gate sits in front of. */
const GATED_MOUNTS = ['/api/communities', '/api/community-connections', '/api/cloud/communities'];

/** What the gate's 404 means, added to a route's own 404 when it has one. */
const GATE_404 =
  '`spaces_disabled`: the spaces experiment is off on this computer (Settings → Advanced → Experiments).';

/** Whether a documented path sits behind the spaces gate. */
function gated(path: string): boolean {
  return GATED_MOUNTS.some((mount) => path === mount || path.startsWith(`${mount}/`));
}

/**
 * Declare the gate's 404 on every documented route behind it. Run after every route is
 * registered, the front door's gap-filled writes included.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function documentSpacesGate(registry: OpenAPIRegistry): void {
  for (const definition of registry.definitions) {
    if (definition.type !== 'route' || !gated(definition.route.path)) continue;
    const own = definition.route.responses[404];
    const described = own && 'description' in own ? own.description : undefined;
    definition.route.responses[404] = problemResponse(
      described ? `${described}; or ${GATE_404}` : GATE_404
    );
  }
}
