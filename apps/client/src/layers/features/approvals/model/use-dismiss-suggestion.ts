/**
 * "Not now" on the Always allow suggestion (spec `agent-permissions`, the
 * gentle suggestion). The server records it and stops suggesting for that
 * agent and action for good.
 *
 * ## The highlight goes the moment "Not now" is tapped, on every copy
 *
 * The same request can be on screen three times (the transcript, the Inbox,
 * home), and the transcript's copy is drawn from the stream event, which no
 * refetch updates. So the dismissal is remembered here, per approval, and every
 * card reads it: one tap quiets every copy at once, not just the one tapped. A
 * failed request takes the dismissal back, so the highlight is only gone when
 * the server agreed.
 *
 * @module features/approvals/model/use-dismiss-suggestion
 */
import { useSyncExternalStore } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTransport } from '@/layers/shared/model';
import { PENDING_APPROVALS_QUERY_KEY } from '@/layers/entities/attention';

/** The approvals whose suggestion a person dismissed in this window. */
const dismissed = new Set<string>();
const listeners = new Set<() => void>();

/** Tell every card the set changed. */
function notify(): void {
  for (const listener of listeners) listener();
}

/** Watch the set. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether "Not now" was tapped on this request's suggestion.
 *
 * @param approvalId - The request to ask about.
 */
export function useSuggestionDismissed(approvalId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dismissed.has(approvalId),
    () => false
  );
}

/**
 * Forget every dismissal. Test-only teardown.
 *
 * @internal Exported for testing only.
 */
export function discardDismissedSuggestions(): void {
  dismissed.clear();
  notify();
}

/**
 * Dismiss one card's Always allow suggestion.
 *
 * @returns The TanStack mutation, called with the approval id.
 */
export function useDismissSuggestion() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (approvalId: string) => transport.dismissAlwaysSuggestion(approvalId),
    meta: { suppressErrorToast: true },
    onMutate: (approvalId) => {
      dismissed.add(approvalId);
      notify();
    },
    onError: (error, approvalId) => {
      dismissed.delete(approvalId);
      notify();
      toast.error(
        error instanceof Error && error.message ? error.message : "That didn't save. Try again."
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
    },
  });
}
