/**
 * The account menu, connected to who you actually are.
 *
 * Split from {@link AccountMenu} for the reason the profile drawer is split:
 * the menu stays presentational and testable without a transport, and this half
 * answers "whose face is that, and what do its items do".
 *
 * @module features/profile/ui/AccountMenuContainer
 */
import { useCallback } from 'react';
import { useProfileDeepLink, useSettingsDeepLink } from '@/layers/shared/model';
import { useTeamRoster } from '@/layers/entities/team';
import { useCurrentUser, useSignOut } from '@/layers/features/auth';
import { AccountMenu } from './AccountMenu';

/**
 * Draw the operator's own face in the sidebar footer, with their menu behind it.
 *
 * **Nothing is drawn until the roster names somebody.** A disc with no identity
 * behind it is a control that cannot do its job: the menu's whole content is
 * your name, your handle and your own profile. That also means the Obsidian
 * embed — whose roster is empty by construction — gets no dead button, the same
 * choice `ProfileDrawerContainer` makes about its session action.
 *
 * The roster read is unconditional here rather than gated, and it costs nothing
 * extra: it shares one cache entry with the Team page and the profile drawer
 * (`TEAM_ROSTER_KEY`), so the sidebar asking for it once is the request those
 * surfaces would otherwise each make.
 */
export function AccountMenuContainer() {
  const roster = useTeamRoster();
  const { open: openProfile } = useProfileDeepLink();
  const { open: openSettings } = useSettingsDeepLink();
  const currentUser = useCurrentUser();
  const signOut = useSignOut();

  const self = roster.data?.members.find((member) => member.isSelf);

  const handleViewProfile = useCallback(() => {
    if (self) openProfile(self.id);
  }, [self, openProfile]);

  const handleOpenSettings = useCallback(() => openSettings(), [openSettings]);

  const handleSignOut = useCallback(() => {
    void signOut.run();
  }, [signOut]);

  if (!self) return null;

  return (
    <AccountMenu
      member={self}
      // Login is optional and off by default (ADR-0320). No account, no session
      // to end — so the item is absent rather than present and inert.
      canSignOut={currentUser !== null}
      onViewProfile={handleViewProfile}
      onOpenSettings={handleOpenSettings}
      onSignOut={handleSignOut}
    />
  );
}
