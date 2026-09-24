import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ApprovalAnswer } from '@dorkos/shared/approval-schemas';
import { useTransport } from '@/layers/shared/model';
import { PENDING_APPROVALS_QUERY_KEY } from '@/layers/entities/attention';
import { permissionKeys } from '@/layers/entities/permissions';
import { describeDecisionRefusal } from '@/layers/shared/lib';

/**
 * Allow a pending approval: once, or always for this agent and this action
 * (spec `agent-permissions` D7).
 *
 * The server broadcasts `approval_resolved`, which retires the card everywhere;
 * the local invalidation is the belt-and-braces path for a cockpit whose event
 * stream is momentarily down.
 *
 * `answer: 'always'` is refused outright when the request does not offer it,
 * and the one-time yes is refused with it. That refusal reaches the caller as a
 * rejected mutation, so nothing here has to guess which half happened.
 *
 * ## Why this opts out of the app-wide error toast
 *
 * `query-client.ts` answers every failed mutation with "Action failed. Please try
 * again." The server's own sentence is more useful ("This approval was already
 * decided"), so the generic toast is suppressed and
 * {@link describeDecisionRefusal} picks the sentence.
 */
export function useGrantApproval() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { approvalId: string; answer?: ApprovalAnswer }) =>
      transport.grantApproval(
        opts.approvalId,
        opts.answer === 'always' ? { answer: 'always' } : undefined
      ),
    meta: { suppressErrorToast: true },
    onError: (error, variables) => {
      toast.error(describeDecisionRefusal(error, variables.answer === 'always').message);
    },
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
      // An Always allow changed the agent's permissions, which the permissions
      // pages read.
      if (variables.answer === 'always') {
        void queryClient.invalidateQueries({ queryKey: permissionKeys.all });
      }
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
