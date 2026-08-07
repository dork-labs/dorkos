/**
 * The profile drawer, connected to the roster and to the URL.
 *
 * Split from {@link ProfileDrawer} so the drawer itself stays presentational and
 * testable without a transport: this half answers "whose profile, read from
 * where, and what do its two actions do".
 *
 * @module features/profile/ui/ProfileDrawerContainer
 */
import { useCallback } from 'react';
import { useProfileDeepLink, useSafeNavigate, useSettingsDeepLink } from '@/layers/shared/model';
import { findTeamOwner, useTeamRoster } from '@/layers/entities/team';
import { ProfileDrawer } from './ProfileDrawer';

/**
 * Where Edit lands: the Settings tab that owns editing your own identity
 * (spec §W3.3 — the tab DOR-979 adds, reached through the existing
 * `?settings=<tab>` machinery). Editing lives in Settings and viewing lives
 * here; this constant is the seam between the two.
 */
const PROFILE_SETTINGS_TAB = 'profile';

/** Open state, as `DialogHost` hands it to every registered dialog. */
export interface ProfileDrawerContainerProps {
  /** Whether either half of the profile signal is holding the drawer open. */
  open: boolean;
  /** Called when the drawer closes — clears both halves via `DialogHost`. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Resolve `?profile=<id>` against the roster and draw that identity.
 *
 * The roster read is gated on `open`, so a route that never opens a profile
 * never asks the server for one.
 *
 * An id the roster does not hold draws nothing rather than an empty panel —
 * a hand-typed or long-shared link to an identity that has since left the
 * install has nothing honest to say about it.
 */
export function ProfileDrawerContainer({ open, onOpenChange }: ProfileDrawerContainerProps) {
  const { memberId } = useProfileDeepLink();
  const { data } = useTeamRoster({ enabled: open });
  const navigate = useSafeNavigate();
  const { open: openSettings } = useSettingsDeepLink();

  const handleOpenSession = useCallback(
    (projectPath: string) => {
      if (!navigate) return;
      void navigate({ to: '/session', search: { dir: projectPath } });
    },
    [navigate]
  );

  // Opens Settings and leaves the drawer where it is, deliberately: both halves
  // are URL state, so closing the drawer first would be a second navigation
  // racing the first over the same search object — and coming back to the
  // profile you were reading is the better place to land after an edit anyway.
  const handleEdit = useCallback(() => {
    openSettings(PROFILE_SETTINGS_TAB);
  }, [openSettings]);

  const member = data?.members.find((row) => row.id === memberId);
  if (!member) return null;

  return (
    <ProfileDrawer
      member={member}
      owner={findTeamOwner(member, data?.members ?? [])}
      open={open}
      onOpenChange={onOpenChange}
      // No router, nowhere to send a session — the embed gets no dead button.
      onOpenSession={navigate ? handleOpenSession : undefined}
      onEdit={handleEdit}
    />
  );
}
