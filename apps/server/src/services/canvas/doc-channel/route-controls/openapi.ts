/** API documentation for a person's document route controls (`routes/canvas-doc-route-controls.ts`). */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  CanvasDocRouteApproveRequestSchema,
  CanvasDocRouteChangeSchema,
  CanvasDocRouteReviewRequestSchema,
  CanvasDocRouteReviewSchema,
  CanvasDocRouteRevokeRequestSchema,
  CanvasDocRoutesSchema,
} from '@dorkos/shared/canvas-doc-routes';

const RefusalSchema = z.object({ error: z.string(), code: z.string() });
const refusal = (description: string) => ({
  description,
  content: { 'application/json': { schema: RefusalSchema } },
});
const id = z.string().min(1).max(200);
const PERSON =
  'Operator only. Writes also refuse an agent identity or approval token in every posture, ' +
  'and with login on accept only a signed-in session cookie, as approval decisions do.';

/** Register the four route-control paths. */
export function registerDocRouteControlsOpenApi(registry: OpenAPIRegistry): void {
  const failures = {
    400: refusal('Invalid path, query or body'),
    401: refusal('Sign-in required'),
    403: refusal('Not a person, or the document is out of reach'),
    404: refusal('Document, route or grant unavailable'),
    503: refusal('Document routes are not composed on this server'),
  };
  registry.registerPath({
    method: 'get',
    path: '/api/canvas/docs/{id}/routes',
    tags: ['Canvas'],
    summary: 'List a document’s declared event routes and their state',
    description:
      'Operator only. A route is granted only when the grant service revalidates it now; a ' +
      'declared route nobody allowed is no_grant. Approval evidence is never returned.',
    request: { params: z.object({ id }) },
    responses: {
      200: {
        description: 'Every declared route',
        content: { 'application/json': { schema: CanvasDocRoutesSchema } },
      },
      ...failures,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/canvas/docs/{id}/routes/{routeId}/review',
    tags: ['Canvas'],
    summary: 'Show the exact details allowing a route would bind',
    description: `${PERSON} Records nothing. reviewHash covers the document, route, declaration, app, target, types, limits and expiry.`,
    request: {
      params: z.object({ id, routeId: id }),
      body: {
        required: true,
        content: { 'application/json': { schema: CanvasDocRouteReviewRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'The reviewed binding',
        content: { 'application/json': { schema: CanvasDocRouteReviewSchema } },
      },
      ...failures,
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/canvas/docs/{id}/routes/{routeId}/approve',
    tags: ['Canvas'],
    summary: 'Allow a reviewed route',
    description: `${PERSON} Records a person's approval through the approval service and grants it only while the current binding still matches reviewHash; otherwise 409 ROUTE_CHANGED.`,
    request: {
      params: z.object({ id, routeId: id }),
      body: {
        required: true,
        content: { 'application/json': { schema: CanvasDocRouteApproveRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'The route as it now stands',
        content: { 'application/json': { schema: CanvasDocRouteChangeSchema } },
      },
      ...failures,
      409: refusal('The route changed since review, or is already on'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/canvas/docs/{id}/routes/{routeId}/revoke',
    tags: ['Canvas'],
    summary: 'Turn a route’s grant off',
    description: `${PERSON} New events stop starting work. Work already started keeps its recorded source.`,
    request: {
      params: z.object({ id, routeId: id }),
      body: {
        required: true,
        content: { 'application/json': { schema: CanvasDocRouteRevokeRequestSchema } },
      },
    },
    responses: {
      200: {
        description: 'The route as it now stands',
        content: { 'application/json': { schema: CanvasDocRouteChangeSchema } },
      },
      ...failures,
    },
  });
}
