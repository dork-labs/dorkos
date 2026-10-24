/**
 * Server state for one document's unfinished work: the list a person reviews,
 * and the two things they can do with one piece of it.
 *
 * @module features/canvas/model/use-canvas-doc-work
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CanvasDocWork } from '@dorkos/shared/canvas-doc-routes';
import { useTransport } from '@/layers/shared/model';

/** The cache key for one document's unfinished work. */
export const canvasDocWorkKey = (documentId: string) => ['canvas-doc-work', documentId] as const;

/**
 * Work on a document that expired or ended in doubt.
 *
 * Read only for a document that declares routes, since no other document can
 * have any. Polls like the route list: quickly while open, slowly while closed,
 * so work that expires while the document is open still shows. No retry: a
 * refusal leaves the header as it was.
 *
 * @param documentId - The document.
 * @param enabled - Whether the document declares routes.
 * @param open - Whether the review is open.
 */
export function useCanvasDocWork(documentId: string, enabled: boolean, open: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: canvasDocWorkKey(documentId),
    queryFn: () => transport.getCanvasDocWork(documentId),
    enabled,
    retry: false,
    // This server is local; `online` would pause the read whenever the computer
    // reports no internet, which says nothing about reaching DorkOS.
    networkMode: 'always',
    staleTime: 5_000,
    refetchInterval: open ? 15_000 : 60_000,
  });
}

/**
 * Run one piece of work again, or clear it. A success drops that work from the
 * cached list; success or refusal, the list is then read again.
 *
 * @param documentId - The document.
 */
export function useCanvasDocWorkActions(documentId: string) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const settle = (change: { batchId: string }) =>
    queryClient.setQueryData<CanvasDocWork>(canvasDocWorkKey(documentId), (old) =>
      old ? { ...old, items: old.items.filter((item) => item.batchId !== change.batchId) } : old
    );
  // Read the list again either way: a refusal usually means it is out of date.
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: canvasDocWorkKey(documentId) });
  const replay = useMutation({
    mutationFn: (input: { batchId: string; confirmRepeat?: true }) =>
      transport.replayCanvasDocWork(
        documentId,
        input.batchId,
        input.confirmRepeat ? { confirmRepeat: true } : {}
      ),
    networkMode: 'always',
    onSuccess: settle,
    onSettled: refresh,
  });
  const clear = useMutation({
    mutationFn: (input: { batchId: string }) =>
      transport.clearCanvasDocWork(documentId, input.batchId),
    networkMode: 'always',
    onSuccess: settle,
    onSettled: refresh,
  });
  return { replay, clear };
}
