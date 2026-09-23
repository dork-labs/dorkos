import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { isCommunityInvitationUrl } from '@dorkos/shared/community-wire';
import { openExternalLink } from '@/layers/shared/lib';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { useEndCommunityConnection } from '@/layers/entities/community';

/** Props for {@link JoinCommunityDialog}. */
export interface JoinCommunityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Open a Community invitation link on the Community's own site.
 *
 * Joining makes the person a member there, with their own Community account.
 * It does not connect this DorkOS; that is a separate step the Community
 * offers once they are in. The link is opened as it is and never kept here.
 */
export function JoinCommunityDialog({ open, onOpenChange }: JoinCommunityDialogProps) {
  const id = useId();
  const [link, setLink] = useState('');
  const [invalid, setInvalid] = useState(false);

  function close(next: boolean) {
    if (!next) {
      setLink('');
      setInvalid(false);
    }
    onOpenChange(next);
  }

  const host = isCommunityInvitationUrl(link) ? new URL(link.trim()).host : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!isCommunityInvitationUrl(link)) {
      setInvalid(true);
      return;
    }
    if (openExternalLink(link.trim())) close(false);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={close}>
      <ResponsiveDialogContent className="!min-h-0 sm:max-w-md">
        <form onSubmit={submit}>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Join with an invitation</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Paste the invitation link you were sent. It opens on the community’s own site, where
              you sign in or create an account to join.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-1.5 py-4">
            <Label htmlFor={`${id}-link`}>Invitation link</Label>
            <Input
              id={`${id}-link`}
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://community.example.com/c/…/join#invite=…"
              value={link}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${id}-error` : host !== null ? `${id}-host` : undefined}
              onChange={(event) => {
                setLink(event.target.value);
                setInvalid(false);
              }}
            />
            {host !== null && (
              <p id={`${id}-host`} className="text-muted-foreground text-sm">
                Opens on {host}
              </p>
            )}
            {invalid && (
              <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
                That isn’t an invitation link. Copy the whole link from the invitation you were
                sent.
              </p>
            )}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={link.trim().length === 0}>
              Open invitation
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** Props for {@link DisconnectCommunityDialog}. */
export interface DisconnectCommunityDialogProps {
  /** The Community to disconnect from, or `null` when the dialog is closed. */
  connection: CommunityConnectionDescriptor | null;
  onOpenChange: (open: boolean) => void;
  /** Runs after the server confirmed and this Community's local state is gone. */
  onDisconnected: (connection: CommunityConnectionDescriptor) => void;
}

/**
 * Confirm, then disconnect this installation from one Community.
 *
 * Only this installation's connection ends. The person stays a member of the
 * Community, and every other Community and this DorkOS keep their state.
 */
export function DisconnectCommunityDialog({
  connection,
  onOpenChange,
  onDisconnected,
}: DisconnectCommunityDialogProps) {
  const end = useEndCommunityConnection();
  const [shown, setShown] = useState(connection);
  if (connection !== null && connection !== shown) setShown(connection);
  const label = shown?.label ?? 'this community';

  function confirm() {
    if (!connection) return;
    end.mutate(connection, {
      onSuccess: () => {
        onOpenChange(false);
        toast.success(`${connection.label} is disconnected.`);
        onDisconnected(connection);
      },
    });
  }

  return (
    <AlertDialog
      open={connection !== null}
      onOpenChange={(next) => {
        if (!next) end.reset();
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect this DorkOS from {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its channels leave this app, and your agents stop answering there. You stay a member of{' '}
            {label}, and you can connect again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {end.isError && (
          <p role="alert" className="text-destructive text-sm">
            Couldn’t disconnect. Check that DorkOS is running, then try again.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={end.isPending}>Keep connected</AlertDialogCancel>
          <Button variant="destructive" disabled={end.isPending} onClick={confirm}>
            {end.isPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
