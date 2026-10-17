import { useQuery } from '@tanstack/react-query';
import type { DocRef } from '@dorkos/shared/doc-comments';
import { useTransport } from '@/layers/shared/model';
import { docCommentKeys } from './doc-comment-keys';

/** How often a doc's threads re-read, so an agent's reply shows up without a reload. */
const REFRESH_MS = 15_000;

/** How long the mention roster stays fresh: agents come and go rarely. */
const ROSTER_STALE_MS = 5 * 60_000;

/**
 * Every comment thread on a doc, resolved ones included, oldest first.
 *
 * @param doc - The doc, or `null` when there is none to read.
 * @returns The TanStack Query result for `GET /api/documents/comments`.
 */
export function useDocCommentThreads(doc: DocRef | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: doc ? docCommentKeys.threads(doc) : [...docCommentKeys.all, 'threads', 'none'],
    queryFn: () => transport.listDocCommentThreads(doc!),
    select: (data) => data.threads,
    enabled: doc !== null,
    refetchInterval: REFRESH_MS,
  });
}

/**
 * Everybody a comment can `@`-mention: every agent, then the owner once they
 * have a handle.
 *
 * @param options - `enabled: false` holds the read until a composer opens.
 * @returns The TanStack Query result for `GET /api/documents/comments/mentionable`.
 */
export function useDocCommentMentionable(options: { enabled?: boolean } = {}) {
  const transport = useTransport();
  return useQuery({
    queryKey: docCommentKeys.mentionable(),
    queryFn: () => transport.listDocCommentMentionable(),
    select: (data) => data.people,
    staleTime: ROSTER_STALE_MS,
    enabled: options.enabled ?? true,
  });
}
