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

interface StopConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many messages are waiting on the queue — named in the copy. */
  queuedCount: number;
  /** Called when the user confirms — interrupts the turn and empties the queue. */
  onConfirm: () => void;
}

/**
 * Confirmation for a Stop that would empty a queue with messages waiting.
 *
 * A Stop stops everything queued, so it names the cost before it happens: how
 * many messages come back. A confirmation that hides the consequence is not one.
 * The messages return to the composer rather than vanishing, so this asks about
 * a pause, not a loss. A Stop with nothing queued never reaches this dialog —
 * and neither does a Stop whose queue drains while the question is on screen:
 * the host closes this the moment `queuedCount` reaches zero, so the copy is
 * never left asking about no messages at all (DOR-1443).
 */
export function StopConfirmDialog({
  open,
  onOpenChange,
  queuedCount,
  onConfirm,
}: StopConfirmDialogProps) {
  const noun = queuedCount === 1 ? 'message' : 'messages';
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Stop, and put {queuedCount} queued {noun} back?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The agent stops now, and the {noun} you have waiting {queuedCount === 1 ? 'goes' : 'go'}{' '}
            back into your composer. Nothing you typed is lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep going</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Stop</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
