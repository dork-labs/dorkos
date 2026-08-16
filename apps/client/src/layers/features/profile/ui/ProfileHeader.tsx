/**
 * The Portrait — the top of every profile, in one fixed order (spec
 * `profile-unification` §1.2).
 *
 * face → name + badges → `@handle` → one status sentence → who it belongs to →
 * one button. Nothing else lives up here; everything else is a row.
 *
 * @module features/profile/ui/ProfileHeader
 */
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import { Badge, Button, IdentityAvatar, IDENTITY_MARK_GROUP } from '@/layers/shared/ui';
import { teamMemberFace, teamMemberLabel } from '@/layers/entities/team';
import type { ProfileRelationship } from '../lib/profile-relationship';
import { profileStatusText } from '../lib/profile-status';
import { ProfileFace } from './ProfileFace';

export interface ProfileHeaderProps {
  /** The identity this profile is about. */
  member: TeamMember;
  /** What it is to you. */
  relationship: ProfileRelationship;
  /** The person it belongs to, already resolved from the roster. */
  owner?: TeamMember;
  /** Push the owner's profile. Drawn only when there is an owner to push. */
  onOpenOwner?: () => void;
  /** Send a message. Omitted when there is nowhere for one to go. */
  onMessage?: () => void;
  /**
   * Open the face + personality picker.
   *
   * **The hook point for W2.2's Appearance page.** Until it is passed, the face
   * is plain art: a disc that offered a picker and opened nothing would be the
   * dead affordance this design exists to remove.
   */
  onFaceActivate?: () => void;
  /** The kebab's menu. `ProfileView` fills it with `ProfileActionsMenu`. */
  actionsMenu?: ReactNode;
}

/**
 * Draw the portrait.
 *
 * **The face never carries the live signal.** A ring or a pulsing dot on the
 * disc would say "right now" about a fact that is often an hour old, so the
 * status sentence says it in words and a 7px dot before it is the only live
 * indicator the profile spends (identity-micro-interactions §3D).
 */
export function ProfileHeader({
  member,
  relationship,
  owner,
  onOpenOwner,
  onMessage,
  onFaceActivate,
  actionsMenu,
}: ProfileHeaderProps) {
  const [, copy] = useCopyFeedback();
  const status = profileStatusText(member);
  const ownerFace = owner ? teamMemberFace(owner) : null;

  function copyHandle() {
    if (member.handle === null) return;
    copy(`@${member.handle}`);
    toast.success('Copied');
  }

  return (
    <div data-slot="profile-header" className="relative flex flex-col items-center px-4 pt-5 pb-4">
      {/* The identity's own colour, as a wash behind the face rather than as a
          ring on it. Static: this is the panel's "whose this is" moment, and the
          calm version of that does not move to say so (§3D4). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-70 dark:opacity-100"
        style={{
          background:
            'radial-gradient(ellipse 60% 100% at 50% 0%, color-mix(in oklch, var(--identity-color) 22%, transparent), transparent 70%)',
        }}
      />

      {actionsMenu && <div className="absolute top-2 right-2 z-10">{actionsMenu}</div>}

      {onFaceActivate ? (
        <button
          type="button"
          onClick={onFaceActivate}
          aria-label={`Change ${member.displayName}’s face and personality`}
          className={cn(IDENTITY_MARK_GROUP, 'focus-ring relative rounded-2xl active:scale-[0.94]')}
        >
          <ProfileFace member={member} size="lg" />
        </button>
      ) : (
        <ProfileFace member={member} size="lg" className="relative" />
      )}

      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1">
        <h2 className="text-center text-base font-semibold">{member.displayName}</h2>
        {/* Flags on a row, never branches: the portrait is the same portrait. */}
        {member.isSelf && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[0.625rem]">
            you
          </Badge>
        )}
        {member.agent?.isSystem && (
          <Badge variant="outline" className="px-1.5 py-0 text-[0.625rem]">
            system
          </Badge>
        )}
        {member.agent?.isDefault && (
          <Badge variant="outline" className="px-1.5 py-0 text-[0.625rem]">
            default
          </Badge>
        )}
      </div>

      {/* Absent rather than a bare `@` — an empty handle reaches nobody. */}
      {member.handle !== null && (
        <button
          type="button"
          onClick={copyHandle}
          aria-label="Copy @handle"
          className="focus-ring text-muted-foreground hover:text-foreground max-w-full truncate rounded-sm px-1 text-xs transition-colors"
        >
          @{member.handle}
        </button>
      )}

      <p className="mt-1 flex max-w-full items-center gap-1.5 text-xs">
        <span
          aria-hidden
          data-slot="profile-status-dot"
          data-live={status.live ? 'true' : undefined}
          className={cn(
            'size-[7px] shrink-0 rounded-full',
            status.live ? 'bg-status-success' : 'bg-muted-foreground/40'
          )}
        />
        <span className="text-muted-foreground truncate">{status.text}</span>
      </p>

      {relationship === 'system' ? (
        <p className="text-muted-foreground mt-2 text-xs">System agent</p>
      ) : (
        owner &&
        ownerFace &&
        onOpenOwner && (
          <button
            type="button"
            onClick={onOpenOwner}
            className="focus-ring bg-muted/60 hover:bg-muted mt-2 flex max-w-full items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-0.5 text-xs transition-colors"
          >
            <IdentityAvatar
              size="xs"
              kind={ownerFace.kind}
              color={ownerFace.color}
              emoji={ownerFace.emoji}
              imageUrl={ownerFace.imageUrl}
              fallback={ownerFace.fallback}
              origin={ownerFace.origin}
              badge={null}
              className="size-4 text-[0.5rem]"
            />
            <span className="truncate">
              Managed by {owner.isSelf ? 'You' : teamMemberLabel(owner)}
            </span>
          </button>
        )
      )}

      {onMessage && (
        <Button size="sm" className="mt-3 w-full max-w-64" onClick={onMessage}>
          Message
        </Button>
      )}
    </div>
  );
}
