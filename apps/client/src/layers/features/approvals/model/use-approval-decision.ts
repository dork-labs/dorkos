import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { PENDING_APPROVALS_QUERY_KEY } from './use-pending-approvals';
import { STANDING_PERMISSIONS_QUERY_KEY } from './use-standing-permissions';

/**
 * Allow a pending approval, optionally opening a standing permission with it.
 *
 * The server broadcasts `approval_resolved`, which retires the card everywhere;
 * the local invalidation is the belt-and-braces path for a cockpit whose event
 * stream is momentarily down.
 *
 * `standing: true` is refused outright when it cannot be honored — the setting is
 * off, login is off, or the request carries no agent path — and the one-time yes
 * is refused with it. That refusal reaches the caller as a rejected mutation, so
 * nothing here has to guess which half happened.
 */
export function useGrantApproval() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { approvalId: string; standing?: boolean }) =>
      transport.grantApproval(opts.approvalId, opts.standing ? { standing: true } : undefined),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
      // A standing answer adds a row to the list both discovery surfaces read, so
      // it has to land there without waiting for the event to come back round.
      void queryClient.invalidateQueries({ queryKey: STANDING_PERMISSIONS_QUERY_KEY });
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
