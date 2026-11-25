/**
 * The two answers a person gives an extension waiting to be turned on, from the
 * Activity inbox: "Turn it on" and "Not now" (DOR-2517).
 *
 * @module entities/extension/model/use-extension-approval-actions
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import { toast } from 'sonner';
import {
  type ApproveExtensionRequest,
  type ExtensionTrustOffer,
  type PendingExtensionApproval,
} from '@dorkos/shared/extension-approval-schemas';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { extensionQueryKeys } from './use-pending-extension-approvals';
import { useTrustOfferStore } from './trust-offer-store';
import { useSeenBeforeStaleStore } from './seen-before-stale-store';
import { useAllowNotConfirmedStore } from './allow-not-confirmed-store';
import { readResponseError } from '@/layers/shared/lib';

/** The code an answer to a copy that changed since the card was drawn is refused with. */
const CHANGED_SINCE_SHOWN = 'precondition_failed';

/** The code a yes to a copy DorkOS cannot check is refused with: asking again can't help. */
const CANNOT_TURN_ON = 'conflict';

/**
 * Which copy the person answered — the one their row showed — and the name to
 * use if it goes wrong. The server acts only if the copy on disk is still
 * exactly this one, and answers `412 precondition_failed` otherwise.
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

/**
 * Which copy to turn on, and the permission set the person was shown
 * (DOR-2686). The server refuses the yes as stale when the extension declares
 * anything else by the time it lands, so a widening between the card and the
 * click is never approved on a yes given to the old lists. Absent when the
 * card showed no set (a server one version behind), so nothing is compared.
 */
export interface ApproveExtensionInput extends ExtensionAnswerInput {
  /** The set the card showed. */
  permissions?: ApproveExtensionRequest['permissions'];
  /** The digest of the files the card showed; files changed since are refused as stale. */
  expectedDigest?: string;
  /** The app already runs and this allows only its new places (DOR-4282): the toast says so. */
  placesOnly?: boolean;
}

/** Which copy to put off ("Not now"). */
export type DismissExtensionInput = ExtensionAnswerInput;

/** A refused request: its own sentence, and its code when it sent one. */
class AnswerRefused extends Error {
  constructor(
    message: string,
    /** The server's refusal code, e.g. `step_up_required`. */
    readonly code: string | undefined
  ) {
    super(message);
  }
}

/** A failed request's own sentence, or the status when it sent none. */
async function failureOf(res: Response): Promise<AnswerRefused> {
  const body = await readResponseError(res, `The server answered ${res.status}`);
  return new AnswerRefused(body.message, body.code);
}

/** Whether a refusal says the row went out of date while it was on screen. */
function isStale(err: Error): boolean {
  return err instanceof AnswerRefused && err.code === CHANGED_SINCE_SHOWN;
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
  /**
   * Turn the extension on: the same person-only approval Settings uses.
   * `onDone` runs only once the server said yes to this very call, and
   * `onFail` once it did not (the toast is already shown). A refusal for
   * "Confirm it's you" waits for a fresh list first: when that no longer
   * lists the copy, the yes went through elsewhere and `onDone` runs;
   * otherwise the sheet closed unconfirmed, and `useAllowNotConfirmed` says
   * so for that extension until it is answered again (DOR-4909).
   */
  approve: (input: ApproveExtensionInput, onDone?: () => void, onFail?: () => void) => void;
  /**
   * "Not now": nothing is removed or turned off; the inbox stops asking about
   * this copy. `onDone` runs only once the server recorded this very call,
   * and `onFail` once it did not.
   */
  dismiss: (input: DismissExtensionInput, onDone?: () => void, onFail?: () => void) => void;
  /** The id whose answer is in flight, and which answer, or `null`. */
  pending: { id: string; action: 'approve' | 'dismiss' } | null;
}

/**
 * Turn an extension on, or say "Not now", from the inbox.
 *
 * Approval keeps its row while the password confirmation waits. Dismissal
 * removes it at once and restores it if refused. Both refresh `['extensions']` when they
 * settle, so Settings → Extensions agrees without a reload.
 *
 * The server's person bar is the guarantee that only a person can do either;
 * this hook is only the app's way of asking.
 */
export function useExtensionApprovalActions(): ExtensionApprovalActions {
  const queryClient = useQueryClient();

  const approve = useMutation<void, Error, ApproveExtensionInput>({
    mutationFn: async ({ id, path, version, plugin, permissions, expectedDigest }) => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          version,
          plugin,
          ...(permissions ? { permissions } : {}),
          ...(expectedDigest ? { expectedDigest } : {}),
        }),
      });
      if (!res.ok) throw await failureOf(res);
      useSeenBeforeStaleStore.getState().forget(id);
      // A yes that landed ends any "Nothing was allowed" line, even one an
      // earlier, slower call left after this one began (DOR-4909).
      useAllowNotConfirmedStore.getState().forget(id);
      // The one-time "Next time, trust everything from <source>?" (spec
      // `flow-multiproject` §9.3): only this window heard it, so only this
      // window shows it, under the history row the answer leaves.
      const body = (await res.json().catch(() => ({}))) as { trustOffer?: ExtensionTrustOffer };
      if (body.trustOffer?.source) {
        useTrustOfferStore.getState().offer(id, body.trustOffer.source);
      }
    },
    onError: (err, { id, name, permissions, placesOnly }) => {
      if (err instanceof AnswerRefused && err.code === STEP_UP_REQUIRED_CODE) return;
      // It changed while the card was on screen: nothing was turned on, and
      // the refresh below redraws the row with what it asks for now, leading
      // with what the card the person saw did not list.
      if (isStale(err)) {
        if (permissions) useSeenBeforeStaleStore.getState().remember(id, permissions);
        toast.error(`${name} changed since you saw it. Check it again.`);
        return;
      }
      // Trying again cannot help a copy DorkOS cannot check (DOR-3068).
      if (err instanceof AnswerRefused && err.code === CANNOT_TURN_ON) {
        toast.error(`${name} can’t be turned on yet.`, { description: err.message });
        return;
      }
      toast.error(
        placesOnly
          ? `Couldn’t allow ${name}’s new places.`
          : `Couldn’t turn on ${name}. Try again.`,
        { description: err.message }
      );
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

  /**
   * After a yes that ended on "Confirm it's you" without one here: whether a
   * fresh list says the copy no longer waits (confirmed elsewhere). Until it
   * answers, the caller's row stays as it was answered.
   */
  const settledElsewhere = async (err: unknown, id: string): Promise<boolean> => {
    if (!(err instanceof AnswerRefused) || err.code !== STEP_UP_REQUIRED_CODE) return false;
    const key = extensionQueryKeys.pendingApprovals();
    await queryClient.refetchQueries({ queryKey: key }).catch(() => undefined);
    const listed = queryClient.getQueryData<PendingExtensionApproval[]>(key);
    return listed !== undefined && !listed.some((approval) => approval.id === id);
  };

  const notConfirmed = useAllowNotConfirmedStore.getState;

  return {
    // Per call, so a second answer given before the first settles never
    // swallows the first one's `onDone`. A refusal is already reported by
    // `onError` above, so the rejected promise only tells `onFail`.
    approve: (input, onDone, onFail) => {
      // A new answer replaces whatever the last one left on the card.
      notConfirmed().forget(input.id);
      void approve.mutateAsync(input).then(onDone, async (err: unknown) => {
        if (await settledElsewhere(err, input.id)) {
          onDone?.();
          return;
        }
        // "Confirm it's you" closed without confirming: nothing was allowed,
        // and the card says so rather than staying as it was (DOR-4909).
        if (err instanceof AnswerRefused && err.code === STEP_UP_REQUIRED_CODE) {
          notConfirmed().remember(input.id, input.version);
        }
        onFail?.();
      });
    },
    dismiss: (input, onDone, onFail) => {
      notConfirmed().forget(input.id);
      void dismiss.mutateAsync(input).then(onDone, () => onFail?.());
    },
    pending,
  };
}
