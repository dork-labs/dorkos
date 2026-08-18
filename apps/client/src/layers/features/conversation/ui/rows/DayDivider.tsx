/**
 * Full-bleed day boundary in the message list.
 *
 * @module features/conversation/ui/rows/DayDivider
 */

interface DayDividerProps {
  /** Already-phrased day label, e.g. "Today" or "Monday, July 21". */
  label: string;
}

/**
 * The rule that separates one calendar day from the next.
 *
 * A list-level row, not message decoration: it spans the full column width and
 * carries a centered label chip, so a reader scanning a long transcript can tell
 * at a glance where yesterday ended. The label is phrased upstream by
 * `buildListRows` — this component only renders it.
 */
export function DayDivider({ label }: DayDividerProps) {
  return (
    <div
      data-slot="day-divider"
      data-testid="day-divider"
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 py-4"
    >
      <span aria-hidden="true" className="bg-border/70 h-px flex-1" />
      <span className="border-border/70 bg-background text-muted-foreground text-2xs rounded-full border px-2.5 py-0.5 font-medium">
        {label}
      </span>
      <span aria-hidden="true" className="bg-border/70 h-px flex-1" />
    </div>
  );
}
