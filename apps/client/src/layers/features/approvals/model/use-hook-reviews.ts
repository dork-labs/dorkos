/** Read individual declined hook rows and request one fresh review at a time. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import { PENDING_APPROVALS_QUERY_KEY } from '@/layers/entities/attention';

export const DECLINED_HOOKS_QUERY_KEY = ['approvals', 'declined-hooks'] as const;

/** The person-only review history is separate from outstanding requests. */
export function useDeclinedHookApprovals(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: DECLINED_HOOKS_QUERY_KEY,
    queryFn: () => transport.listDeclinedHookApprovals(),
    enabled,
  });
}

/** A re-ask creates a pending card; it grants nothing and clears no refusal. */
export function useAskAgainHookApproval() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (approvalId: string) => transport.askAgainHookApproval(approvalId),
    meta: { suppressErrorToast: true },
    onError: () => toast.error('Couldn’t ask again. Try syncing this folder.'),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DECLINED_HOOKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
    },
  });
}
