/**
 * The small heading over one project's items in "Needs you" (spec
 * `flow-multiproject` §6.3, V2).
 *
 * @module features/inbox/ui/InboxProjectHeading
 */

/** Props for {@link InboxProjectHeading}. */
export interface InboxProjectHeadingProps {
  /** The project's short name. */
  name: string;
  /** The muted right-hand label an extension gave the project ("Linear DOR"), or null. */
  label?: string | null;
}

/**
 * The project's name on the left and, when an extension named one, its
 * tracker on the right. Drawn only when two or more projects have something
 * waiting; with one, the heading hides.
 *
 * @param props - The name and the label.
 */
export function InboxProjectHeading({ name, label }: InboxProjectHeadingProps) {
  return (
    <h3
      data-slot="inbox-project-heading"
      className="text-foreground/80 mt-2 flex min-w-0 items-baseline justify-between gap-2 px-2 text-[11px] font-semibold"
    >
      <span className="max-w-[65%] shrink-0 truncate">{name}</span>
      {label && (
        <span className="text-muted-foreground min-w-0 truncate font-normal">
          <bdi>{label}</bdi>
        </span>
      )}
    </h3>
  );
}
