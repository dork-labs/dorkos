import { EyeOff } from 'lucide-react';
import { CompactResultRow } from '@/layers/shared/ui';

interface UnreadableEntryNoteProps {
  /** What could not be shown, in plain words. */
  message: string;
}

/**
 * Quiet transcript note where a message, or a prompt, could not be read
 * (DOR-2078).
 *
 * The client keeps a session loading when one stored entry fails validation and
 * puts this note in its place. It is deliberately NOT an error card: nothing
 * failed in the conversation itself, and a red "Error" heading over an old
 * damaged message reads as the agent having failed. It renders as a subdued row,
 * so the gap is honest without being alarming.
 */
export function UnreadableEntryNote({ message }: UnreadableEntryNoteProps) {
  return (
    <CompactResultRow
      data-testid="unreadable-entry-note"
      icon={<EyeOff aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />}
      label={<span className="text-muted-foreground">{message}</span>}
    />
  );
}
