import { useEffect } from 'react';
import { useFeedbackDialogStore } from '@/layers/shared/model';
import { takePendingFeedback } from '@/layers/shared/lib';
import { FeedbackDialog } from '@/layers/features/feedback';
import { useCurrentUser } from '@/layers/features/auth';

/**
 * The single mounted instance of the cockpit feedback dialog.
 *
 * The dialog is opened from many places that are not in its own React tree — the
 * help menu, the command palette, the query-error toast — so its open state
 * lives in a shared store (`useFeedbackDialogStore`) and this host renders the
 * one dialog from it. Living in the widget layer lets it bridge two features the
 * dialog's own layer must not import from each other: the auth feature (for the
 * "Sending as…" identity line — display only; the server is the authority) and
 * the feedback feature (the dialog itself).
 *
 * It also completes the app-crash handoff: the crash boundary renders after this
 * host has unmounted, so it stashes its prefill to `sessionStorage` and reloads;
 * on the next boot this host picks that up and opens the dialog.
 */
export function FeedbackDialogHost() {
  const open = useFeedbackDialogStore((s) => s.open);
  const prefill = useFeedbackDialogStore((s) => s.prefill);
  const openFeedback = useFeedbackDialogStore((s) => s.openFeedback);
  const setOpen = useFeedbackDialogStore((s) => s.setOpen);
  const currentUser = useCurrentUser();

  // Pick up a crash report handed off across a reload (one-shot; see
  // `takePendingFeedback`). Runs once on mount.
  useEffect(() => {
    const pending = takePendingFeedback();
    if (pending) openFeedback(pending);
  }, [openFeedback]);

  return (
    <FeedbackDialog
      open={open}
      onOpenChange={setOpen}
      initialKind={prefill.kind}
      prefillMessage={prefill.message}
      crashStack={prefill.crashStack}
      currentUser={currentUser ? { email: currentUser.email, name: currentUser.name } : null}
    />
  );
}
