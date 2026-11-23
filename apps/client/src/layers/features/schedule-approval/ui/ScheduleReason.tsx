import { ScheduleFileProblem } from '@/layers/entities/tasks';
import { cn } from '@/layers/shared/lib';

/** Props for {@link ScheduleReason}. */
interface ScheduleReasonProps {
  /** The agent's case, or DorkOS's own sentence for a schedule found in a file. */
  reason: string;
  /** The file sits where no schedule is read: say what is wrong with it instead. */
  misplaced: boolean;
  /** The words are DorkOS's own, so they are not dressed as a quotation. */
  dorkosWrote: boolean;
}

/**
 * The agent's case on a schedule approval card, in its own words and in full.
 * Never clamped: this is the whole of what the operator is being asked to weigh.
 *
 * For a schedule found in a file the words are DorkOS's own — why it is
 * waiting, or what is wrong with the file — so they are not dressed as a
 * quotation. Attributing our sentence to a proposer who does not exist would be
 * the small dishonesty that makes a person distrust the rest.
 */
export function ScheduleReason({ reason, misplaced, dorkosWrote }: ScheduleReasonProps) {
  return (
    <p
      data-slot="schedule-reason"
      className={cn(
        'text-foreground/90 border-border/60 min-w-0 border-l-2 pl-2.5 text-xs break-words',
        !dorkosWrote && 'italic'
      )}
    >
      {misplaced ? <ScheduleFileProblem /> : dorkosWrote ? reason : <>“{reason}”</>}
    </p>
  );
}
