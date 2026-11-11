import { useEffect, useRef, useState } from 'react';
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
  Button,
} from '@/layers/shared/ui';
import { browserErrorMessage } from '../lib/browser-error-message';

/**
 * The Agent browser's saved sign-ins, as one row with a confirmed Forget (DOR-4105).
 * Person only; the server owns the writer and authority checks.
 */
export function SavedSignIns({
  enabled,
  disabled = false,
}: {
  enabled: boolean;
  disabled?: boolean;
}) {
  const transport = useTransport();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A folder changed outside DorkOS can't be fixed by trying again, so the dialog
  // becomes the answer: no question, no Forget button, just Close (DOR-4172).
  const [folderChanged, setFolderChanged] = useState(false);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);
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
      setNotice('Sign-ins forgotten.');
      await client.invalidateQueries({ queryKey: LOCAL_BROWSER_STATE_KEY });
      setAsking(false);
    } catch (cause) {
      if ((cause as { code?: string } | null)?.code === 'profiles_folder_changed')
        setFolderChanged(true);
      else setError(browserErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  if (!enabled) return null;
  return (
    <section aria-label="Saved sign-ins" className="flex shrink-0 items-center gap-3">
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium">Saved sign-ins</h4>
        <p className="text-muted-foreground text-xs">
          Kept apart from your own browser. Every agent here shares them.
        </p>
        {disabled && (
          <p className="text-muted-foreground text-xs">Wait for the browser action to finish.</p>
        )}
      </div>
      <Button
        ref={opener}
        size="sm"
        variant="outline"
        disabled={disabled || pending}
        onClick={() => {
          setError(null);
          setFolderChanged(false);
          setNotice('');
          setAsking(true);
        }}
      >
        Forget…
      </Button>
      <p role="status" className="sr-only">
        {notice}
      </p>
      <AlertDialog
        open={asking}
        onOpenChange={(open) => {
          if (!open && !pending) setAsking(false);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
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
                <AlertDialogAction ref={close} onClick={() => setAsking(false)}>
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
    </section>
  );
}
