/**
 * The account menu in the chrome — your face, bottom-left (spec
 * `identity-consistency` §W3.1).
 *
 * There was no user or account element anywhere in the app shell before this.
 * It sits as the first item in the sidebar footer's icon cluster, drawn at the
 * same size as its neighbours so it joins the row instead of re-laying it out.
 *
 * Presentational, split from {@link AccountMenuContainer} the same way
 * `ProfileView` is split from `ProfileSheetContainer`: this half is the menu,
 * that half decides who you are and what its three items do.
 *
 * @module features/profile/ui/AccountMenu
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  IdentityAvatar,
  identityMarkRing,
  IDENTITY_MARK_GROUP,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { teamMemberFace } from '@/layers/entities/team';
import { AccountMenuRows } from './AccountMenuRows';

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
          // Mark tier. It used to dim to 80% on hover — the universal idiom for
          // DISABLED — so your own face read as switched off the moment you
          // pointed at it. Your colour answers instead, on the disc, through the
          // named group, and a keyboard gets the identical ring.
          className={cn(
            IDENTITY_MARK_GROUP,
            'focus-ring rounded-md p-1 transition-[scale] duration-(--identity-press) ease-(--identity-ease-out) active:scale-[0.94]'
          )}
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
            className={identityMarkRing.group}
          />
        </button>
      </ResponsiveDropdownMenuTrigger>

      <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
        {/* The rows themselves live in `AccountMenuRows`, so a menu that already
            has a trigger of its own — the sidebar footer's `⋯` — can offer the
            identical account items without a second disc. */}
        <AccountMenuRows
          member={member}
          canSignOut={canSignOut}
          onViewProfile={onViewProfile}
          onOpenSettings={onOpenSettings}
          onSignOut={onSignOut}
        />
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
