/**
 * A chat's tree of chats that started each other, a page at a time.
 *
 * @module entities/work-graph/model/use-chat-tree
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ChatTree } from '@dorkos/shared/work-graph-reads';
import { useTransport } from '@/layers/shared/model';
import { workGraphKeys } from './work-graph-keys';

/** How long a tree is fresh: chats start chats while you watch, so not long. */
export const WORK_GRAPH_STALE_MS = 30_000;

/**
 * The chats below `chatId`, depth first, every page loaded so far. The
 * chats above it repeat on every page; read them from the first.
 *
 * @param chatId - The chat at the top, or null to read nothing.
 * @param enabled - Read only while something shows the tree, such as an open fold.
 */
export function useChatTree(chatId: string | null, enabled = true) {
  const transport = useTransport();
  return useInfiniteQuery({
    queryKey: workGraphKeys.tree(chatId ?? ''),
    queryFn: ({ pageParam }) =>
      transport.getChatTree(chatId ?? '', pageParam === null ? {} : { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ChatTree) => last.nextCursor ?? undefined,
    enabled: enabled && chatId !== null,
    staleTime: WORK_GRAPH_STALE_MS,
  });
}
