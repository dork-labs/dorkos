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
  CanvasDocWork,
  CanvasDocWorkChange,
  CanvasDocWorkReplayRequest,
} from './canvas-doc-routes.js';

/** Read, review, allow and turn off one document's event routes, and review its unfinished work. */
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
  /** Turn a route off, every grant it holds. New events stop starting work. */
  revokeCanvasDocRoute(documentId: string, routeId: string): Promise<CanvasDocRouteChange>;
  /** Work on a document that expired or ended in doubt, waiting on a person. */
  getCanvasDocWork(documentId: string): Promise<CanvasDocWork>;
  /** Run one piece of reviewed work again, as new work under the route's current grant. */
  replayCanvasDocWork(
    documentId: string,
    batchId: string,
    request: CanvasDocWorkReplayRequest
  ): Promise<CanvasDocWorkChange>;
  /** Set one piece of work aside without running it. */
  clearCanvasDocWork(documentId: string, batchId: string): Promise<CanvasDocWorkChange>;
}
