import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Badge, IdentityAvatar } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { platformLabel } from '@/layers/entities/room';
import { teamMemberFace, teamMemberLabel } from '@/layers/entities/team';

/**
 * The second line under a name: what is true of this identity and nothing else.
 *
 * An agent runs on something; a person is somewhere. Neither line is invented —
 * a person with no declared role says where they are rather than guessing at a
 * title, which is the honest version of the same sentence.
 *
 * Both names go through the same resolvers the rest of the cockpit uses —
 * `getRuntimeDescriptor` for a runtime, `platformLabel` for a platform — so a
 * person bridged in reads "On Telegram" here and everywhere else, rather than
 * the wire token this surface happens to hold.
 */
function secondaryLine(member: TeamMember): string {
  if (member.agent) {
    const runtime = getRuntimeDescriptor(member.agent.runtime).label;
    return member.agent.model ? `${runtime} · ${member.agent.model}` : runtime;
  }
  if (member.person?.role) return member.person.role;
  if (member.origin === 'local') return 'On this machine';
  return `On ${platformLabel(member.origin.platform)}`;
}

export interface TeamMemberCardProps {
  /** The identity this card draws. */
  member: TeamMember;
  /**
   * The person this identity belongs to, already resolved from the roster.
   *
   * Resolved by the caller rather than looked up here: a card that could reach
   * the whole roster is a card that starts making decisions about it, and the
   * attribution is the only thing on this surface that needs a second row.
   */
  owner?: TeamMember;
  /** Narrow the roster to one person — what the attribution and a person's own card do. */
  onSelectOwner?: (ownerId: string) => void;
  /**
   * Open this identity's profile. Wired, the whole card becomes the control
   * that does it; unwired, the card is the plain read-only tile it was.
   */
  onOpenProfile?: (memberId: string) => void;
  className?: string;
}

/**
 * One identity on the Team page: who it is, what it is, and who it belongs to.
 *
 * The disc is drawn from `kind` and nothing else — square and filled with a Bot
 * mark for an agent, a circle for a person, a platform mark for someone bridged
 * in from elsewhere — so this card cannot draw an agent as a person by
 * forgetting a prop. The face itself comes from the one shared resolver, which
 * falls back to a letter rather than inventing an emoji: "we don't know this
 * one's face" is a true thing to draw, and a confident-looking wrong face is not.
 *
 * **No liveness dot.** The roster carries `recentlyActive`, which means the mesh
 * heard from this agent within the hour — not that it is doing something right
 * now. The pulsing dot on the disc says "right now", so wiring the two together
 * would put a live signal on an agent that finished forty minutes ago. It is
 * drawn as words instead, where an hour-old fact reads as an hour-old fact.
 *
 * **And no health, deliberately.** `agent.healthStatus` is on the payload and is
 * drawn nowhere here: the difference between `stale` and `inactive` is a fact
 * about the mesh's last contact, which is what the topology view is for. A
 * roster answers "who is here", so it shows presence and stops — four states
 * per card would be a diagnostic panel wearing a roster's clothes.
 *
 * Nothing here branches on there being one person, and `isSelf` only decides
 * whether a chip is drawn (spec §W2.6) — a second person and a remote member
 * both arrive as more rows, not as another code path.
 *
 * **The whole card opens the profile, and the button is the name.** The name
 * carries an overlay pinned to the card's own box, so a press anywhere on the
 * tile lands on a real `<button>` a keyboard can reach and a screen reader can
 * announce — rather than a click handler on the `<article>`, which is neither.
 * It also settles the double-fire for free: the attribution control sits ABOVE
 * that overlay in the paint order, so pressing it never reaches the profile at
 * all and there is no propagation to stop.
 */
export function TeamMemberCard({
  member,
  owner,
  onSelectOwner,
  onOpenProfile,
  className,
}: TeamMemberCardProps) {
  const face = teamMemberFace(member);

  return (
    <article
      data-slot="team-member-card"
      data-member-id={member.id}
      className={cn(
        'bg-card shadow-soft relative flex items-start gap-3 rounded-lg border p-4',
        onOpenProfile && 'card-interactive',
        className
      )}
    >
      <IdentityAvatar
        size="md"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        imageUrl={face.imageUrl}
        fallback={face.fallback}
        origin={face.origin}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <h3 className="min-w-0 truncate text-sm font-medium">
            {onOpenProfile ? (
              // `after:` stretches this button's hit area over the whole card
              // (the `relative` article above is what it pins to). The visible
              // text names who; the label names what pressing it does, the same
              // split the attribution below already makes.
              <button
                type="button"
                onClick={() => onOpenProfile(member.id)}
                aria-label={`Open ${member.displayName}’s profile`}
                className="focus-ring max-w-full truncate rounded text-left after:absolute after:inset-0 after:rounded-lg after:content-['']"
              >
                {member.displayName}
              </button>
            ) : (
              member.displayName
            )}
          </h3>
          {/* A flag on a row, never a branch: the card is the same card. */}
          {member.isSelf && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[0.625rem]">
              you
            </Badge>
          )}
          {member.agent?.isDefault && (
            <Badge variant="outline" className="px-1.5 py-0 text-[0.625rem]">
              default
            </Badge>
          )}
        </div>
        {/* Absent rather than `@` — a handle nobody has is not a handle that
            reaches nobody, and an empty `@` is the second of those. */}
        {member.handle !== null && (
          <p data-slot="team-member-handle" className="text-muted-foreground truncate text-xs">
            @{member.handle}
          </p>
        )}
        <p className="text-muted-foreground mt-1.5 truncate text-xs">{secondaryLine(member)}</p>
        {member.agent?.recentlyActive && (
          <p className="text-muted-foreground mt-0.5 text-xs">Active in the last hour</p>
        )}
        {owner && onSelectOwner && (
          <button
            type="button"
            onClick={() => onSelectOwner(owner.id)}
            // The visible text names the owner; the label names what pressing
            // it does, which is the part a screen reader cannot infer from
            // "by @dorian".
            aria-label={`Show only ${owner.displayName} and their agents`}
            // `relative` lifts this above the name button's card-wide overlay:
            // positioned, and later in the DOM, so it paints on top and takes
            // its own press. Without it the overlay would swallow every click
            // here and the attribution would silently open a profile instead.
            className="text-muted-foreground hover:text-foreground focus-ring relative mt-1.5 max-w-full truncate rounded text-xs underline-offset-2 hover:underline"
          >
            by {teamMemberLabel(owner)}
          </button>
        )}
      </div>
    </article>
  );
}
