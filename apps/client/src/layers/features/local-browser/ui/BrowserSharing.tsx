import { useEffect, useState } from 'react';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { useTransport } from '@/layers/shared/model';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  Button,
} from '@/layers/shared/ui';

/** Person-clicked sharing controls. Tool results and page content never open this card. */
export function BrowserSharing({
  state,
  action,
}: {
  state: LocalBrowserState;
  action: (run: () => Promise<LocalBrowserState>) => Promise<boolean>;
}) {
  const transport = useTransport();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = state.profile;
  const agentId = profile?.agentId;
  const [sharing, setSharing] = useState<{ agentId: string; shared: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setSharing(null);
    setError(null);
    if (!agentId || !state.sessionId) return;
    void transport.listLocalBrowserProfiles().then(
      ({ profiles }) => {
        if (current)
          setSharing({
            agentId,
            shared: profiles.find((p) => p.id === 'default')?.agentIds.includes(agentId) ?? false,
          });
      },
      () => {
        if (current) setError('Couldn’t read sharing. Try again.');
      }
    );
    return () => {
      current = false;
    };
  }, [transport, agentId, state.sessionId, state.connectionId, reload]);
  if (!profile || !agentId || !state.sessionId) return null;
  if (!sharing || sharing.agentId !== agentId)
    return error ? (
      <div>
        <p role="alert" className="text-sm">
          {error}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>
          Try again
        </Button>
      </div>
    ) : null;
  const shared = sharing.shared;
  const change = async (share: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (share) await transport.bindLocalBrowserProfile('default', profile.agentId!);
      else await transport.unbindLocalBrowserProfile('default', agentId);
      setSharing({ agentId, shared: share });
      await action(() =>
        transport.openLocalBrowser({
          mode: 'new-window',
          sessionId: state.sessionId!,
          ...(share ? { profileId: 'default' } : {}),
        })
      );
      setOpen(false);
    } catch (cause) {
      setError(
        (cause as { code?: string })?.code === 'outside_turn'
          ? 'Wait until this agent’s turn ends, then share.'
          : 'Couldn’t change sharing. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {shared ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change(false)}>
          Stop sharing
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-auto justify-start text-left whitespace-normal"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          This agent has its own browser. Share yours?
        </Button>
      )}
      {error && !open && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Share your browser with {profile.agentName ?? 'your agent'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {profile.agentName
                ? `${profile.agentName} will use your own Chrome window and every site you’re signed in to there.`
                : 'This agent will use your Chrome window and every site you’re signed in to there.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button disabled={busy} onClick={() => void change(true)}>
              {busy ? 'Sharing…' : 'Share browser'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
