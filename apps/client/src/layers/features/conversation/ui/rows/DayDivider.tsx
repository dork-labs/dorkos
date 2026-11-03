/**
 * Day boundary in the message list.
 *
 * @module features/conversation/ui/rows/DayDivider
 */

interface DayDividerProps {
  /** Already-phrased day label, e.g. "Today" or "Monday, July 21". */
  label: string;
}

/**
 * The label that separates one calendar day from the next.
 *
 * A list-level row, not message decoration: a centred line of small text, with
 * no rule and no pill, so a reader scanning a long transcript can tell where
 * yesterday ended without one more thing competing with the messages. The unread
 * line is the one that gets a rule, in orange, because it marks "you were here".
 * The label is phrased upstream by `buildListRows` — this component only renders
 * it.
 */
export function DayDivider({ label }: DayDividerProps) {
  return (
    <div
      data-slot="day-divider"
      data-testid="day-divider"
      role="separator"
      aria-label={label}
      className="text-muted-foreground text-2xs py-4 text-center font-medium"
    >
      {label}
    </div>
  );
}
