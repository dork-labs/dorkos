/**
 * Paged reads of the audit log, as activity rows.
 *
 * Lives in the entity rather than a feature because two features draw it: the
 * Activity page's "All actions" view and an agent's profile timeline.
 *
 * @module entities/activity/model/use-audit-feed
 */
import { skipToken, useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { AuditQuery, AuditQueryResult } from '@dorkos/shared/audit-schemas';
import { useTransport } from '@/layers/shared/model';
import { auditEventToRow } from '../lib/audit-rows';
import type { ActivityRowItem } from './activity-types';

/** Stable query key root for every audit log read. */
export const AUDIT_QUERY_KEY = ['audit'] as const;

/** How many events one page asks for. */
const PAGE_SIZE = 50;

/** Every loaded page, flattened into rows, newest first. */
function selectRows(data: InfiniteData<AuditQueryResult, number | undefined>): ActivityRowItem[] {
  return data.pages.flatMap((page) => page.events.map(auditEventToRow));
}

/**
 * Every action the caller may see, newest first, 50 at a time.
 *
 * @param filters - Optional filters forwarded to `GET /api/audit`.
 */
export function useAuditFeed(filters: Partial<Omit<AuditQuery, 'beforeSeq' | 'limit'>> = {}) {
  const transport = useTransport();

  return useInfiniteQuery({
    queryKey: [...AUDIT_QUERY_KEY, 'list', filters],
    queryFn: ({ pageParam }) =>
      transport.listAuditEvents({ ...filters, limit: PAGE_SIZE, beforeSeq: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBeforeSeq,
    select: selectRows,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Everything one account did, had done to it, or had done on its behalf.
 *
 * @param accountId - The account; for an agent, its id. `null` reads nothing.
 */
export function useAccountTimeline(accountId: string | null) {
  const transport = useTransport();

  return useInfiniteQuery({
    queryKey: [...AUDIT_QUERY_KEY, 'timeline', accountId],
    queryFn:
      accountId === null
        ? skipToken
        : ({ pageParam }) =>
            transport.getAccountTimeline(accountId, { limit: PAGE_SIZE, beforeSeq: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBeforeSeq,
    select: selectRows,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
