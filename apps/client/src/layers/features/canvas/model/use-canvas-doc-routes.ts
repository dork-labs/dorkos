/**
 * Server state for one document's route controls: the route list, a review of
 * one route, and the two changes a person can make.
 *
 * @module features/canvas/model/use-canvas-doc-routes
 */
import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanvasDocRouteChange, CanvasDocRoutes } from '@dorkos/shared/canvas-doc-routes';
import { useTransport } from '@/layers/shared/model';

/** The cache key for one document's routes. */
export const canvasDocRoutesKey = (documentId: string) =>
  ['canvas-doc-routes', documentId] as const;

/**
 * Every declared route on a document.
 *
 * Polls quickly while the controls are open, so an agent's new request or a
 * grant that ran out shows without a reload, and slowly while they are closed,
 * so routes an agent declares after the document opened still get a button.
 * No retry: a document without a channel answers
 * 404 for good, and the header simply draws nothing for it.
 *
 * @param documentId - The document.
 * @param open - Whether the controls are open.
 */
export function useCanvasDocRoutes(documentId: string, open: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: canvasDocRoutesKey(documentId),
    queryFn: () => transport.getCanvasDocRoutes(documentId),
    retry: false,
    // This server is local; `online` would pause the read whenever the computer
    // reports no internet, which says nothing about reaching DorkOS.
    networkMode: 'always',
    staleTime: 5_000,
    refetchInterval: open ? 15_000 : 60_000,
  });
}

/**
 * The exact details allowing one route would bind, for the expiry picked.
 *
 * @param documentId - The document.
 * @param routeId - The route under review.
 * @param expiresAt - The picked end time; no review runs without one.
 */
export function useCanvasDocRouteReview(
  documentId: string,
  routeId: string,
  expiresAt: string | null
) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['canvas-doc-route-review', documentId, routeId, expiresAt],
    queryFn: () => transport.reviewCanvasDocRoute(documentId, routeId, { expiresAt: expiresAt! }),
    enabled: expiresAt !== null,
    retry: false,
    networkMode: 'always',
    staleTime: Infinity,
    gcTime: 0,
  });
}

/**
 * Allow a reviewed route, or turn one off. Each answer replaces that route in
 * the cached list, then the list is read again.
 *
 * @param documentId - The document.
 */
export function useCanvasDocRouteActions(documentId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const settle = (change: CanvasDocRouteChange) => {
    queryClient.setQueryData<CanvasDocRoutes>(canvasDocRoutesKey(documentId), (old) =>
      old
        ? {
            ...old,
            routes: old.routes.map((route) =>
              route.id === change.route.id ? change.route : route
            ),
          }
        : old
    );
    void queryClient.invalidateQueries({ queryKey: canvasDocRoutesKey(documentId) });
  };
  const approve = useMutation({
    mutationFn: (input: { routeId: string; expiresAt: string; reviewHash: string }) =>
      transport.approveCanvasDocRoute(documentId, input.routeId, {
        expiresAt: input.expiresAt,
        reviewHash: input.reviewHash,
      }),
    networkMode: 'always',
    onSuccess: settle,
  });
  const revoke = useMutation({
    mutationFn: (input: { routeId: string }) =>
      transport.revokeCanvasDocRoute(documentId, input.routeId),
    networkMode: 'always',
    onSuccess: settle,
  });
  return { approve, revoke };
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Whether the browser reports a connection, so changes can wait for one. */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  );
}
