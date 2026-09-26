/**
 * The three questions a change to a room's files can put to a person (spec
 * `agent-home-desk` §7.3): "delete this?", "replace these, or keep both?", and
 * "somebody got there first — look at theirs, or do it anyway?".
 *
 * Each one is a decision only the person can make, so each is a dialog that
 * says what will happen in plain words and does nothing until answered. The
 * third is the same choice the editor offers when a save loses a race, in the
 * same words where the words fit.
 *
 * Every name in here — a file, a folder, the author of a commit, a commit's
 * subject — is member-written text, and is rendered as text.
 *
 * @module features/file-explorer/ui/SourceChangeDialogs
 */
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
import { formatRelativeTime } from '@/layers/shared/lib';
import type { ChangeKind, PendingDelete, SourceChangesApi } from '../model/use-source-changes';
import { ROOT_KEY } from '../model/tree';

/** What {@link SourceChangeDialogs} needs. */
export interface SourceChangeDialogsProps {
  /** The changes whose questions to ask. */
  changes: SourceChangesApi;
  /** Show the file somebody else changed first. */
  onOpenTheirs: (path: string) => void;
  /**
   * Put the keyboard back in the tree once a dialog closes.
   *
   * These dialogs are opened by the pane rather than by a button, so Radix has
   * no trigger to hand focus back to and drops it on `<body>` — a keyboard user
   * who confirmed a delete was left nowhere, and the next Tab started again at
   * the top of the page.
   */
  onReturnFocus: () => void;
}

/** How "do it anyway" reads for each kind of change. */
const ANYWAY_LABEL: Record<ChangeKind, string> = {
  rename: 'Rename it anyway',
  move: 'Move it anyway',
  delete: 'Delete it anyway',
  upload: 'Upload mine over it',
};

/** What the lost race stopped, in the sentence that says so. */
const STOPPED: Record<ChangeKind, string> = {
  rename: 'nothing was renamed',
  move: 'nothing was moved',
  delete: 'nothing was deleted',
  upload: 'nothing was uploaded',
};

/**
 * The sentence a delete confirmation says about what goes.
 *
 * @param pending - The delete waiting to be confirmed.
 */
export function deleteSentence(pending: PendingDelete): string {
  const { entry, fileCount, moreThan } = pending;
  const keeps =
    'The room’s history keeps a copy, so an agent or git can bring it back if you need it.';
  if (entry.type !== 'dir') return `“${entry.name}” leaves the room’s files. ${keeps}`;
  const what =
    fileCount === null
      ? 'everything in it'
      : moreThan
        ? `the more than ${fileCount.toLocaleString()} files in it`
        : fileCount === 1
          ? 'the 1 file in it'
          : `the ${fileCount.toLocaleString()} files in it`;
  return `“${entry.name}” and ${what} leave the room’s files. ${keeps}`;
}

/**
 * The confirmations and choices for a source's tree changes.
 *
 * @param props - The changes, and how to show somebody else's version.
 */
export function SourceChangeDialogs({
  changes,
  onOpenTheirs,
  onReturnFocus,
}: SourceChangeDialogsProps) {
  // Radix's own restore would land on `<body>` — there was no trigger. It is
  // replaced, unless something else already took focus as this one closed
  // (their version opening in the preview, say), which must keep it.
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    onReturnFocus();
  };
  const { pendingDelete, pendingClash, conflict } = changes;
  const clashFolder =
    pendingClash === null
      ? ''
      : pendingClash.dir === ROOT_KEY
        ? 'The top folder'
        : `“${pendingClash.dir}”`;
  const clashOne = pendingClash?.names.length === 1;

  return (
    <>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && changes.cancelDelete()}
      >
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.entry.type === 'dir' ? 'Delete this folder?' : 'Delete this file?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete === null ? '' : deleteSentence(pendingDelete)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={changes.cancelDelete}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void changes.confirmDelete()}
              className="bg-destructive hover:bg-destructive/90 dark:bg-destructive/60 text-white"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingClash !== null}
        onOpenChange={(open) => !open && changes.cancelClash()}
      >
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {clashOne
                ? `Replace “${pendingClash?.names[0]}”?`
                : `Replace ${pendingClash?.names.length ?? 0} files?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {clashOne
                ? `${clashFolder} already has a file with this name. Replace it with yours, or keep both and add yours under a new name.`
                : `${clashFolder} already has files with these names: ${pendingClash?.names.join(', ') ?? ''}. Replace them with yours, or keep both and add yours under new names.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={changes.cancelClash}>Cancel</AlertDialogCancel>
            <Button variant="outline" onClick={() => void changes.resolveClash('keep-both')}>
              Keep both
            </Button>
            <AlertDialogAction onClick={() => void changes.resolveClash('replace')}>
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={conflict !== null}
        onOpenChange={(open) => !open && changes.dismissConflict()}
      >
        <AlertDialogContent onCloseAutoFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Somebody changed this first</AlertDialogTitle>
            <AlertDialogDescription>
              {conflict === null
                ? ''
                : `${conflict.lastCommit?.author ?? 'Somebody'} changed “${conflict.path}” after you opened it, so ${STOPPED[conflict.kind]}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {conflict?.lastCommit && (
            // The commit's own subject — what makes a race resolvable by
            // talking to the person rather than by guessing. Member-written.
            <p className="text-muted-foreground text-xs">
              {conflict.lastCommit.subject} · {formatRelativeTime(conflict.lastCommit.at)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={changes.dismissConflict}>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                if (conflict === null) return;
                changes.dismissConflict();
                onOpenTheirs(conflict.path);
              }}
            >
              Open their version
            </Button>
            <AlertDialogAction
              onClick={() => {
                if (conflict === null) return;
                changes.dismissConflict();
                void conflict.retry();
              }}
              className="bg-destructive hover:bg-destructive/90 dark:bg-destructive/60 text-white"
            >
              {conflict === null ? '' : ANYWAY_LABEL[conflict.kind]}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
