import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { PENDING_APPROVALS_QUERY_KEY } from './use-pending-approvals';

/**
 * Allow a pending approval.
 *
 * The server broadcasts `approval_resolved`, which retires the card everywhere;
 * the local invalidation is the belt-and-braces path for a cockpit whose event
 * stream is momentarily down.
 */
export function useGrantApproval() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (approvalId: string) => transport.grantApproval(approvalId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
    },
  });
}

/** Refuse a pending approval, with an optional reason the requester sees. */
export function useDenyApproval() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { approvalId: string; reason?: string }) =>
      transport.denyApproval(opts.approvalId, opts.reason),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
    },
  });
}
