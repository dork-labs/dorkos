/**
 * Manages — the agents that belong to one person, each a door into its own
 * profile (spec `profile-unification` §1.5).
 *
 * The other half of the header's "Managed by" line: one link, drawn both ways,
 * and both ends push onto the same stack.
 *
 * @module features/profile/ui/pages/ManagesPage
 */
import { ChevronRight } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { IdentityAvatar } from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';
import { profileStatusText } from '../../lib/profile-status';
import type { ProfilePageContentProps } from './types';

/** One agent in the list: face, name, what it is doing. */
function ManagedRow({ member, onOpen }: { member: TeamMember; onOpen: () => void }) {
  const face = teamMemberFace(member);
  const status = profileStatusText(member);

  return (
    <button
      type="button"
      onClick={onOpen}
      data-slot="profile-managed-row"
      className="focus-ring hover:bg-muted/50 flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors"
    >
      <IdentityAvatar
        size="sm"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        imageUrl={face.imageUrl}
        fallback={face.fallback}
        origin={face.origin}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{member.displayName}</span>
        <span className="text-muted-foreground truncate text-xs">{status.text}</span>
      </span>
      <ChevronRight aria-hidden className="text-muted-foreground/70 ml-auto size-3.5 shrink-0" />
    </button>
  );
}

/** Every agent this identity owns, in roster order. */
export function ManagesPage({ member, roster, onPush }: ProfilePageContentProps) {
  const managed = roster.filter((row) => row.kind === 'agent' && row.ownerId === member.id);

  if (managed.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {member.isSelf ? 'You manage' : `${member.displayName} manages`} no agents yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {managed.map((agent) => (
        <ManagedRow
          key={agent.id}
          member={agent}
          onOpen={() => onPush({ kind: 'profile', memberId: agent.id })}
        />
      ))}
    </div>
  );
}
