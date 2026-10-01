import { useState } from 'react';
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

/** The word a person types to confirm. Plain, short, and the same in every language this ships in. */
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
 * the tab returns to signed out.
 *
 * Self-contained: renders nothing with no cloud account.
 */
export function DeleteAccount() {
  const { data } = useCloudPlan();
  const { state, request, reset } = useAccountDeletion();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  if (!data?.available) return null;

  const confirmed = typed.trim().toLowerCase() === DELETE_CONFIRM_WORD;
  const requesting = state.kind === 'requesting';

  const onOpenChange = (next: boolean) => {
    if (requesting) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      if (state.kind === 'failed') reset();
    }
  };

  const send = () => {
    if (!confirmed || requesting) return;
    void request().then((next) => {
      // A sent link closes the dialog; the section below says what happens next.
      if (next.kind !== 'sent') return;
      setOpen(false);
      setTyped('');
    });
  };

  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm font-medium">Delete your DorkOS account</p>
      {state.kind === 'sent' ? (
        <SentNotice
          sentTo={state.deletion.confirmationSentTo}
          confirmBy={state.deletion.confirmBy}
          onResend={() => void request()}
        />
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Ends your plan and erases the account for good. Everything on this computer stays.
          </p>
          <Button type="button" size="sm" variant="destructive" onClick={() => setOpen(true)}>
            Delete your DorkOS account…
          </Button>
          {/* A new link that could not be sent, asked for outside the dialog. */}
          {!open && state.kind === 'failed' && <BillingNoticeView notice={state.notice} />}
        </>
      )}

      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent className="min-h-0 sm:max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Delete your DorkOS account?</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              This can’t be undone. We’ll email you a link to finish, and nothing is deleted until
              you follow it.
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
                  Everything on this computer: your agents, sessions, projects and files. This
                  computer unlinks and keeps working on its own.
                </p>
              </div>
              <ExportAccountData heading="Want a copy first?" />
              <div className="space-y-2">
                <label htmlFor="delete-account-confirm" className="font-medium">
                  Type <strong>{DELETE_CONFIRM_WORD}</strong> to confirm
                </label>
                <Input
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
              {state.kind === 'failed' && <BillingNoticeView notice={state.notice} />}
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

/** Props for {@link SentNotice}. */
interface SentNoticeProps {
  sentTo: string;
  confirmBy: string | null;
  onResend: () => void;
}

/**
 * What happens now that the link is out: where it went, until when, and that
 * nothing is gone yet.
 *
 * @param props - Where the link went, its deadline and a way to send a new one.
 */
function SentNotice({ sentTo, confirmBy, onResend }: SentNoticeProps) {
  const until = confirmBy === null ? null : formatConfirmBy(confirmBy);
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm">
        Check your email. We sent a link to <span className="font-medium">{sentTo}</span>. Your
        account is deleted only when you follow it
        {until === null ? '.' : `, and the link works until ${until}.`} When you do, this computer
        unlinks on its own.
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onResend}>
        Send a new link
      </Button>
    </div>
  );
}
