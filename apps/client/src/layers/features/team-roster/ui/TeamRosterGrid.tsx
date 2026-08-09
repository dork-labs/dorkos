import type { Ref } from 'react';
import { AnimatePresence, useReducedMotion } from 'motion/react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { IdentityAvatar } from '@/layers/shared/ui';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { cn } from '@/layers/shared/lib';
import {
  countOwnedAgents,
  findTeamOwner,
  groupTeamByOwner,
  teamMemberFace,
  teamMemberLabel,
} from '@/layers/entities/team';
import { shouldAnimateRoster } from '../lib/roster-layout';
import { TeamMemberCard } from './TeamMemberCard';

/** The one grid the roster is drawn in — one column on a phone, more as there is room. */
const GRID = 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3';

export interface TeamRosterGridProps {
  /** The rows to draw, already filtered, in the order the endpoint returned them. */
  members: TeamMember[];
  /** The whole roster — owners are resolved against it, not against the filtered slice. */
  roster: TeamMember[];
  /** Whether agent cards cluster under the person they belong to. */
  grouped: boolean;
  /** Narrow the roster to one person. */
  onSelectOwner?: (ownerId: string) => void;
  /** Open one identity's profile — the card body's own action. */
  onOpenProfile?: (memberId: string) => void;
  className?: string;
}

/**
 * The compact lockup that heads one cluster: whose agents these are.
 *
 * Spans the whole grid row rather than living in a wrapper of its own — see the
 * note on `TeamRosterGrid` for why every cluster's header and cards are
 * siblings in one grid instead of a `<section>` each.
 */
function ClusterHeader({
  owner,
  onSelectOwner,
  ref,
}: {
  owner: TeamMember;
  onSelectOwner?: (ownerId: string) => void;
  /** Forwarded for `AnimatePresence mode="popLayout"` — see `TeamMemberCardProps.ref`. */
  ref?: Ref<HTMLHeadingElement>;
}) {
  const face = teamMemberFace(owner);
  // `col-span-full` is what makes a header a full-width row inside the shared
  // grid; `mt-3` reinstates the breathing room the old per-cluster `space-y-6`
  // used to provide, and `first:mt-0` keeps the first cluster flush with the
  // toolbar above it.
  const headingClass = 'col-span-full mt-3 flex min-w-0 items-center first:mt-0';

  const lockup = (
    <>
      <IdentityAvatar
        size="xs"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        imageUrl={face.imageUrl}
        fallback={face.fallback}
        origin={face.origin}
      />
      <span className="truncate text-sm font-medium">{owner.displayName}</span>
      <span className="text-muted-foreground truncate text-xs">{teamMemberLabel(owner)}</span>
    </>
  );

  // A heading wrapping a button, which is the WAI-ARIA APG's own shape for a
  // heading that is also a control (the accordion pattern). Putting
  // `role="heading"` on the button instead — one announcement rather than two —
  // is what `jsx-a11y/no-interactive-element-to-noninteractive-role` refuses,
  // and an ESLint error is not worth trading a standard pattern for.
  //
  // The button carries no `aria-label`: the heading takes its name from its
  // contents, so labelling the button would rename the heading to "Show only
  // Dorian and their agents", which is worse than the repetition it fixes.
  if (onSelectOwner) {
    return (
      <h2 ref={ref} className={headingClass}>
        <button
          type="button"
          onClick={() => onSelectOwner(owner.id)}
          className="focus-ring flex min-w-0 items-center gap-2 rounded"
        >
          {lockup}
        </button>
      </h2>
    );
  }

  return (
    <h2 ref={ref} className={cn(headingClass, 'gap-2')}>
      {lockup}
    </h2>
  );
}

/**
 * One unified grid of every identity, operator first.
 *
 * One grid rather than a People section above an Agents section: the shapes
 * already say which is which, and a section header would say it a second time
 * in words. Flipping to manager grouping re-clusters the same cards under the
 * person each belongs to — the person is the header, so nobody is drawn twice.
 *
 * The whole roster comes in beside the filtered rows because an owner may have
 * been filtered out of view while still being the answer to "whose is this".
 *
 * **Both arrangements are ONE flat list of grid children, and that is what
 * makes the cards travel.** Grouped, a cluster header is a `col-span-full` row
 * and its cards are the ordinary grid items that follow it — not a `<section>`
 * wrapping a nested grid, which is what this drew before. The reason is React,
 * not CSS: a card only animates to a new position if it stays the *same
 * component instance* across the change, and moving it into a per-cluster
 * wrapper unmounts it from one parent and mounts it under another. Same list,
 * same key, new index — so `layout="position"` interpolates, and flipping
 * Group-by-manager makes every card slide to its cluster.
 *
 * The spec's alternative was `layoutId`, which survives a change of parent and
 * so would not need this structure. This structure is preferred on its own
 * merits — no shared-layout bookkeeping, and React identity is the thing
 * actually being preserved — and `layoutId` was additionally measured to misfire
 * inside this `popLayout` list; see `TeamMemberCard`'s `LAYOUT_MOTION`.
 *
 * Nothing is lost in the accessibility tree. A `<section>` with no accessible
 * name is not exposed as a region at all, so the removed wrappers were never
 * announced; the `<h2>` headings did — and still do — all the structural work.
 *
 * **Grouping drops the people, and that is intended.** A cluster is headed by
 * its owner, so a person who owns agents becomes the header rather than a card
 * inside their own cluster — six cards flat can become four cards under three
 * headers. That has always been true of `groupTeamByOwner`; it is only newly
 * conspicuous now that the change is animated and you can watch the people
 * leave. The header still names them, still carries their face, and still
 * filters to them when pressed, so nobody is lost — only re-drawn.
 */
export function TeamRosterGrid({
  members,
  roster,
  grouped,
  onSelectOwner,
  onOpenProfile,
  className,
}: TeamRosterGridProps) {
  // One boolean, reported as `data-layout-animated` and passed to every card,
  // so the attribute cannot claim something the cards are not doing.
  //
  // `useReducedMotion` from `motion/react` rather than either of the two local
  // wrappers: it is the 37-call-site majority, and this file already imports
  // the library. It answers `null` when no preference has been read yet, which
  // is "nobody asked for less" — the same branch as `false` — so the comparison
  // against `true` is the honest narrowing rather than a truthiness shortcut.
  const prefersReducedMotion = useReducedMotion();
  const animated = shouldAnimateRoster({
    memberCount: members.length,
    reducedMotion: prefersReducedMotion === true,
  });

  // One flat child list for both arrangements — the structural decision the
  // whole travel depends on. See the note on this component for why.
  const cardFor = (member: TeamMember, withAttribution: boolean) => {
    // No attribution inside a cluster: the header above the cards already says
    // whose these are, and repeating it under every one would be the same
    // sentence N times.
    const owner = withAttribution ? findTeamOwner(member, roster) : undefined;
    return (
      <TeamMemberCard
        key={member.id}
        member={member}
        owner={owner}
        // Counted over the whole roster, not the filtered rows: the echo
        // previews what narrowing to this person would show, and a number that
        // shrank as you typed would describe the search instead of the person.
        ownedAgentCount={owner ? countOwnedAgents(owner.id, roster) : undefined}
        onSelectOwner={withAttribution ? onSelectOwner : undefined}
        onOpenProfile={onOpenProfile}
        layoutAnimated={animated}
      />
    );
  };

  const children = grouped
    ? groupTeamByOwner(members, roster).flatMap((group) => [
        group.owner ? (
          <ClusterHeader
            key={`cluster:${group.owner.id}`}
            owner={group.owner}
            onSelectOwner={onSelectOwner}
          />
        ) : (
          <h2
            key="cluster:__unowned"
            className="text-muted-foreground col-span-full mt-3 text-sm font-medium first:mt-0"
          >
            No owner
          </h2>
        ),
        ...group.members.map((member) => cardFor(member, false)),
      ])
    : members.map((member) => cardFor(member, true));

  return (
    <div
      data-slot={grouped ? 'team-roster-groups' : 'team-roster-grid'}
      // What the fleet tour spotlights. Stamped on the grid rather than on the
      // sidebar's Team button: the roster is the fleet the tour promised to
      // show, and it is on screen at every width.
      data-testid={TOUR_ANCHORS.teamRoster}
      data-layout-animated={String(animated)}
      className={cn(GRID, className)}
    >
      {/* `popLayout` pops an exiting card out of the layout flow, so the
          survivors close the gap around it instead of waiting for it to finish
          leaving. It only works because every child here forwards a ref — the
          mode writes `position: absolute` onto the exiting node, and with no
          ref to reach it does nothing at all, silently. Measured: without the
          ref an exiting card kept its grid slot and every survivor sat still
          for the length of the fade.

          `initial={false}` so the roster does not fade itself in on first
          paint; arriving cards only animate for changes you made. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {children}
      </AnimatePresence>
    </div>
  );
}
