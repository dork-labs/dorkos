import { createFileSaveRecoveryMethods } from './file-saves/recovery-methods';
/** Thin document event calls. Scope and caller identity are resolved by the server. */
import type {
  PageEvent,
  CanvasChannelEventReceipt,
  CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  CanvasDocRouteChangeSchema,
  CanvasDocRouteReviewSchema,
  CanvasDocRoutesSchema,
  type CanvasDocRouteApproveRequest,
  type CanvasDocRouteChange,
  type CanvasDocRouteReview,
  type CanvasDocRouteReviewRequest,
  type CanvasDocRoutes,
} from '@dorkos/shared/canvas-doc-routes';
import { fetchJSON, fetchResponse } from './http-client';
import type { Transport } from '@dorkos/shared/transport';
/** Bind document event methods to an API URL. */
export function createCanvasDocMethods(baseUrl: string): Pick<
  Transport,
  | 'ingestCanvasEvent'
  | 'getCanvasChannel'
  | 'getCanvasEventReceipt'
  | 'getCanvasDocRoutes'
  | 'reviewCanvasDocRoute'
  | 'approveCanvasDocRoute'
  | 'revokeCanvasDocRoute'
> & {
  originalFileSaveRecovery: NonNullable<Transport['originalFileSaveRecovery']>;
} {
  const documentPath = (id: string) => `/canvas/docs/${encodeURIComponent(id)}`;
  const routePath = (id: string, routeId: string, action: string) =>
    `${documentPath(id)}/routes/${encodeURIComponent(routeId)}/${action}`;
  /** A route answer must be about the route that was asked for. */
  const sameRoute = (change: CanvasDocRouteChange, routeId: string): CanvasDocRouteChange => {
    if (change.route.id !== routeId) throw new Error('The route answer belongs to another route.');
    return change;
  };
  return {
    originalFileSaveRecovery: createFileSaveRecoveryMethods(baseUrl),
    async getCanvasDocRoutes(documentId: string): Promise<CanvasDocRoutes> {
      const routes = CanvasDocRoutesSchema.parse(
        await fetchJSON(baseUrl, `${documentPath(documentId)}/routes`)
      );
      if (routes.documentId !== documentId)
        throw new Error('The route list belongs to another document.');
      return routes;
    },
    async reviewCanvasDocRoute(
      documentId: string,
      routeId: string,
      request: CanvasDocRouteReviewRequest
    ): Promise<CanvasDocRouteReview> {
      const review = CanvasDocRouteReviewSchema.parse(
        await fetchJSON(baseUrl, routePath(documentId, routeId, 'review'), {
          method: 'POST',
          body: JSON.stringify(request),
        })
      );
      if (
        review.documentId !== documentId ||
        review.routeId !== routeId ||
        review.expiresAt !== request.expiresAt
      )
        throw new Error('The review belongs to another route or expiry.');
      return review;
    },
    async approveCanvasDocRoute(
      documentId: string,
      routeId: string,
      request: CanvasDocRouteApproveRequest
    ): Promise<CanvasDocRouteChange> {
      return sameRoute(
        CanvasDocRouteChangeSchema.parse(
          await fetchJSON(baseUrl, routePath(documentId, routeId, 'approve'), {
            method: 'POST',
            body: JSON.stringify(request),
          })
        ),
        routeId
      );
    },
    async revokeCanvasDocRoute(documentId: string, routeId: string): Promise<CanvasDocRouteChange> {
      return sameRoute(
        CanvasDocRouteChangeSchema.parse(
          await fetchJSON(baseUrl, routePath(documentId, routeId, 'revoke'), {
            method: 'POST',
            body: '{}',
          })
        ),
        routeId
      );
    },
    // Bound Doc operations own one deadline on this exact controller. The HTTP helper must
    // not replace its signal with a second timeout signal; replay retains the normal timeout.
    async ingestCanvasEvent(
      documentId: string,
      event: PageEvent,
      condition: { readonly expectedGeneration: string },
      signal: AbortSignal
    ): Promise<CanvasChannelEventReceipt> {
      const response = await fetchResponse(baseUrl, `${documentPath(documentId)}/events`, {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'X-DorkOS-Doc-Generation': condition.expectedGeneration },
        signal,
        timeout: null,
      });
      return response.json() as Promise<CanvasChannelEventReceipt>;
    },
    getCanvasChannel(
      documentId: string,
      query?: { since?: number; limit?: number }
    ): Promise<CanvasChannelReplayResponse> {
      const params = new URLSearchParams();
      if (query?.since !== undefined) params.set('since', String(query.since));
      if (query?.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.size ? `?${params}` : '';
      return fetchJSON(baseUrl, `${documentPath(documentId)}/channel${suffix}`);
    },
    // Inspection uses the original operation lifetime too, including ambiguous acceptance.
    async getCanvasEventReceipt(
      documentId: string,
      eventId: string,
      condition: { readonly expectedGeneration: string },
      signal: AbortSignal
    ): Promise<CanvasChannelEventReceipt> {
      const response = await fetchResponse(
        baseUrl,
        `${documentPath(documentId)}/events/${encodeURIComponent(eventId)}`,
        {
          headers: { 'X-DorkOS-Doc-Generation': condition.expectedGeneration },
          signal,
          timeout: null,
        }
      );
      return response.json() as Promise<CanvasChannelEventReceipt>;
    },
  };
}
