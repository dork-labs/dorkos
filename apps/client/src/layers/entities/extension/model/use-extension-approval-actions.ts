/**
 * The two answers a person gives an extension waiting to be turned on, from the
 * Activity inbox: "Turn it on" and "Not now" (DOR-2517).
 *
 * @module entities/extension/model/use-extension-approval-actions
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ExtensionTrustOffer,
  PendingExtensionApproval,
} from '@dorkos/shared/extension-approval-schemas';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { extensionQueryKeys } from './use-pending-extension-approvals';
import { useTrustOfferStore } from './trust-offer-store';

/**
 * Which copy the person answered — the one their row showed — and the name to
 * use if it goes wrong. The server acts only if the copy on disk is still
 * exactly this one, and answers `409 stale_approval` otherwise.
 */
export interface ExtensionAnswerInput {
  /** Extension id. */
  id: string;
  /** Its name, for the failure toast. */
  name: string;
  /** The path the row showed. */
  path: string;
  /** The version the row showed. */
  version: string;
  /** The plugin the row showed, or `null` for a direct install. */
  plugin: string | null;
}

/** Which copy to turn on. */
export type ApproveExtensionInput = ExtensionAnswerInput;

/** Which copy to put off ("Not now"). */
export type DismissExtensionInput = ExtensionAnswerInput;

/** A failed request's own sentence, or the status when it sent none. */
async function failureOf(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return new Error(body.message ?? body.error ?? `The server answered ${res.status}`);
}

/**
 * Take one extension out of the cached queue at once, so the row leaves the
 * moment the person answers, and hand back how to put it back.
 */
function removeOptimistically(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string
): () => void {
  const key = extensionQueryKeys.pendingApprovals();
  const previous = queryClient.getQueryData<PendingExtensionApproval[]>(key);
  if (previous) {
    queryClient.setQueryData<PendingExtensionApproval[]>(
      key,
      previous.filter((approval) => approval.id !== id)
    );
  }
  return () => {
    if (previous) queryClient.setQueryData(key, previous);
  };
}

/** What {@link useExtensionApprovalActions} hands its caller. */
export interface ExtensionApprovalActions {
  /** Turn the extension on: the same person-only approval Settings uses. */
  approve: (input: ApproveExtensionInput) => void;
  /** "Not now": nothing is removed or turned off; the inbox stops asking about this copy. */
  dismiss: (input: DismissExtensionInput) => void;
  /** The id whose answer is in flight, and which answer, or `null`. */
  pending: { id: string; action: 'approve' | 'dismiss' } | null;
}

/**
 * Turn an extension on, or say "Not now", from the inbox.
 *
 * Both remove the row at once and put it back, with a toast in plain words, if
 * the server refuses. Both refresh everything under `['extensions']` when they
 * settle, so Settings → Extensions agrees without a reload.
 *
 * The server's person bar is the guarantee that only a person can do either;
 * this hook is only the app's way of asking.
 */
export function useExtensionApprovalActions(): ExtensionApprovalActions {
  const queryClient = useQueryClient();

  const approve = useMutation<void, Error, ApproveExtensionInput, () => void>({
    mutationFn: async ({ id, path, version, plugin }) => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, version, plugin }),
      });
      if (!res.ok) throw await failureOf(res);
      // The one-time "Next time, trust everything from <source>?" (spec
      // `flow-multiproject` §9.3): only this window heard it, so only this
      // window shows it, under the history row the answer leaves.
      const body = (await res.json().catch(() => ({}))) as { trustOffer?: ExtensionTrustOffer };
      if (body.trustOffer?.source) {
        useTrustOfferStore.getState().offer(id, body.trustOffer.source);
      }
    },
    onMutate: ({ id }) => removeOptimistically(queryClient, id),
    onError: (err, { name }, restore) => {
      restore?.();
      toast.error(`Couldn’t turn on ${name}. Try again.`, { description: err.message });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: extensionQueryKeys.all });
    },
    // The toast above names the extension; the shared one could not.
    meta: { suppressErrorToast: true },
  });

  const dismiss = useMutation<void, Error, DismissExtensionInput, () => void>({
    mutationFn: async ({ id, path, version, plugin }) => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions/${id}/dismiss-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, version, plugin }),
      });
      if (!res.ok) throw await failureOf(res);
    },
    onMutate: ({ id }) => removeOptimistically(queryClient, id),
    onError: (err, { name }, restore) => {
      restore?.();
      toast.error(`Couldn’t put ${name} off for now. Try again.`, { description: err.message });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: extensionQueryKeys.all });
    },
    meta: { suppressErrorToast: true },
  });

  const pending = approve.isPending
    ? { id: approve.variables.id, action: 'approve' as const }
    : dismiss.isPending
      ? { id: dismiss.variables.id, action: 'dismiss' as const }
      : null;

  return {
    approve: (input) => approve.mutate(input),
    dismiss: (input) => dismiss.mutate(input),
    pending,
  };
}
