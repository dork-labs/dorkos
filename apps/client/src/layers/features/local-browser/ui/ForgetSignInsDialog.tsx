import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LOCAL_BROWSER_STATE_KEY } from '@/layers/entities/local-browser';
import { useTransport } from '@/layers/shared/model';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui';
import { browserErrorMessage } from '../lib/browser-error-message';

/** Props for {@link ForgetSignInsDialog}. */
export interface ForgetSignInsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes when the dialog closes: the control that opened it. */
  returnFocus: RefObject<HTMLElement | null>;
  /** Says "Sign-ins forgotten." once they are, for a screen reader. */
  onForgotten: () => void;
}

/**
 * The confirmed Forget for the Agent browser's saved sign-ins (DOR-4105). Person
 * only; the server owns the writer and authority checks. Opened from the
 * browser's ⋯ menu, or from the Saved sign-ins row while no page is open.
 */
export function ForgetSignInsDialog({
  open,
  onOpenChange,
  returnFocus,
  onForgotten,
}: ForgetSignInsDialogProps) {
  const transport = useTransport();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A folder changed outside DorkOS can't be fixed by trying again, so the dialog
  // becomes the answer: no question, no Forget button, just Close (DOR-4172).
  const [folderChanged, setFolderChanged] = useState(false);
  const close = useRef<HTMLButtonElement | null>(null);
  // Each opening asks the question afresh.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the last answer as the dialog opens
    setError(null);
    setFolderChanged(false);
  }, [open]);
  // The answer replaces the question in place, so focus moves to its one button.
  useEffect(() => {
    if (folderChanged) close.current?.focus();
  }, [folderChanged]);
  const forget = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await transport.forgetLocalBrowserSignIns(null);
      onForgotten();
      await client.invalidateQueries({ queryKey: LOCAL_BROWSER_STATE_KEY });
      onOpenChange(false);
    } catch (cause) {
      if ((cause as { code?: string } | null)?.code === 'profiles_folder_changed')
        setFolderChanged(true);
      else setError(browserErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onOpenChange(false);
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        {folderChanged ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Sign-ins weren’t forgotten</AlertDialogTitle>
              <AlertDialogDescription>
                Their folder was changed outside DorkOS, so DorkOS left it alone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogAction ref={close} onClick={() => onOpenChange(false)}>
                Close
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Forget saved sign-ins?</AlertDialogTitle>
              <AlertDialogDescription>
                This signs every agent here out of every site. It can’t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                onClick={(event) => {
                  event.preventDefault();
                  void forget();
                }}
              >
                {pending ? 'Forgetting…' : 'Forget sign-ins'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
