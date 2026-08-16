/**
 * The profile's kebab — the rare stuff, and only the rare stuff (spec
 * `profile-unification` §1.2).
 *
 * **This component is the seam for W2.2's managed-agent actions.** Set as
 * default · Block · Unregister · Delete arrive here, around the Copy `@handle`
 * item that ships now; nothing above it changes, because `ProfileHeader` takes
 * the whole menu as a node and `ProfileView` is what fills it.
 *
 * @module features/profile/ui/ProfileActionsMenu
 */
import { toast } from 'sonner';
import { MoreVertical } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { useCopyFeedback } from '@/layers/shared/lib';
import {
  Button,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuTrigger,
} from '@/layers/shared/ui';

export interface ProfileActionsMenuProps {
  /** The identity the menu acts on. */
  member: TeamMember;
}

/**
 * Whether this identity has a kebab at all.
 *
 * With one item and nothing to put in it, the kebab is a button that opens a
 * menu saying nothing — so an identity with no handle and no other action
 * simply has no kebab (§1.2). W2.2's managed-agent actions widen this.
 */
function hasProfileActions(member: TeamMember): boolean {
  return member.handle !== null;
}

/**
 * The kebab menu for one identity.
 *
 * Renders nothing when there is nothing to offer, so the caller can place it
 * unconditionally.
 */
export function ProfileActionsMenu({ member }: ProfileActionsMenuProps) {
  const [, copy] = useCopyFeedback();

  if (!hasProfileActions(member)) return null;

  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label={`Actions for ${member.displayName}`}>
          <MoreVertical className="size-(--size-icon-xs)" />
        </Button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent align="end">
        <ResponsiveDropdownMenuItem
          onSelect={() => {
            copy(`@${member.handle}`);
            toast.success('Copied');
          }}
        >
          Copy @handle
        </ResponsiveDropdownMenuItem>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
