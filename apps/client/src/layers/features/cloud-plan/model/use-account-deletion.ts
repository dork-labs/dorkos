/**
 * Ask for the DorkOS account to be deleted, then notice when it has been.
 *
 * Asking deletes nothing. The service emails the account a link, and the
 * account goes only when the person follows it in their own browser, which
 * this app cannot see. So while a link is out and still works, this asks the
 * account whether it still accepts this computer whenever the window comes
 * back into focus (the person returning from their email) and once a minute
 * besides. The answer that it no longer does is the deletion landing: this
 * computer is unlinked, the account's figures are dropped, and the person is
 * told what stayed. Once the link's deadline passes, the watch stops and the
 * person is told to ask for a new one.
 *
 * The link that went out and the latest attempt are kept apart on purpose: a
 * new link that could not be sent must not hide the one that already did.
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

/** The largest delay a browser timer holds; a deadline further out is never reached by one. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The latest attempt to send a link. */
export type AccountDeletionAttempt =
  { kind: 'idle' } | { kind: 'requesting' } | { kind: 'failed'; notice: BillingNotice };

/** What the delete control needs. */
export interface AccountDeletionControl {
  /** The last link that went out, or `null` while none has. Kept through a failed resend. */
  sent: CloudAccountDeletion | null;
  /** Whether that link's deadline has passed, so it no longer works. */
  expired: boolean;
  /** The latest attempt to send a link. */
  attempt: AccountDeletionAttempt;
  /**
   * Ask for a confirmation link (again). Resolves with whether one went out;
   * a call while one is in flight resolves `false` and sends nothing.
   */
  request: () => Promise<boolean>;
  /** Forget a failed attempt, so the next one starts clean. */
  reset: () => void;
}

/**
 * Ask for the account to be deleted, and say honestly where that stands. While
 * a link is out and still works, watch for the account to stop accepting this
 * computer.
 */
export function useAccountDeletion(): AccountDeletionControl {
  const transport = useTransport();
  const [sent, setSent] = useState<CloudAccountDeletion | null>(null);
  const [attempt, setAttempt] = useState<AccountDeletionAttempt>({ kind: 'idle' });
  // The link whose deadline passed. Compared by identity, so a new link is
  // never read as expired because an earlier one was.
  const [expiredLink, setExpiredLink] = useState<CloudAccountDeletion | null>(null);
  const busy = useRef(false);

  const request = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setAttempt({ kind: 'requesting' });
    try {
      const answer = await transport.requestCloudAccountDeletion();
      if (answer.ok) {
        setSent(answer.deletion);
        setAttempt({ kind: 'idle' });
        return true;
      }
      setAttempt({
        kind: 'failed',
        notice: 'problem' in answer ? { problem: answer.problem } : { message: answer.message },
      });
      return false;
    } catch {
      setAttempt({ kind: 'failed', notice: BILLING_UNREACHABLE });
      return false;
    } finally {
      busy.current = false;
    }
  }, [transport]);

  const reset = useCallback(() => {
    if (!busy.current) setAttempt({ kind: 'idle' });
  }, []);

  // Mark the link expired at its deadline. A deadline already past fires at once.
  useEffect(() => {
    if (sent === null || sent.confirmBy === null) return;
    const left = Date.parse(sent.confirmBy) - Date.now();
    if (Number.isNaN(left) || left > MAX_TIMER_MS) return;
    const timer = setTimeout(() => setExpiredLink(sent), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [sent]);

  const expired = sent !== null && expiredLink === sent;
  useWatchForDeletion(sent !== null && !expired);

  return { sent, expired, attempt, request, reset };
}

/**
 * While `armed`, ask whether the account still accepts this computer on every
 * return to the window and once a minute. When it does not, settle every
 * account read and say so once.
 *
 * @param armed - Whether a working deletion link is out.
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
      let summary: Awaited<ReturnType<typeof checkLink>> = null;
      try {
        summary = await checkLink({ expected: true });
      } catch {
        // A refresh after the check failed; the next focus or minute asks again.
      } finally {
        checking = false;
      }
      if (done || summary === null || summary.linked) return;
      done = true;
      stop();
      // The account's own reads now answer "not linked"; refetch them so the
      // tab shows the signed-out view rather than figures for an account that
      // is gone.
      void queryClient.invalidateQueries({ queryKey: cloudPlanKeys.all });
      toast.success('This computer is unlinked', {
        description: 'The deletion is confirmed. Everything on this computer stays.',
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
