/**
 * Ask for the DorkOS account to be deleted, then notice when it has been.
 *
 * Asking deletes nothing. The service emails the account a link, and the
 * account goes only when the person follows it in their own browser, which
 * this app cannot see. So while a link is out, this asks the account whether
 * it still accepts this computer whenever the window comes back into focus
 * (the person returning from their email) and once a minute besides. The
 * answer that it no longer does is the deletion landing: this computer is
 * unlinked, the account's figures are dropped, and the person is told what
 * stayed.
 *
 * @module features/cloud-plan/model/use-account-deletion
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CloudAccountDeletion } from '@dorkos/shared/cloud-schemas';
import { useCheckCloudLink } from '@/layers/features/cloud-link';
import { useTransport } from '@/layers/shared/model';
import { BILLING_UNREACHABLE, type BillingNotice } from './use-billing-page';
import { cloudPlanKeys } from './use-cloud-plan';

/** How often to ask whether the account still accepts this computer while a link is out. */
export const DELETION_CHECK_INTERVAL_MS = 60_000;

/** Where a request to delete the account stands in this view. */
export type AccountDeletionState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'sent'; deletion: CloudAccountDeletion }
  | { kind: 'failed'; notice: BillingNotice };

/** What the delete control needs. */
export interface AccountDeletionControl {
  state: AccountDeletionState;
  /**
   * Ask for the confirmation link (again). Resolves with where the request
   * ended up; a call while one is in flight resolves with `requesting` and
   * sends nothing.
   */
  request: () => Promise<AccountDeletionState>;
  /** Forget a refusal, so the next attempt starts clean. */
  reset: () => void;
}

/**
 * Ask for the account to be deleted, and say honestly where that stands: the
 * link is on its way, or why it could not be sent. While a link is out, watch
 * for the account to stop accepting this computer.
 */
export function useAccountDeletion(): AccountDeletionControl {
  const transport = useTransport();
  const [state, setState] = useState<AccountDeletionState>({ kind: 'idle' });
  const busy = useRef(false);

  const request = useCallback(async (): Promise<AccountDeletionState> => {
    if (busy.current) return { kind: 'requesting' };
    busy.current = true;
    setState({ kind: 'requesting' });
    let next: AccountDeletionState;
    try {
      const answer = await transport.requestCloudAccountDeletion();
      next = answer.ok
        ? { kind: 'sent', deletion: answer.deletion }
        : {
            kind: 'failed',
            notice: 'problem' in answer ? { problem: answer.problem } : { message: answer.message },
          };
    } catch {
      next = { kind: 'failed', notice: BILLING_UNREACHABLE };
    }
    busy.current = false;
    setState(next);
    return next;
  }, [transport]);

  const reset = useCallback(() => {
    if (!busy.current) setState({ kind: 'idle' });
  }, []);

  useWatchForDeletion(state.kind === 'sent');

  return { state, request, reset };
}

/**
 * While `armed`, ask whether the account still accepts this computer on every
 * return to the window and once a minute. When it does not, settle every
 * account read and say so once.
 *
 * @param armed - Whether a deletion link is out.
 */
function useWatchForDeletion(armed: boolean): void {
  const queryClient = useQueryClient();
  const checkLink = useCheckCloudLink();

  useEffect(() => {
    if (!armed) return;
    let done = false;
    let checking = false;
    const check = async () => {
      if (done || checking) return;
      checking = true;
      const summary = await checkLink({ expected: true });
      checking = false;
      if (done || summary === null || summary.linked) return;
      done = true;
      stop();
      // The account's own reads now answer "not linked"; refetch them so the
      // tab shows the signed-out view rather than figures for an account that
      // is gone.
      void queryClient.invalidateQueries({ queryKey: cloudPlanKeys.all });
      toast.success('This computer is unlinked', {
        description:
          'Your DorkOS account no longer accepts it, which is what happens once a deletion is confirmed. Everything on this computer stays.',
      });
    };
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => void check(), DELETION_CHECK_INTERVAL_MS);
    function stop() {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    }
    return () => {
      done = true;
      stop();
    };
  }, [armed, checkLink, queryClient]);
}
