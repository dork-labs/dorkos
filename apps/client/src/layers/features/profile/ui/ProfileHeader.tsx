/**
 * The Portrait — the top of every profile, in one fixed order (spec
 * `profile-unification` §1.2).
 *
 * face → name + badges → `@handle` → one status sentence → who it belongs to →
 * Message, with ⋯ beside it. Nothing else lives up here; everything else is a row.
 *
 * @module features/profile/ui/ProfileHeader
 */
import type { ReactNode } from 'react';
import { ChevronRight, Pencil } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import { Badge, Button, IdentityAvatar, IDENTITY_MARK_GROUP, PRESS_MARK } from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';
import { useAgentPause } from '@/layers/entities/mesh';
import type { ProfileRelationship } from '../lib/profile-relationship';
import { profileStatusText } from '../lib/profile-status';
import { profileFrameKey } from '../model/profile-stack';
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
  /**
   * Open a session with this identity. Omitted when there is nowhere to open
   * one — which is most identities today (`messageTarget` answers `null` for
   * every person, and for any agent the roster cannot place on disk).
   */
  onOpenSession?: () => void;
  /**
   * Open the face + personality picker.
   *
   * **The hook point for W2.2's Appearance page.** Until it is passed, the face
   * is plain art: a disc that offered a picker and opened nothing would be the
   * dead affordance this design exists to remove.
   */
  onFaceActivate?: () => void;
  /** The kebab's menu, beside Message. `ProfileView` fills it with `ProfileActionsMenu`. */
  actionsMenu?: ReactNode;
  /** How many of an agent's chats are mid-turn right now, for the status line. */
  runningChats?: number;
  /** Open the Handle page. Passed only where the viewer may rename this identity. */
  onEditHandle?: () => void;
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
  onOpenSession,
  onFaceActivate,
  actionsMenu,
  runningChats = 0,
  onEditHandle,
}: ProfileHeaderProps) {
  const { copied, failed, copy } = useCopyFeedback();
  const status = profileStatusText(member, new Date(), runningChats);
  // Paused everywhere (spec `audit-trail` PR5): a flag on the name row, like
  // `system` and `default`. Asked only of an agent.
  const pause = useAgentPause(member.agent?.manifestId ?? null);
  const ownerFace = owner ? teamMemberFace(owner) : null;

  function copyHandle() {
    if (member.handle === null) return;
    void copy(`@${member.handle}`);
  }

  /** What the button reads: the handle at rest, "Copied", or the failure. */
  function handleButtonLabel(): string {
    if (copied) return 'Copied';
    if (failed) return 'Couldn’t copy';
    return `@${member.handle}`;
  }

  return (
    // `pt-8` clears the chrome row the sheet puts in this corner (its close X)
    // so the face is never crowded by a control that is not about the identity.
    <div data-slot="profile-header" className="relative flex flex-col items-center px-4 pt-8 pb-4">
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

      {onFaceActivate ? (
        <button
          type="button"
          onClick={onFaceActivate}
          aria-label={`Change ${member.displayName}’s face and personality`}
          // Where focus comes back to when the Appearance page is popped, found
          // by the destination it pushed exactly as a `nav` row is
          // (`ProfileStack`). The face is a control that pushes a page, so it is
          // restored the same way one is. Pinned by `ProfileView.test.tsx`.
          data-profile-return="appearance"
          className={cn(IDENTITY_MARK_GROUP, 'focus-ring relative rounded-2xl', PRESS_MARK)}
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
          <Badge size="xs" variant="secondary">
            you
          </Badge>
        )}
        {member.agent?.isSystem && (
          <Badge size="xs" variant="outline">
            system
          </Badge>
        )}
        {member.agent?.isDefault && (
          <Badge size="xs" variant="outline">
            default
          </Badge>
        )}
        {pause && (
          <Badge size="xs" variant="secondary" data-testid="profile-paused-badge">
            paused
          </Badge>
        )}
      </div>

      {/* The handle, which copies on tap, and beside it a quiet pencil that
          opens the Handle page on an agent you manage (DOR-3156). The pencil
          is absolutely placed so the handle stays optically centred; it
          shows on hover and focus, and always where touch is the pointer.
          Absent rather than a bare `@` — an empty handle reaches nobody. */}
      {(member.handle !== null || onEditHandle) && (
        <span className="group/handle relative inline-flex max-w-full items-center">
          {member.handle !== null && (
            <button
              type="button"
              onClick={copyHandle}
              aria-label={failed ? 'Couldn’t copy @handle. Try again' : 'Copy @handle'}
              className={cn(
                'focus-ring max-w-full truncate rounded-sm px-1 text-xs transition-colors',
                failed ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {handleButtonLabel()}
            </button>
          )}
          {onEditHandle && (
            <button
              type="button"
              onClick={onEditHandle}
              aria-label={member.handle === null ? 'Add a handle' : 'Change @handle'}
              // Focus comes back here when the Handle page is popped, as a
              // nav row's does (`ProfileStack`).
              data-profile-return="handle"
              className={cn(
                'focus-ring text-muted-foreground hover:text-foreground hover:bg-accent grid size-6 place-items-center rounded-md',
                'opacity-0 transition-opacity duration-150 group-hover/handle:opacity-100 focus-visible:opacity-100',
                'motion-reduce:transition-none pointer-coarse:size-11 pointer-coarse:opacity-100',
                member.handle !== null && 'absolute top-1/2 left-full -translate-y-1/2'
              )}
            >
              <Pencil aria-hidden className="size-3.5" />
            </button>
          )}
        </span>
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
            // Tagged with the frame it pushes, so popping the owner's profile
            // puts focus back here — the same restore a nav row gets.
            data-profile-return={profileFrameKey(owner.id)}
            className="focus-ring bg-muted/60 hover:bg-muted mt-2 flex max-w-full items-center gap-1.5 rounded-full py-0.5 pr-1.5 pl-0.5 text-xs transition-colors"
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
              className="text-3xs size-4"
            />
            {/* The owner's NAME, not their handle. The line names a person the
                way the portrait above names one — `teamMemberLabel` would read
                "Managed by @priya", which is an address, not who they are. */}
            <span className="truncate">Managed by {owner.isSelf ? 'You' : owner.displayName}</span>
            {/* The pill pushes their profile, so it wears the same promise a
                `nav` row does (design 05, state 5). */}
            <ChevronRight aria-hidden className="text-muted-foreground/70 size-3 shrink-0" />
          </button>
        )
      )}

      {/* One primary action, and the rare ones beside it. "Message" is honest
          again: the button opens the agent's one Direct chat with you, or what
          it is doing in the room you are in (DOR-2997). The kebab left the top
          corner, so the sheet's close X is the only control up there. */}
      {(onOpenSession || actionsMenu) && (
        <div className="mt-3 flex w-full max-w-74 items-center justify-center gap-2">
          {onOpenSession && (
            <Button size="sm" className="flex-1 max-md:h-11" onClick={onOpenSession}>
              Message
            </Button>
          )}
          {actionsMenu}
        </div>
      )}
    </div>
  );
}
