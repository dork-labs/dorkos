import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PendingApprovalSchema, type PendingApproval } from '@dorkos/shared/approval-schemas';
import { useEventSubscription, useTransport } from '@/layers/shared/model';

/** Query key for the pending-approval list. */
export const PENDING_APPROVALS_QUERY_KEY = ['approvals', 'pending'] as const;

/** What {@link usePendingApprovals} hands its consumers. */
export interface PendingApprovalsState {
  /** Approvals waiting on a person, oldest first. */
  approvals: PendingApproval[];
  /** True only on the very first load, before any answer has arrived. */
  isLoading: boolean;
}

/**
 * Approvals waiting on a person, kept live.
 *
 * The list is fetched on mount and then kept in step by the global event stream:
 * `approval_pending` adds a card the moment an agent asks, and
 * `approval_resolved` retires one as soon as anybody decides — including from
 * another window. The `/api/events` stream has no replay, so the fetch is what
 * makes a freshly opened cockpit correct and the events are what keep it that way.
 */
export function usePendingApprovals(): PendingApprovalsState {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: PENDING_APPROVALS_QUERY_KEY,
    queryFn: () => transport.listPendingApprovals(),
  });

  useEventSubscription('approval_pending', (raw) => {
    const parsed = PendingApprovalSchema.safeParse(raw);
    if (!parsed.success) return;
    queryClient.setQueryData<{ approvals: PendingApproval[] }>(
      PENDING_APPROVALS_QUERY_KEY,
      (current) => {
        const approvals = current?.approvals ?? [];
        // The same approval can arrive twice if a refetch races the event.
        if (approvals.some((a) => a.approvalId === parsed.data.approvalId)) return current;
        return { approvals: [...approvals, parsed.data] };
      }
    );
  });

  useEventSubscription('approval_resolved', () => {
    // Every terminal outcome (granted, denied, spent, expired) removes a card, and
    // the server is the authority on what is still pending — so re-read rather
    // than replay the transition locally.
    void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
  });

  return { approvals: data?.approvals ?? [], isLoading };
}
