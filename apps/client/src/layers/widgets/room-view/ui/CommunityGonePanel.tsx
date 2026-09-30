import { useState } from 'react';
import { CircleOff } from 'lucide-react';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { useEndCommunityConnection } from '@/layers/entities/community';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@/layers/shared/ui';

/** Props for {@link CommunityGonePanel}. */
export interface CommunityGonePanelProps {
  /** The connection the page is on. */
  connection: CommunityConnectionDescriptor;
  /** Runs once the local copy is removed, to leave the page. */
  onRemoved: () => void;
}

/** Whether a connection's Community is gone, or seems to be, so the page shows this instead. */
export function communityGoneState(
  connection: CommunityConnectionDescriptor | undefined
): 'deleted' | 'taken-down' | 'seems-gone' | null {
  if (!connection) return null;
  // The Community answered with a rejected grant, so it is there again — a takedown the host
  // reversed and lifted, most likely. What was recorded before is history; reconnecting is the
  // way on, and the page's own reconnect path says so.
  if (connection.status === 'reconnect-required') return null;
  if (connection.access?.lastKnown?.lifecycle === 'deleted') return 'deleted';
  if (connection.access?.lastKnown?.lifecycle === 'taken_down') return 'taken-down';
  if (connection.seemsGoneSince) return 'seems-gone';
  return null;
}

/**
 * What stands in for a Community that is gone (DOR-2334).
 *
 * Told apart because they call for different honesty. **Deleted** or **taken down** by its host:
 * the Community said so, and DorkOS already removed what it kept. **Seems to be gone**: for two weeks it has only
 * answered that no such community exists, which a deleted community and a misconfigured host
 * both do — so nothing is removed on a guess, and the person decides.
 */
export function CommunityGonePanel({ connection, onRemoved }: CommunityGonePanelProps) {
  const state = communityGoneState(connection);
  const end = useEndCommunityConnection();
  const [confirming, setConfirming] = useState(false);
  const label = connection.label;
  const since = connection.seemsGoneSince
    ? new Date(connection.seemsGoneSince).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  function remove() {
    end.mutate(connection, {
      onSuccess: () => {
        setConfirming(false);
        toast.success(`${label} is removed from DorkOS.`);
        onRemoved();
      },
    });
  }

  // Deleted and taken down read alike from here on: DorkOS already removed the copy.
  const deleted = state === 'deleted' || state === 'taken-down';
  const heading =
    state === 'taken-down'
      ? 'The host took this community down'
      : state === 'deleted'
        ? 'This community was deleted'
        : 'This community seems to be gone';
  const body =
    state === 'taken-down'
      ? `The host of ${label} took it down, so DorkOS removed the copy it kept on this computer. If the host puts it back, you can connect again.`
      : state === 'deleted'
        ? `${label} no longer exists, so DorkOS removed the copy it kept on this computer.`
        : `Since ${since}, ${label} has said this community doesn’t exist. It may have been deleted. This computer still has a copy of its channels, messages and files.`;
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-sm"
      data-testid="community-gone"
    >
      <CircleOff className="text-muted-foreground/50 size-10" aria-hidden />
      <p className="text-foreground font-medium">{heading}</p>
      <p className="text-muted-foreground max-w-sm">{body}</p>
      <Button variant={deleted ? 'outline' : 'destructive'} onClick={() => setConfirming(true)}>
        {deleted ? 'Remove from DorkOS' : 'Remove local copy'}
      </Button>
      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next) end.reset();
          setConfirming(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleted ? `Remove ${label} from DorkOS?` : `Remove your copy of ${label}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleted
                ? `${label} leaves this app. There’s nothing left of it to remove from this computer.`
                : `This removes ${label} from DorkOS, and everything DorkOS kept from it on this computer: its channels, messages and files. Your agents stop answering there. If ${label} is still around, you can connect again later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {end.isError && (
            <p role="alert" className="text-destructive text-sm">
              Couldn’t remove it. Check that DorkOS is running, then try again.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={end.isPending}>Keep it</AlertDialogCancel>
            <Button variant="destructive" disabled={end.isPending} onClick={remove}>
              {end.isPending ? 'Removing…' : deleted ? 'Remove from DorkOS' : 'Remove local copy'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
