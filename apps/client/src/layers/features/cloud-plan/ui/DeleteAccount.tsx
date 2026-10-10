import { useRef, useState } from 'react';
import {
  Button,
  Input,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { useAccountDeletion } from '../model/use-account-deletion';
import { useCloudPlan } from '../model/use-cloud-plan';
import { BillingNoticeView } from './BillingNoticeView';
import { ExportAccountData } from './ExportAccountData';

/** The word a person types to confirm. Plain and short. */
export const DELETE_CONFIRM_WORD = 'delete';

/**
 * When a confirmation link stops working, in the person's own words for a time.
 *
 * @param iso - The timestamp the service sent.
 */
function formatConfirmBy(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date
  );
}

/**
 * "Delete your DorkOS account": what goes, what stays, a copy first, and a
 * typed word before the request is sent.
 *
 * Sending it deletes nothing. The service emails the account a link and the
 * account goes only when the person follows it, so the result this shows is
 * "check your email", never "deleted". Once the link is followed, the hook
 * behind this notices that the account no longer accepts this computer and
 * the tab returns to signed out. Past the link's deadline it says the link
 * expired and offers a new one.
 *
 * Self-contained: renders nothing with no cloud account.
 */
export function DeleteAccount() {
  const { data } = useCloudPlan();
  const { sent, expired, attempt, request, reset } = useAccountDeletion();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const confirmField = useRef<HTMLInputElement>(null);
  const note = useRef<HTMLParagraphElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  if (!data?.available) return null;

  const confirmed = typed.trim().toLowerCase() === DELETE_CONFIRM_WORD;
  const requesting = attempt.kind === 'requesting';
  const failed = attempt.kind === 'failed' ? attempt.notice : null;

  const onOpenChange = (next: boolean) => {
    if (requesting) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      reset();
    }
  };

  const send = () => {
    if (!confirmed || requesting) return;
    void request().then((wentOut) => {
      // A sent link closes the dialog; the note below says what happens next.
      if (!wentOut) return;
      setOpen(false);
      setTyped('');
    });
  };

  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm font-medium">Delete your DorkOS account</p>
      {sent !== null ? (
        <div className="space-y-2">
          <p ref={note} role="status" tabIndex={-1} className="text-sm outline-none">
            {expired ? (
              'The link has expired, so nothing was deleted. Send a new one to carry on.'
            ) : (
              <SentText sentTo={sent.confirmationSentTo} confirmBy={sent.confirmBy} />
            )}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={requesting}
            aria-busy={requesting}
            onClick={() => void request()}
          >
            {requesting ? 'Sending…' : 'Send a new link'}
          </Button>
          {/* A new link that could not be sent. The one already out still stands. */}
          {failed !== null && <BillingNoticeView notice={failed} />}
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Ends your plan and erases the account for good. Everything on this computer stays.
          </p>
          <Button
            ref={opener}
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setOpen(true)}
          >
            Delete your DorkOS account…
          </Button>
        </>
      )}

      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent
          className="min-h-0 sm:max-w-md"
          onOpenAutoFocus={(event) => {
            // Straight to the one thing the dialog asks for.
            event.preventDefault();
            confirmField.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Back to the button that opened it on Cancel or Escape. Once a link
            // is out that button is gone: land on the note that says what
            // happens next instead.
            const target = note.current ?? opener.current;
            if (target === null) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Delete your DorkOS account?</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              This can’t be undone. Nothing is deleted until you follow the emailed link.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <div className="space-y-4 text-sm">
              <div className="space-y-1">
                <p className="font-medium">What goes</p>
                <ul className="text-muted-foreground list-inside list-disc space-y-1">
                  <li>Your plan, which ends right away</li>
                  <li>Credits you haven’t used</li>
                  <li>The seats on your account</li>
                  <li>Everything else your DorkOS account holds</li>
                </ul>
              </div>
              <div className="space-y-1">
                <p className="font-medium">What stays</p>
                <p className="text-muted-foreground">
                  Everything on this computer: your agents, chats, projects and files.
                </p>
                <p className="text-muted-foreground">
                  This computer unlinks and keeps working on its own.
                </p>
              </div>
              <ExportAccountData heading="Want a copy first?" />
              <div className="space-y-2">
                <label htmlFor="delete-account-confirm" className="font-medium">
                  Type <strong>{DELETE_CONFIRM_WORD}</strong> to confirm
                </label>
                <Input
                  ref={confirmField}
                  id="delete-account-confirm"
                  data-testid="delete-account-confirm-input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') send();
                  }}
                  placeholder={DELETE_CONFIRM_WORD}
                  autoComplete="off"
                  disabled={requesting}
                />
              </div>
              {failed !== null && <BillingNoticeView notice={failed} />}
            </div>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <ResponsiveDialogClose asChild>
              <Button variant="outline" disabled={requesting}>
                Cancel
              </Button>
            </ResponsiveDialogClose>
            <Button
              variant="destructive"
              disabled={!confirmed || requesting}
              aria-busy={requesting}
              onClick={send}
            >
              {requesting ? 'Sending…' : 'Email me the link'}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}

/**
 * Where the link went, until when, and that nothing is gone yet.
 *
 * @param props.sentTo - Where the link went, as the service showed it.
 * @param props.confirmBy - When the link stops working, or `null`.
 */
function SentText({ sentTo, confirmBy }: { sentTo: string; confirmBy: string | null }) {
  const until = confirmBy === null ? null : formatConfirmBy(confirmBy);
  return (
    <>
      <span className="block">
        Check your email. A link went to <span className="font-medium">{sentTo}</span>.
      </span>{' '}
      <span className="block">
        Your account is deleted only when you follow it
        {until === null ? '.' : `, and the link works until ${until}.`}
      </span>{' '}
      <span className="block">This computer then unlinks on its own.</span>
    </>
  );
}
