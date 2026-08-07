import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Badge } from '@/layers/shared/ui';
import { IdentityAvatar } from '@/layers/shared/ui';
import { cn, resolveIdentityFace } from '@/layers/shared/lib';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { teamMemberLabel } from '@/layers/entities/team';

/**
 * The second line under a name: what is true of this identity and nothing else.
 *
 * An agent runs on something; a person is somewhere. Neither line is invented —
 * a person with no declared role says where they are rather than guessing at a
 * title, which is the honest version of the same sentence.
 */
function secondaryLine(member: TeamMember): string {
  if (member.agent) {
    const runtime = getRuntimeDescriptor(member.agent.runtime).label;
    return member.agent.model ? `${runtime} · ${member.agent.model}` : runtime;
  }
  if (member.person?.role) return member.person.role;
  return member.origin === 'local' ? 'On this machine' : `On ${member.origin.platform}`;
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
 * Nothing here branches on there being one person, and `isSelf` only decides
 * whether a chip is drawn (spec §W2.6) — a second person and a remote member
 * both arrive as more rows, not as another code path.
 */
export function TeamMemberCard({ member, owner, onSelectOwner, className }: TeamMemberCardProps) {
  const face = resolveIdentityFace({
    record: {
      id: member.id,
      kind: member.kind,
      displayName: member.displayName,
      ...(member.emoji ? { emoji: member.emoji } : {}),
      ...(member.color ? { color: member.color } : {}),
    },
    origin: member.origin,
  });

  return (
    <article
      data-slot="team-member-card"
      data-member-id={member.id}
      className={cn('bg-card shadow-soft flex items-start gap-3 rounded-lg border p-4', className)}
    >
      <IdentityAvatar
        size="md"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        fallback={face.fallback}
        origin={face.origin}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <h3 className="truncate text-sm font-medium">{member.displayName}</h3>
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
            className="text-muted-foreground hover:text-foreground focus-ring mt-1.5 max-w-full truncate rounded text-xs underline-offset-2 hover:underline"
          >
            by {teamMemberLabel(owner)}
          </button>
        )}
      </div>
    </article>
  );
}
