import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  LOCAL_BROWSER_PROFILES_KEY,
  LOCAL_BROWSER_STATE_KEY,
  useBrowserProfiles,
} from '@/layers/entities/local-browser';
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

type Selection = { id: string | null; label: string; action: 'forget' | 'delete' };

/** Person-only, profile-wide removal controls; the server owns writer and authority checks. */
export function BrowserProfiles({
  enabled,
  disabled = false,
}: {
  enabled: boolean;
  disabled?: boolean;
}) {
  const profiles = useBrowserProfiles(enabled);
  const transport = useTransport();
  const client = useQueryClient();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const deleting = selection?.action === 'delete';
  const choose = (next: Selection, trigger: HTMLButtonElement) => {
    setError(null);
    setNotice('');
    opener.current = trigger;
    setSelection(next);
  };
  const remove = async () => {
    if (!selection || pending) return;
    setPending(true);
    setError(null);
    try {
      if (selection.action === 'delete' && selection.id)
        await transport.deleteLocalBrowserProfile(selection.id);
      else await transport.forgetLocalBrowserSignIns(selection.id);
      setNotice(selection.action === 'delete' ? 'Profile deleted.' : 'Sign-ins forgotten.');
      await Promise.all([
        client.invalidateQueries({ queryKey: LOCAL_BROWSER_PROFILES_KEY }),
        client.invalidateQueries({ queryKey: LOCAL_BROWSER_STATE_KEY }),
      ]);
      setSelection(null);
    } catch (cause) {
      setError(browserErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  if (!enabled) return null;
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="Browser profiles"
      className="shrink-0 space-y-3"
    >
      <h4 className="text-sm font-medium">Profiles</h4>
      {profiles.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-muted-foreground text-sm">
            Couldn’t read profiles. Try again.
          </p>
          <Button size="sm" variant="outline" onClick={() => void profiles.refetch()}>
            Try again
          </Button>
        </div>
      ) : profiles.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading profiles…
        </p>
      ) : (
        [{ id: null, label: 'Default profile' }, ...profiles.data.profiles].map((profile) => (
          <section
            key={profile.id ?? 'default'}
            aria-label={profile.label}
            className="bg-muted/40 space-y-2 rounded-md p-3"
          >
            <h5 className="text-sm font-medium break-words">{profile.label}</h5>
            <p className="text-muted-foreground text-xs">
              Forgetting removes every site’s sign-in in this profile.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || pending}
                onClick={(event) => choose({ ...profile, action: 'forget' }, event.currentTarget)}
              >
                Forget sign-ins
              </Button>
              {profile.id && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || pending}
                  onClick={(event) => choose({ ...profile, action: 'delete' }, event.currentTarget)}
                >
                  Delete profile
                </Button>
              )}
            </div>
          </section>
        ))
      )}
      {disabled && (
        <p className="text-muted-foreground text-xs">Wait for the browser action to finish.</p>
      )}
      <p role="status" className="sr-only">
        {notice}
      </p>
      <AlertDialog
        open={!!selection}
        onOpenChange={(open) => {
          if (!open && !pending) setSelection(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (opener.current?.isConnected ? opener.current : section.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              {deleting
                ? `Delete ${selection?.label}?`
                : `Forget every sign-in in ${selection?.label}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {deleting
                    ? 'This removes the profile and every site’s sign-in in it.'
                    : 'This removes every site’s sign-in in this profile.'}
                </p>
                <p>
                  {deleting
                    ? 'Agents using it lose access to this profile.'
                    : 'Agents using it will have to sign in again.'}
                </p>
              </div>
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
                void remove();
              }}
            >
              {pending ? 'Removing…' : deleting ? 'Delete profile' : 'Forget sign-ins'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
