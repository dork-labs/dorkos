import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import { PENDING_APPROVALS_QUERY_KEY } from '@/layers/entities/attention';
import { describeDecisionRefusal } from '../lib/decision-refusal';
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
 *
 * ## Why this opts out of the app-wide error toast
 *
 * `query-client.ts` answers every failed mutation with "Action failed. Please try
 * again." For this one that is not a missed opportunity, it is wrong: the server
 * distinguishes between "nothing happened" and "the irreversible action ran but the
 * permission did not get recorded", and the second one arrives as a 500. Reporting
 * that as a failure invites somebody to do an irreversible thing twice. So the
 * generic toast is suppressed and {@link describeDecisionRefusal} decides both the
 * sentence and how loudly it reads.
 */
export function useGrantApproval() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { approvalId: string; standing?: boolean }) =>
      transport.grantApproval(opts.approvalId, opts.standing ? { standing: true } : undefined),
    meta: { suppressErrorToast: true },
    onError: (error, variables) => {
      const refusal = describeDecisionRefusal(error, variables.standing === true);
      if (refusal.tone === 'warning') toast.warning(refusal.message);
      else toast.error(refusal.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
      // A standing answer adds a row to the list both discovery surfaces read, so
      // it has to land there without waiting for the event to come back round.
      void queryClient.invalidateQueries({ queryKey: STANDING_PERMISSIONS_QUERY_KEY });
    },
  });
}

/**
 * Refuse a pending approval, with an optional reason the requester sees.
 *
 * Carries the same refusal copy as its sibling, for the same reason. A "no" that
 * silently did not land is the failure that matters most here: the person believes
 * they stopped something, and the request is still sitting there answerable.
 */
export function useDenyApproval() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { approvalId: string; reason?: string }) =>
      transport.denyApproval(opts.approvalId, opts.reason),
    meta: { suppressErrorToast: true },
    onError: (error) => {
      toast.error(describeDecisionRefusal(error, false).message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
    },
  });
}
