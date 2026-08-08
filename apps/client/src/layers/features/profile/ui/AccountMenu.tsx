/**
 * The account menu in the chrome — your face, bottom-left (spec
 * `identity-consistency` §W3.1).
 *
 * There was no user or account element anywhere in the app shell before this.
 * It sits as the first item in the sidebar footer's icon cluster, drawn at the
 * same size as its neighbours so it joins the row instead of re-laying it out.
 *
 * Presentational, split from {@link AccountMenuContainer} the same way
 * `ProfileDrawer` is split from its container: this half is the menu, that half
 * decides who you are and what its three items do.
 *
 * @module features/profile/ui/AccountMenu
 */
import { LogOut, Settings, UserRound } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  IdentityAvatar,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
} from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';

export interface AccountMenuProps {
  /** The operator's own roster row — the one with `isSelf`. */
  member: TeamMember;
  /**
   * Whether this install has a local account to sign out OF.
   *
   * Login is optional and off by default (ADR-0320), so on most installs there
   * is nothing to sign out of and the item is not drawn at all. A control that
   * does nothing is worse than a missing one: it invites a click and then has
   * to explain itself.
   */
  canSignOut: boolean;
  /** Open the profile drawer on this person's own row. */
  onViewProfile: () => void;
  /** Open Settings. */
  onOpenSettings: () => void;
  /** End the local session. Only ever called when {@link canSignOut} is true. */
  onSignOut: () => void;
}

/**
 * Your account, as a menu.
 *
 * `ResponsiveDropdownMenu` is what makes this work on a phone: a dropdown under
 * a pointer, a bottom drawer under a finger. On mobile the sidebar is itself a
 * sheet, so this opens a drawer inside a dialog — a composition used nowhere
 * else in the app and therefore checked in a real browser rather than assumed
 * (spec §W3.1).
 */
export function AccountMenu({
  member,
  canSignOut,
  onViewProfile,
  onOpenSettings,
  onSignOut,
}: AccountMenuProps) {
  const face = teamMemberFace(member);

  return (
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="account-menu-trigger"
          className="rounded-md p-1 transition-opacity duration-150 hover:opacity-80"
          aria-label={`Your account: ${member.displayName}`}
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
        </button>
      </ResponsiveDropdownMenuTrigger>

      <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
        {/* Not a `MenuLabel`: on mobile that renders as the drawer's title, and
            a name plus a handle plus a face is a block, not a title. */}
        <div className="flex items-center gap-2 px-2 py-2 md:py-1.5">
          <IdentityAvatar
            size="sm"
            kind={face.kind}
            color={face.color}
            emoji={face.emoji}
            imageUrl={face.imageUrl}
            fallback={face.fallback}
            origin={face.origin}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{member.displayName}</p>
            {/* Absent rather than a bare `@` — a handle nobody has reaches nobody. */}
            {member.handle !== null && (
              <p className="text-muted-foreground truncate text-xs">@{member.handle}</p>
            )}
          </div>
        </div>
        <ResponsiveDropdownMenuSeparator />
        <ResponsiveDropdownMenuItem icon={UserRound} onSelect={onViewProfile}>
          View profile
        </ResponsiveDropdownMenuItem>
        <ResponsiveDropdownMenuItem icon={Settings} onSelect={onOpenSettings}>
          Settings
        </ResponsiveDropdownMenuItem>
        {canSignOut && (
          <>
            <ResponsiveDropdownMenuSeparator />
            <ResponsiveDropdownMenuItem icon={LogOut} onSelect={onSignOut}>
              Sign out
            </ResponsiveDropdownMenuItem>
          </>
        )}
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
