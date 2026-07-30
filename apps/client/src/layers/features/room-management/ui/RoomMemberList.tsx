/**
 * Who is in a room — people, then agents, each group counted.
 *
 * @module features/room-management/ui/RoomMemberList
 */
import type { ReactNode } from 'react';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { Skeleton } from '@/layers/shared/ui';

export interface RoomMemberListProps {
  /** The roster, in the order the server hands it back. */
  members: readonly RoomRosterEntry[];
  /** True while the roster is being read. */
  isLoading: boolean;
  /** True when the roster could not be read at all. */
  isError: boolean;
  /**
   * Draw one member.
   *
   * The list decides where a member goes and what it is counted as; everything
   * a ROW does — its loudness, its menu, its confirmation — belongs to whatever
   * owns the writes, which is the sheet. Passing the row in keeps the grouping
   * here from acquiring sixteen props it only forwards.
   */
  children: (member: RoomRosterEntry) => ReactNode;
}

/** How many placeholder rows stand in for the roster while it is read. */
const SKELETON_ROWS = 2;

/** The heading over one group. Uppercase and small, the way a roster labels itself. */
function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="text-muted-foreground px-1 pt-1 text-[10px] font-medium tracking-wider uppercase">
      {label} <span className="tabular-nums">{count}</span>
    </h3>
  );
}

/**
 * The roster, grouped rather than segregated.
 *
 * **One list, two headings.** Slack splits its sheet into a Members tab and an
 * "Agents & apps" tab — mixing them where it matters and segregating them where
 * it shows. Grouping keeps agents participants: the difference is carried at row
 * level by the bot glyph and by whether the row has a loudness at all, and both
 * groups are on screen together.
 *
 * **The reader is IN this list.** A surface that answers "who is in here?" by
 * naming everyone except the person asking is describing a room that does not
 * exist. They simply have no loudness and no verbs — see `RoomMemberRow`.
 *
 * **Nothing is dropped.** Agents are `kind === 'agent'`; everything else is a
 * person, including the `system` placeholder the server falls back to for an
 * author it cannot resolve. A roster that silently omitted a member it could not
 * classify would be worse than one that shows an odd row.
 *
 * Order inside each group is the server's — oldest membership first
 * (`RoomStore.listMembers`), which puts whoever opened the room at the top.
 * Nothing re-sorts here, so the sidebar and this sheet name the same people in
 * the same order because neither of them decides one.
 */
export function RoomMemberList({ members, isLoading, isError, children }: RoomMemberListProps) {
  const agents = members.filter((member) => member.author.kind === 'agent');
  const people = members.filter((member) => member.author.kind !== 'agent');

  return (
    <section aria-label="Current members" aria-busy={isLoading || undefined} className="space-y-2">
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p className="text-muted-foreground text-sm">
          Couldn&apos;t read who is in here. Everyone is still where they were — close this and open
          it again to retry.
        </p>
      )}

      {!isLoading && !isError && (
        <>
          {people.length > 0 && (
            <>
              <GroupHeading label="People" count={people.length} />
              <ul className="space-y-2.5">
                {people.map((member) => (
                  <li key={member.authorId}>{children(member)}</li>
                ))}
              </ul>
            </>
          )}

          {agents.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No agents in here yet. Add one below and it will see everything said so far.
            </p>
          ) : (
            <>
              <GroupHeading label="Agents" count={agents.length} />
              <ul className="space-y-2.5">
                {agents.map((member) => (
                  <li key={member.authorId}>{children(member)}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
