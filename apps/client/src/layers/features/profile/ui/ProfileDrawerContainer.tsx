/**
 * The profile drawer, connected to the roster and to the URL.
 *
 * Split from {@link ProfileDrawer} so the drawer itself stays presentational and
 * testable without a transport: this half answers "whose profile, read from
 * where, and what do its two actions do".
 *
 * @module features/profile/ui/ProfileDrawerContainer
 */
import { useCallback, useEffect } from 'react';
import { useProfileDeepLink, useSafeNavigate, useSettingsDeepLink } from '@/layers/shared/model';
import { useInteractionStore } from '@/layers/entities/interactions';
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
 * The roster read is gated on a profile actually being open on somebody, so a
 * route that never opens one never asks the server for it — and neither does a
 * store flag left true with no subject behind it.
 *
 * **Three ways to have no member, and they are not the same thing.** While the
 * read is in flight this draws nothing and waits. A read that *succeeded* and
 * does not hold the id means the identity is gone, so the link is cleared
 * rather than left riding the URL forever. A read that *failed* means we could
 * not look, which is not the same as "they are gone", so the link survives to
 * be retried.
 */
export function ProfileDrawerContainer({ open, onOpenChange }: ProfileDrawerContainerProps) {
  const { memberId, close } = useProfileDeepLink();
  const roster = useTeamRoster({ enabled: open && memberId !== null });
  const navigate = useSafeNavigate();
  const { open: openSettings } = useSettingsDeepLink();

  const data = roster.data;
  const member = data?.members.find((row) => row.id === memberId);

  // Self-heal a stale link. In an effect rather than at render because closing
  // navigates, and only on a settled, successful read — see the doc above.
  const isMissing = open && memberId !== null && roster.isSuccess && member === undefined;
  useEffect(() => {
    if (isMissing) close();
  }, [isMissing, close]);

  const handleOpenSession = useCallback(
    (projectPath: string) => {
      if (!navigate) return;
      // The /team roster's door into a conversation (DOR-1156). Only the AGENT
      // is recorded, and that is not a shortfall: this navigation names a
      // directory, not a session — which conversation it lands in is resolved
      // afterwards by `useDirectoryState`. The agent record is what the New
      // menu's "last used" and ⌘K's ranking read, and the session's own record
      // arrives the moment the operator writes in it.
      useInteractionStore.getState().recordOpened('agent', projectPath);
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
