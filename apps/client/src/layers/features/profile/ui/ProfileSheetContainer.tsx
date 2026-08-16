/**
 * The profile as a right sheet — its home everywhere except inside the session
 * it is about (spec `profile-unification` §1.6).
 *
 * Split from {@link ProfileView} so the view itself stays about identities:
 * this half answers "whose profile, read from where, which page, and which home
 * should answer at all".
 *
 * @module features/profile/ui/ProfileSheetContainer
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useProfileDeepLink, useSafePathname } from '@/layers/shared/model';
import { useTeamRoster } from '@/layers/entities/team';
import { shouldDock } from '../model/profile-home';
import { asProfilePageId, profileStack, type ProfileStackEntry } from '../model/profile-stack';
import { ProfileSheet } from './ProfileSheet';

/** Open state, as `DialogHost` hands it to every registered dialog. */
export interface ProfileSheetContainerProps {
  /** Whether either half of the profile signal is holding the sheet open. */
  open: boolean;
  /** Called when the sheet closes — clears both halves via `DialogHost`. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Resolve `?profile=<id>&profilePage=<page>` against the roster and draw it.
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
 *
 * **The address rule** (§1.6): a link to the agent whose session you are
 * already in belongs in the right panel, not in a sheet over the conversation.
 * The dock is W2.3's, so today {@link shouldDock} is asked with no session
 * agent to compare against and always answers "sheet" — which is exactly
 * today's behaviour. W2.3 fills `sessionAgentMemberId` and hands over a real
 * dock action; nothing else here changes.
 */
export function ProfileSheetContainer({ open, onOpenChange }: ProfileSheetContainerProps) {
  const { memberId, page, open: openProfile, setPage, close } = useProfileDeepLink();
  const roster = useTeamRoster({ enabled: open && memberId !== null });
  const pathname = useSafePathname();

  const data = roster.data;
  const member = data?.members.find((row) => row.id === memberId);

  // Self-heal a stale link. In an effect rather than at render because closing
  // navigates, and only on a settled, successful read — see the doc above.
  const isMissing = open && memberId !== null && roster.isSuccess && member === undefined;
  useEffect(() => {
    if (isMissing) close();
  }, [isMissing, close]);

  const stack = useMemo(() => {
    if (memberId === null) return null;
    const pageId = asProfilePageId(page);
    return profileStack(memberId, pageId ? [{ kind: 'page', page: pageId }] : []);
  }, [memberId, page]);

  const handlePush = useCallback(
    (entry: ProfileStackEntry) => {
      // A chained profile rewrites the subject rather than growing the stack:
      // the sheet's whole stack is the URL, and `?profile=` IS the subject. The
      // push puts it in history, so Back walks the chain the way it came.
      if (entry.kind === 'profile') return openProfile(entry.memberId);
      setPage(entry.page);
    },
    [openProfile, setPage]
  );

  const handlePop = useCallback(() => setPage(null), [setPage]);

  // The docked home does not exist yet (W2.3), so there is nowhere to send a
  // link the address rule would dock — and a rule that routed to nothing would
  // be worse than the sheet it replaced.
  const docked =
    memberId !== null && shouldDock(memberId, { pathname, sessionAgentMemberId: null });

  if (!member || !stack || docked) return null;

  return (
    <ProfileSheet
      open={open}
      onOpenChange={onOpenChange}
      member={member}
      roster={data?.members ?? []}
      stack={stack}
      onPush={handlePush}
      onPop={handlePop}
    />
  );
}
