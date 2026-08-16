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
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useProfileDeepLink, useSafePathname } from '@/layers/shared/model';
import { useTeamRoster } from '@/layers/entities/team';
import { shouldDock } from '../model/profile-home';
import { useProfileStore } from '../model/profile-store';
import { useSessionAgent } from '../model/use-docked-agent';
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
 * {@link shouldDock} decides; when it says dock, the link is handed to the
 * docked home and taken back off the URL — the panel is not an address, so a
 * `?profile=` that has been answered by it has nothing left to describe.
 */
export function ProfileSheetContainer({ open, onOpenChange }: ProfileSheetContainerProps) {
  const { memberId, page, open: openProfile, setPage, close } = useProfileDeepLink();
  const roster = useTeamRoster({ enabled: open && memberId !== null });
  const pathname = useSafePathname();
  const session = useSessionAgent();
  const openProfileDocked = useProfileStore((s) => s.openProfileDocked);
  const chain = useProfileStore((s) => s.sheetChain);
  const pushSheetChain = useProfileStore((s) => s.pushSheetChain);
  const popSheetChain = useProfileStore((s) => s.popSheetChain);
  const clearSheetChain = useProfileStore((s) => s.clearSheetChain);

  const data = roster.data;
  const member = data?.members.find((row) => row.id === memberId);

  // Self-heal a stale link. In an effect rather than at render because closing
  // navigates, and only on a settled, successful read — see the doc above.
  const isMissing = open && memberId !== null && roster.isSuccess && member === undefined;
  useEffect(() => {
    if (isMissing) close();
  }, [isMissing, close]);

  // The chain as of this render, readable from the reconcile below without
  // making it re-run every time the chain moves — which is the whole point of
  // that effect only reacting to the URL.
  const chainRef = useRef(chain);
  chainRef.current = chain;
  /**
   * The subject the last change here was already accounted for. Starts at
   * `null` rather than at the first subject, so a chain left over from a sheet
   * that was never properly closed is reconciled on the very first render
   * instead of surviving until the next one.
   */
  const seen = useRef<string | null>(null);
  /** The subject this panel just navigated to itself, so it is not a surprise. */
  const expected = useRef<string | null>(null);

  // Keep the chain honest against the URL, which anything can move.
  //
  // Only when the URL's subject actually CHANGES, and only from the value it
  // held before: this panel writes the chain a render before its own navigation
  // lands, so a rule that compared the chain against the URL every render would
  // undo its own writes in that gap. Three ways the subject can change, and they
  // are not the same thing: this panel moved it (already accounted for), the
  // browser walked back down the same history the chain describes (shorten it),
  // or something else opened an unrelated profile over the top (start again,
  // rather than offer a way "back" to somebody unrelated).
  useEffect(() => {
    if (seen.current === memberId) return;
    seen.current = memberId;
    if (memberId === null) return clearSheetChain();
    if (expected.current === memberId) {
      expected.current = null;
      return;
    }
    if (chainRef.current.at(-1) === memberId) popSheetChain();
    else if (chainRef.current.length > 0) clearSheetChain();
  }, [memberId, popSheetChain, clearSheetChain]);

  const stack = useMemo(() => {
    if (memberId === null) return null;
    const pageId = asProfilePageId(page);
    // The chain is everything under the subject; the subject itself is the last
    // profile entry, so the view can see there is somewhere to go back to.
    const entries: ProfileStackEntry[] = chain
      .slice(1)
      .map((id) => ({ kind: 'profile', memberId: id }));
    if (chain.length > 0) entries.push({ kind: 'profile', memberId });
    if (pageId) entries.push({ kind: 'page', page: pageId });
    return profileStack(chain[0] ?? memberId, entries);
  }, [memberId, page, chain]);

  const handlePush = useCallback(
    (entry: ProfileStackEntry) => {
      // A chained profile rewrites the subject rather than growing the URL: the
      // sheet's address is `?profile=`, and that IS the subject. The push puts it
      // in history, so browser Back walks the chain the way it came; the chain
      // below is what lets the panel draw its own way back too.
      if (entry.kind === 'profile') {
        if (memberId !== null) pushSheetChain(memberId);
        expected.current = entry.memberId;
        return openProfile(entry.memberId);
      }
      setPage(entry.page);
    },
    [openProfile, setPage, pushSheetChain, memberId]
  );

  const handlePop = useCallback(() => {
    // A page comes off first: one step at a time, whatever is underneath.
    if (asProfilePageId(page) !== null) return setPage(null);
    const previous = chain.at(-1);
    if (previous === undefined) return;
    popSheetChain();
    expected.current = previous;
    openProfile(previous);
  }, [page, setPage, chain, popSheetChain, openProfile]);

  const docked =
    memberId !== null && shouldDock(memberId, { pathname, sessionAgentMemberId: session.memberId });

  // Hand the link to the panel and clear it. In an effect for the same reason
  // the self-heal above is: both navigate, and neither may run during render.
  const dockPath = docked ? session.agentPath : null;
  const dockPage = asProfilePageId(page) ?? undefined;
  useEffect(() => {
    if (dockPath === null) return;
    openProfileDocked(dockPath, dockPage);
    close();
  }, [dockPath, dockPage, openProfileDocked, close]);

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
