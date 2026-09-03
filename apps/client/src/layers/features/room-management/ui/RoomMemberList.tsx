/**
 * Who is in a room — people, then agents, each group counted.
 *
 * @module features/room-management/ui/RoomMemberList
 */
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { Button, Skeleton } from '@/layers/shared/ui';

export interface RoomMemberListProps {
  /** The roster, in the order the server hands it back. */
  members: readonly RoomRosterEntry[];
  /** True while the roster is being read. */
  isLoading: boolean;
  /** True when the roster could not be read at all. */
  isError: boolean;
  /** Ask for the roster again. The way out of {@link RoomMemberListProps.isError}. */
  onRetry: () => void;
  /**
   * Draw one member.
   *
   * The list decides where a member goes and what it is counted as; everything
   * a ROW does — its loudness, its menu, its confirmation — belongs to whatever
   * owns the writes, which is the panel. Passing the row in keeps the grouping
   * here from acquiring sixteen props it only forwards.
   */
  children: (member: RoomRosterEntry) => ReactNode;
}

/** How many placeholder rows stand in for the roster while it is read. */
const SKELETON_ROWS = 2;

/** How long a row takes to open its own height, or to give it back. */
const ROW_SECONDS = 0.15;

/** How long the brand wash on a row that has just arrived takes to fade out. */
const LANDING_SECONDS = 0.9;

/** How strongly that wash starts. Enough to catch the eye, not to obscure a word. */
const LANDING_OPACITY = 0.16;

/** The heading over one group. Uppercase and small, the way a roster labels itself. */
function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="text-muted-foreground px-1 pt-1 text-3xs font-medium tracking-wider uppercase">
      {label} <span className="tabular-nums">{count}</span>
    </h3>
  );
}

/**
 * One group of the roster, with its rows arriving and leaving rather than
 * blinking.
 *
 * **Both halves of that are information.** A row that leaves by collapsing its
 * own height gives the Undo toast something to refer to — before, the list
 * simply jumped and the offer to undo was about a row nobody saw go. A row that
 * arrives by opening its height and washing brand once is the other end of the
 * add: today an agent vanishes silently from the picker and appears silently
 * here, which reads as loss rather than as success.
 *
 * `initial={false}` is what keeps the roster you OPEN the panel on from
 * performing: those rows were already there. It is read from React context, so
 * it reaches the wash inside each row as well as the row itself.
 *
 * Under `prefers-reduced-motion` both durations go to zero, so a row still
 * arrives and still leaves — it simply does it at once. The wash goes with them,
 * and nothing is lost with it: it says "this is the one that just arrived",
 * which the arrival itself already says.
 *
 * The gap between rows is padding on each row rather than `space-y` on the list,
 * because a margin is outside the height being animated and would leave a
 * stripe of empty list behind every row that collapses. The list pulls the
 * outermost of it back so the group ends where it used to.
 */
function MemberGroup({
  label,
  members,
  children,
}: {
  label: string;
  members: readonly RoomRosterEntry[];
  children: (member: RoomRosterEntry) => ReactNode;
}) {
  const reduced = useReducedMotion();
  const collapsed = { height: 0, opacity: 0 };

  return (
    <>
      <GroupHeading label={label} count={members.length} />
      <ul className="-mt-1 -mb-1.5">
        <AnimatePresence initial={false}>
          {members.map((member) => (
            <motion.li
              key={member.authorId}
              initial={collapsed}
              animate={{ height: 'auto', opacity: 1 }}
              exit={collapsed}
              transition={{ duration: reduced ? 0 : ROW_SECONDS, ease: 'easeOut' }}
              // The height is what is being animated, so what does not fit yet
              // must not be drawn outside it.
              className="overflow-hidden"
            >
              {/* The top slack is the working dot's, whose ping expands past the
                  disc it sits on and would otherwise be shaved by the clip. */}
              <div className="relative pt-1 pb-1.5">
                <motion.span
                  aria-hidden
                  initial={{ opacity: LANDING_OPACITY }}
                  animate={{ opacity: 0 }}
                  transition={{ duration: reduced ? 0 : LANDING_SECONDS, ease: 'easeOut' }}
                  className="bg-brand pointer-events-none absolute inset-0 rounded-md"
                />
                {children(member)}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </>
  );
}

/**
 * The roster, grouped rather than segregated.
 *
 * **One list, two headings.** Slack splits its own into a Members tab and an
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
 * Nothing re-sorts here, so the sidebar and this panel name the same people in
 * the same order because neither of them decides one.
 */
export function RoomMemberList({
  members,
  isLoading,
  isError,
  onRetry,
  children,
}: RoomMemberListProps) {
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
        // The same shape the fleet picker below uses for the same problem: say
        // what failed, say what is still true, and offer the one button that
        // would fix it. "Close this and open it again" was that button, made
        // out of a person.
        <div role="alert" className="space-y-2">
          <p className="text-muted-foreground text-sm">
            Couldn&apos;t read who is in here. Everyone is still where they were.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}

      {!isLoading && !isError && (
        <>
          {people.length > 0 && (
            <MemberGroup label="People" members={people}>
              {children}
            </MemberGroup>
          )}

          {agents.length === 0 ? (
            // Deliberately NOT "there is nobody here to answer you", which is
            // the true and consequential thing about an empty room — the
            // loudness line above this one already says exactly that, and a
            // panel that says it twice is a panel that has stopped counting.
            // What is left is the fact only this line has: joining is not
            // starting, so whoever arrives can read what was said before them.
            <p className="text-muted-foreground text-sm">
              Whoever you add can read everything already said here.
            </p>
          ) : (
            <MemberGroup label="Agents" members={agents}>
              {children}
            </MemberGroup>
          )}
        </>
      )}
    </section>
  );
}
