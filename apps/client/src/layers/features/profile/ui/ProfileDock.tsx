/**
 * The profile's docked home — the right-panel tab on a session (spec
 * `profile-unification` §1.6).
 *
 * The counterpart of `ProfileSheetContainer`: where the sheet is addressed by a
 * member id in the URL, the dock is bound to a DIRECTORY — the agent whose
 * session you are in, or the one you opened deliberately — and resolves the
 * identity from it. That is the whole reason this file exists rather than the
 * sheet's container growing a second mode.
 *
 * @module features/profile/ui/ProfileDock
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { useMeshAgentPaths, useMeshMemberId } from '@/layers/entities/mesh';
import { useTeamRoster } from '@/layers/entities/team';
import { useDockedAgentPath, useSessionAgent } from '../model/use-docked-agent';
import { useDockedEntries, useProfileStore } from '../model/profile-store';
import {
  popEntry,
  profileStack,
  pushEntry,
  stackMemberId,
  type ProfileStackEntry,
} from '../model/profile-stack';
import { hasUnsavedProfileEdits } from '../model/profile-leave-guard';
import type { ProfileScopeValue } from '../model/profile-scope';
import { DiscardChangesDialog } from './DiscardChangesDialog';
import { AgentNotFound, NoAgentSelected, ProfileDockSkeleton } from './ProfileDockStates';
import { ProfileView } from './ProfileView';

/**
 * Draw the docked profile for whichever agent the panel is pointed at.
 *
 * **The resolution chain** is directory → roster id → roster row (§1.6). Each
 * step can come up empty for a different reason, and only the last is worth an
 * error: a directory nobody picked is "no agent selected", a chain still
 * resolving is a skeleton, and a directory that settles with no identity behind
 * it is "agent not found".
 *
 * **There is no "keep the last agent painted" here, and there does not need to
 * be.** The Agent Hub held one, because it re-fetched a per-directory manifest
 * on every switch and would otherwise blank for that second. Both reads below
 * are shared caches the sidebar and every agent picker already keep warm, and
 * neither is per-agent — so switching sessions resolves the next identity out of
 * data already in hand, with no gap to paint over.
 *
 * **Two exits are deliberately not guarded.** Switching agents unmounts an
 * editor with the route already changed — a question whose only honest answer is
 * "yes" is a dead affordance, and the panel cannot cancel a navigation somebody
 * made in the sidebar. And on a phone the overlay unmounts this component as it
 * closes, so there is nobody left to ask; the page's own ‹ Profile is the
 * guarded exit there.
 */
export function ProfileDock() {
  const agentPath = useDockedAgentPath();
  const session = useSessionAgent();
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);

  // The fleet's path → id map is the honest join and the only one: an agent on
  // disk but absent from it has no roster row either, so a manifest read would
  // only tell us something we could not act on. Both reads here are ones the
  // sidebar and every agent picker already keep warm — the dock asks the server
  // for nothing of its own.
  const fleet = useMeshAgentPaths();
  const memberId = useMeshMemberId(agentPath ?? undefined);
  const roster = useTeamRoster({ enabled: memberId !== undefined });

  const members = roster.data?.members;
  const member = memberId === undefined ? undefined : members?.find((row) => row.id === memberId);

  // Nothing has answered yet, vs everything has answered with nothing. A
  // disabled roster read reports `isLoading: false`, so a directory the fleet
  // cannot name settles on "not found" rather than spinning forever.
  const settled = !fleet.isLoading && !roster.isLoading;

  const display = member ?? null;

  const entries = useDockedEntries(agentPath);
  const setDockedEntries = useProfileStore((s) => s.setDockedEntries);
  const clearDockedStacks = useProfileStore((s) => s.clearDockedStacks);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const releaseRightPanelRequest = useAppStore((s) => s.releaseRightPanelRequest);
  /** The panel has been closed over unsaved text, and has not been answered. */
  const [confirmingClose, setConfirmingClose] = useState(false);

  const stack = useMemo(
    () => (display ? profileStack(display.id, [...entries]) : null),
    [display, entries]
  );

  // Whose profile is actually on screen: the docked agent, or whoever has been
  // chained onto it — an owner, an agent it manages. The roster read is already
  // in hand, so a chained identity costs nothing extra; one it does not hold
  // falls back to the agent underneath rather than blanking the panel.
  const subjectId = stack === null ? null : stackMemberId(stack);
  const subject =
    (subjectId === display?.id ? display : members?.find((row) => row.id === subjectId)) ?? display;

  const handlePush = useCallback(
    (entry: ProfileStackEntry) => {
      if (!agentPath || !stack) return;
      setDockedEntries(agentPath, pushEntry(stack, entry).entries);
    },
    [agentPath, stack, setDockedEntries]
  );

  const handlePop = useCallback(() => {
    if (!agentPath || !stack) return;
    setDockedEntries(agentPath, popEntry(stack).entries);
  }, [agentPath, stack, setDockedEntries]);

  // A link naming an agent this install does not have has been answered, in the
  // only way it can be: there is nobody to draw. Nothing else can tell — a link
  // for an agent whose session you are not in is never bound by the layout
  // persistence at all, so its mark would otherwise outrank layouts, and its
  // explicit-pick latch would hold this panel on a dead directory, for the rest
  // of the session.
  useEffect(() => {
    if (agentPath === null || !settled || subject !== null) return;
    releaseRightPanelRequest(agentPath);
  }, [agentPath, settled, subject, releaseRightPanelRequest]);

  // Root on re-open (§1.6): the stack is memory for flipping between tabs while
  // the panel is open, not a place you left off.
  //
  // Armed only while the panel IS open, and cleared from the teardown, which is
  // what makes one rule cover three endings: the panel collapsing on a desktop
  // (this stays mounted, the effect re-runs), the overlay closing on a phone
  // (this unmounts), and a flip to another tab (this unmounts too — but the
  // panel is still open, which is why the teardown asks). Not armed while the
  // panel is closed, so a deep link that seeded a page and then lost a race
  // with the per-agent layout restore is not wiped before it is ever seen.
  //
  // Unless there is unsaved text on a pushed page, in which case closing the
  // panel is the same discard the page's ‹ Profile and the sheet's close both
  // stop to ask about — the toggle, Escape, a drag to the edge and ⌘⇧A all
  // arrive here as one closed panel, so one question covers them.
  // Read from a ref inside the teardown: the panel it belongs to is whichever
  // identity was on screen when the close happened, not whatever renders next.
  const scopeRef = useRef<ProfileScopeValue | null>(null);
  scopeRef.current = subject === null ? null : { home: 'docked', memberId: subject.id };

  useEffect(() => {
    if (!rightPanelOpen) return;
    return () => {
      if (useAppStore.getState().rightPanelOpen) return;
      if (hasUnsavedProfileEdits(scopeRef.current)) return setConfirmingClose(true);
      clearDockedStacks();
    };
  }, [rightPanelOpen, clearDockedStacks]);

  if (!agentPath) return <NoAgentSelected />;

  if (!display || !stack || !subject) {
    return settled ? <AgentNotFound agentPath={agentPath} /> : <ProfileDockSkeleton />;
  }

  return (
    <div data-slot="profile-dock" className="flex h-full min-h-0 flex-col overflow-hidden">
      <ProfileView
        member={subject}
        roster={members ?? []}
        home="docked"
        // The composer for this agent is a few pixels to the left, so a button
        // offering to take you to it is the surface arguing with itself. Only
        // true for the session's OWN agent, and only while the panel is on it:
        // a profile you opened deliberately, or chained onto this one, belongs
        // to someone else's conversation and Message is the way to get to it.
        inOwnSession={agentPath === session.agentPath && subject.id === display.id}
        stack={stack}
        onPush={handlePush}
        onPop={handlePop}
      />

      {/* Portalled, so it is asked even though the panel behind it has already
          collapsed to nothing — "Keep editing" is what puts that right. */}
      <DiscardChangesDialog
        open={confirmingClose}
        onKeep={() => {
          setConfirmingClose(false);
          setRightPanelOpen(true);
        }}
        onDiscard={() => {
          setConfirmingClose(false);
          clearDockedStacks();
        }}
      />
    </div>
  );
}
