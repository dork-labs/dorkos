import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  DocCommentAnchor,
  DocCommentThread,
  DocCommentThreadList,
  DocRef,
} from '@dorkos/shared/doc-comments';
import { useTransport } from '@/layers/shared/model';
import { docCommentKeys } from './doc-comment-keys';

/** Put one thread into a doc's cached list, replacing it when it is there. */
function keepThread(queryClient: QueryClient, doc: DocRef, thread: DocCommentThread): void {
  queryClient.setQueryData<DocCommentThreadList>(docCommentKeys.threads(doc), (current) => {
    const threads = current?.threads ?? [];
    const at = threads.findIndex((candidate) => candidate.id === thread.id);
    if (at === -1) return { threads: [...threads, thread] };
    return { threads: threads.map((candidate, i) => (i === at ? thread : candidate)) };
  });
}

/** One new thread: where it sits and its first comment. */
export interface CreateDocCommentThreadInput {
  /** The editor's anchor for the selection. */
  anchor: DocCommentAnchor;
  /** The first comment. */
  body: string;
}

/**
 * Open a thread on some words of a doc.
 *
 * @param doc - The doc.
 * @returns The TanStack mutation; its result names any mentioned agent that was not woken.
 */
export function useCreateDocCommentThread(doc: DocRef) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDocCommentThreadInput) =>
      transport.createDocCommentThread({ ...doc, ...input }),
    onSuccess: (result) => keepThread(queryClient, doc, result.thread),
  });
}

/**
 * Reply in a thread.
 *
 * @param doc - The doc.
 * @returns The TanStack mutation; its result names any mentioned agent that was not woken.
 */
export function useReplyDocComment(doc: DocRef) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
      transport.replyDocComment(threadId, { ...doc, body }),
    onSuccess: (result) => keepThread(queryClient, doc, result.thread),
  });
}

/**
 * Mark a thread done, or open it again.
 *
 * @param doc - The doc.
 * @returns The TanStack mutation.
 */
export function useSetDocCommentThreadResolved(doc: DocRef) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
      transport.setDocCommentThreadResolved(threadId, { ...doc, resolved }),
    onSuccess: (result) => keepThread(queryClient, doc, result.thread),
  });
}

/**
 * Change your own comment.
 *
 * @param doc - The doc.
 * @returns The TanStack mutation.
 */
export function useEditDocComment(doc: DocRef) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      threadId,
      commentId,
      body,
    }: {
      threadId: string;
      commentId: string;
      body: string;
    }) => transport.editDocComment(threadId, commentId, { ...doc, body }),
    onSuccess: (result) => keepThread(queryClient, doc, result.thread),
  });
}

/**
 * Save the anchors the editor moved. The cached threads take the new anchors
 * at once, so the editor is never handed back an anchor it already replaced.
 *
 * @param doc - The doc.
 * @returns The TanStack mutation.
 */
export function useUpdateDocCommentAnchors(doc: DocRef) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updates: Array<{ id: string; anchor: DocCommentAnchor }>) =>
      transport.updateDocCommentAnchors({ ...doc, updates }),
    onMutate: (updates) => {
      const moved = new Map(updates.map(({ id, anchor }) => [id, anchor]));
      queryClient.setQueryData<DocCommentThreadList>(docCommentKeys.threads(doc), (current) =>
        current
          ? {
              threads: current.threads.map((thread) =>
                moved.has(thread.id) ? { ...thread, anchor: moved.get(thread.id)! } : thread
              ),
            }
          : current
      );
    },
  });
}
