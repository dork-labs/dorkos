/**
 * The one question worth interrupting somebody with: you are about to throw
 * away what you just wrote (spec `profile-unification` §1.5).
 *
 * Shared by both ways out of an editor — the page's ‹ Profile and the sheet's
 * close — so the wording and the shape of the choice are the same wherever you
 * meet it.
 *
 * @module features/profile/ui/DiscardChangesDialog
 */
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';

export interface DiscardChangesDialogProps {
  /** Whether the question is on screen. */
  open: boolean;
  /** Stay where you are and keep the text. */
  onKeep: () => void;
  /** Leave, losing it. */
  onDiscard: () => void;
}

/** "Discard your changes?" — keep editing, or leave without saving. */
export function DiscardChangesDialog({ open, onKeep, onDiscard }: DiscardChangesDialogProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <ResponsiveDialogContent className="min-h-0 sm:max-w-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Discard your changes?</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            You haven’t saved what you wrote here. Leaving now loses it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogFooter>
          {/* The safe way out comes first, exactly as it does in the profile's
              other confirmations — which also means it is what the dialog
              focuses on arrival, without an `autoFocus` to say so. */}
          <Button variant="outline" onClick={onKeep}>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            Discard
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
