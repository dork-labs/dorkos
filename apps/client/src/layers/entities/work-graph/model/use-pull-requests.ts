/**
 * The pull requests an agent, or a chat and the chats below it, opened,
 * claimed or worked on, a page at a time.
 *
 * @module entities/work-graph/model/use-pull-requests
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import type { WorkItem, WorkPage } from '@dorkos/shared/work-graph-reads';
import { useTransport } from '@/layers/shared/model';
import { WORK_GRAPH_STALE_MS } from './use-chat-tree';
import { workGraphKeys } from './work-graph-keys';

/** What a list of pull requests is drawn from. */
export interface PullRequestsQuery {
  /** Every item loaded so far, newest first. */
  items: WorkItem[];
  /** Still reading the first page. */
  isLoading: boolean;
  /** The first page could not be read. */
  isError: boolean;
  /** Another page waits. */
  hasMore: boolean;
  /** Reading the next page now. */
  isLoadingMore: boolean;
  /** Read the next page. */
  loadMore: () => void;
}

/** Fold an infinite query's pages into what a list draws. */
function toPullRequests(query: {
  data: { pages: WorkPage[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}): PullRequestsQuery {
  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

/**
 * The pull requests an agent's chats are linked to.
 *
 * @param agentId - The agent's registry id, or null to read nothing.
 */
export function useAgentPullRequests(agentId: string | null): PullRequestsQuery {
  const transport = useTransport();
  const query = useInfiniteQuery({
    queryKey: workGraphKeys.agentWork(agentId ?? '', 'pr'),
    queryFn: ({ pageParam }) =>
      transport.getAgentWork(agentId ?? '', {
        kind: 'pr',
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: WorkPage) => last.nextCursor ?? undefined,
    enabled: agentId !== null,
    staleTime: WORK_GRAPH_STALE_MS,
  });
  return toPullRequests(query);
}

/**
 * The pull requests a chat and the chats below it are linked to.
 *
 * @param chatId - The chat, or null to read nothing.
 */
export function useChatPullRequests(chatId: string | null): PullRequestsQuery {
  const transport = useTransport();
  const query = useInfiniteQuery({
    queryKey: workGraphKeys.chatWork(chatId ?? '', 'pr'),
    queryFn: ({ pageParam }) =>
      transport.getChatWork(chatId ?? '', {
        kind: 'pr',
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: WorkPage) => last.nextCursor ?? undefined,
    enabled: chatId !== null,
    staleTime: WORK_GRAPH_STALE_MS,
  });
  return toPullRequests(query);
}
