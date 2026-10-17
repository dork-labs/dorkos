/**
 * A canvas document's route controls, as the client reaches them. A slice of
 * the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-canvas-doc-routes
 */
import type {
  CanvasDocRouteApproveRequest,
  CanvasDocRouteChange,
  CanvasDocRouteReview,
  CanvasDocRouteReviewRequest,
  CanvasDocRoutes,
} from './canvas-doc-routes.js';

/** Read, review, allow and turn off one document's event routes. */
export interface CanvasDocRouteTransport {
  /** Every declared route on a document, with its current state. */
  getCanvasDocRoutes(documentId: string): Promise<CanvasDocRoutes>;
  /** The exact details allowing a route would bind. Changes nothing. */
  reviewCanvasDocRoute(
    documentId: string,
    routeId: string,
    request: CanvasDocRouteReviewRequest
  ): Promise<CanvasDocRouteReview>;
  /** Allow a reviewed route; refused when anything shown has changed since. */
  approveCanvasDocRoute(
    documentId: string,
    routeId: string,
    request: CanvasDocRouteApproveRequest
  ): Promise<CanvasDocRouteChange>;
  /** Turn a route's grant off. New events stop starting work. */
  revokeCanvasDocRoute(
    documentId: string,
    routeId: string,
    grantId: string
  ): Promise<CanvasDocRouteChange>;
}
