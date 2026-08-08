import type { TeamMember } from '@dorkos/shared/team-schemas';
import { IdentityAvatar } from '@/layers/shared/ui';
import { cn, resolveIdentityFace } from '@/layers/shared/lib';
import { findTeamOwner, groupTeamByOwner, teamMemberLabel } from '@/layers/entities/team';
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

/** The compact lockup that heads one cluster: whose agents these are. */
function ClusterHeader({
  owner,
  onSelectOwner,
}: {
  owner: TeamMember;
  onSelectOwner?: (ownerId: string) => void;
}) {
  const face = resolveIdentityFace({
    record: {
      id: owner.id,
      kind: owner.kind,
      displayName: owner.displayName,
      ...(owner.emoji ? { emoji: owner.emoji } : {}),
      ...(owner.color ? { color: owner.color } : {}),
    },
    origin: owner.origin,
  });

  const lockup = (
    <>
      <IdentityAvatar
        size="xs"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
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
      <h2 className="flex min-w-0 items-center">
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

  return <h2 className="flex min-w-0 items-center gap-2">{lockup}</h2>;
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
 */
export function TeamRosterGrid({
  members,
  roster,
  grouped,
  onSelectOwner,
  onOpenProfile,
  className,
}: TeamRosterGridProps) {
  if (!grouped) {
    return (
      <div data-slot="team-roster-grid" className={cn(GRID, className)}>
        {members.map((member) => (
          <TeamMemberCard
            key={member.id}
            member={member}
            owner={findTeamOwner(member, roster)}
            onSelectOwner={onSelectOwner}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </div>
    );
  }

  const groups = groupTeamByOwner(members, roster);

  return (
    <div data-slot="team-roster-groups" className={cn('space-y-6', className)}>
      {groups.map((group) => (
        <section key={group.owner?.id ?? '__unowned'} className="space-y-3">
          {group.owner ? (
            <ClusterHeader owner={group.owner} onSelectOwner={onSelectOwner} />
          ) : (
            <h2 className="text-muted-foreground text-sm font-medium">No owner</h2>
          )}
          <div className={GRID}>
            {group.members.map((member) => (
              // No attribution inside a cluster: the header above the cards
              // already says whose these are, and repeating it under every one
              // would be the same sentence N times.
              <TeamMemberCard key={member.id} member={member} onOpenProfile={onOpenProfile} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
