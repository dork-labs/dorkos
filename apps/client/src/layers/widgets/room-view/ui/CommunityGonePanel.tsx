import { useState } from 'react';
import { CircleOff } from 'lucide-react';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { useEndCommunityConnection, useUnsentCommunityDrafts } from '@/layers/entities/community';
import { useCopyFeedback } from '@/layers/shared/lib';
import { useCommunityAuthority } from '@/layers/shared/model';
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

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The sentence that says what never reached a gone Community (DOR-2575), or `null` when nothing
 * is missing: its agents' posts that were still waiting or had failed when DorkOS removed its
 * copy, and the person's own drafts still held in this window.
 *
 * @param agentMessages - Agent posts the server counted before the purge.
 * @param drafts - The person's unsent drafts for this Community.
 */
export function unsentSummary(agentMessages: number, drafts: number): string | null {
  const parts = [
    agentMessages > 0
      ? count(agentMessages, 'message from your agents', 'messages from your agents')
      : null,
    drafts > 0 ? count(drafts, 'draft of yours', 'drafts of yours') : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const single = parts.length === 1 && (agentMessages === 1 || drafts === 1);
  return `${parts.join(' and ')} ${single ? 'wasn’t' : 'weren’t'} sent.`;
}

/**
 * What stands in for a Community that is gone (DOR-2334).
 *
 * Told apart because they call for different honesty. **Deleted** or **taken down** by its host:
 * the Community said so, and DorkOS already removed what it kept. **Seems to be gone**: for two weeks it has only
 * answered that no such community exists, which a deleted community and a misconfigured host
 * both do — so nothing is removed on a guess, and the person decides.
 *
 * Either way it says what never arrived (DOR-2575): the agents' posts the server counted before
 * it removed the copy, and the person's own unsent drafts, which it offers to copy before
 * removing the Community clears them.
 */
export function CommunityGonePanel({ connection, onRemoved }: CommunityGonePanelProps) {
  const state = communityGoneState(connection);
  const end = useEndCommunityConnection();
  const [confirming, setConfirming] = useState(false);
  const { ownerKey } = useCommunityAuthority();
  const drafts = useUnsentCommunityDrafts(ownerKey, connection.ref);
  const { copied, failed, copy } = useCopyFeedback();
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
      ? 'This space was taken down'
      : state === 'deleted'
        ? 'This space was deleted'
        : 'This space seems to be gone';
  const body =
    state === 'taken-down'
      ? `Whoever runs ${label} took it down, so DorkOS removed the copy it kept on this computer. If they put it back, you can connect again.`
      : state === 'deleted'
        ? `${label} no longer exists, so DorkOS removed the copy it kept on this computer.`
        : `Since ${since}, ${label} has said this space doesn’t exist. It may have been deleted. This computer still has a copy of its channels, messages and files.`;
  const unsent = unsentSummary(
    deleted ? (connection.undeliveredAgentMessages ?? 0) : 0,
    drafts.length
  );
  const draftsCleared =
    drafts.length === 0
      ? ''
      : drafts.length === 1
        ? ' Your unsent draft is cleared too.'
        : ` Your ${drafts.length} unsent drafts are cleared too.`;
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-sm"
      data-testid="community-gone"
    >
      <CircleOff className="text-muted-foreground/50 size-10" aria-hidden />
      <p className="text-foreground font-medium">{heading}</p>
      <p className="text-muted-foreground max-w-sm">{body}</p>
      {unsent && (
        <p role="status" className="text-foreground max-w-sm" data-testid="community-gone-unsent">
          {unsent}
        </p>
      )}
      {/* The button's own label changes too, but a changed label is not reliably read out. */}
      <span className="sr-only" aria-live="polite" data-testid="community-gone-copy-status">
        {copied ? 'Copied.' : failed ? 'Couldn’t copy to the clipboard.' : ''}
      </span>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {drafts.length > 0 && (
          <Button variant="outline" onClick={() => void copy(drafts.join('\n\n'))}>
            {copied
              ? 'Copied'
              : failed
                ? 'Couldn’t copy'
                : drafts.length === 1
                  ? 'Copy your draft'
                  : 'Copy your drafts'}
          </Button>
        )}
        <Button variant={deleted ? 'outline' : 'destructive'} onClick={() => setConfirming(true)}>
          {deleted ? 'Remove from DorkOS' : 'Remove local copy'}
        </Button>
      </div>
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
                ? `${label} leaves this app. There’s nothing left of it to remove from this computer.${draftsCleared}`
                : `This removes ${label} from DorkOS, and everything DorkOS kept from it on this computer: its channels, messages and files. Your agents stop answering there. If ${label} is still around, you can connect again later.${draftsCleared}`}
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
