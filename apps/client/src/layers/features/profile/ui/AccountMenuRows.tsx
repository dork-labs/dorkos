/**
 * Your account, as menu ROWS — the identity block and the three things you can
 * do with it, without the disc that opens them.
 *
 * Split out of {@link AccountMenu} so the same rows can live in somebody else's
 * menu. The sidebar footer is one slim strip now (spec
 * `sidebar-now-today-library` BC-47) and a seventh control in that row is not a
 * matter of taste: measured in a real 272px panel, adding the face made the row
 * overflow (`scrollWidth` 281 against a 256 box) and pushed its controls onto
 * three different baselines. So the footer folds these rows into its `⋯` menu
 * instead, and `AccountMenu` — the disc — keeps them for wherever a trigger of
 * its own is the right shape (BC-43 gives the header block one).
 *
 * @module features/profile/ui/AccountMenuRows
 */
import { LogOut, Settings, UserRound } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  IdentityAvatar,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuSeparator,
} from '@/layers/shared/ui';
import { nameProvenanceNote, teamMemberFace } from '@/layers/entities/team';

/** Props for {@link AccountMenuRows}. */
export interface AccountMenuRowsProps {
  /** The operator's own roster row — the one with `isSelf`. */
  member: TeamMember;
  /**
   * Whether this install has a local account to sign out OF.
   *
   * Login is optional and off by default (ADR-0320), so on most installs there
   * is nothing to sign out of and the item is not drawn at all.
   */
  canSignOut: boolean;
  /** Open the profile drawer on this person's own row. */
  onViewProfile: () => void;
  /** Open Settings. */
  onOpenSettings: () => void;
  /** End the local session. Only ever called when {@link canSignOut} is true. */
  onSignOut: () => void;
  /**
   * Whether to draw the Settings row. Default true.
   *
   * `false` is for a menu that already offers Settings of its own — the sidebar
   * footer's `⋯`, which renders the `sidebar.footer` slot's built-in Settings
   * button right below these rows. Two rows into one dialog is one row too many.
   */
  showSettings?: boolean;
  /**
   * Draw "View profile", or leave it out for a menu whose surface already
   * offers the profile drawer somewhere else.
   *
   * The sidebar's footer fold is that case: BC-43 gives "Account" a home in the
   * header block, so the fold keeps the identity it displays and the sign-out
   * only it offers, and yields the door.
   */
  showViewProfile?: boolean;
}

/**
 * The account rows, for a menu the caller owns.
 *
 * A fragment on purpose: the caller decides the surrounding chrome — its own
 * separators, and whether these sit at the top of its menu or below its own
 * rows.
 *
 * @param props - Who you are and what the three items do.
 */
export function AccountMenuRows({
  member,
  canSignOut,
  onViewProfile,
  onOpenSettings,
  onSignOut,
  showSettings = true,
  showViewProfile = true,
}: AccountMenuRowsProps) {
  const face = teamMemberFace(member);
  const suggestedName = nameProvenanceNote(member);

  return (
    <>
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
          {/* This menu is the "who am I" surface, so a name an agent proposed
              says so here too (DOR-1022). Below the handle: the handle is how
              somebody reaches you, and this is a note about the line above it. */}
          {suggestedName && (
            <p
              data-slot="account-menu-name-source"
              className="text-muted-foreground truncate text-xs"
            >
              {suggestedName}
            </p>
          )}
        </div>
      </div>
      <ResponsiveDropdownMenuSeparator />
      {showViewProfile && (
        <ResponsiveDropdownMenuItem icon={UserRound} onSelect={onViewProfile}>
          View profile
        </ResponsiveDropdownMenuItem>
      )}
      {showSettings && (
        <ResponsiveDropdownMenuItem icon={Settings} onSelect={onOpenSettings}>
          Settings
        </ResponsiveDropdownMenuItem>
      )}
      {canSignOut && (
        <>
          <ResponsiveDropdownMenuSeparator />
          <ResponsiveDropdownMenuItem icon={LogOut} onSelect={onSignOut}>
            Sign out
          </ResponsiveDropdownMenuItem>
        </>
      )}
    </>
  );
}
