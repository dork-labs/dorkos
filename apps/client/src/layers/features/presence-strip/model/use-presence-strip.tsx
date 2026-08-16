/**
 * The strip, packaged as a slot its host can ask a question of.
 *
 * @module features/presence-strip/model/use-presence-strip
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useProfileDeepLink } from '@/layers/shared/model';
import { useInteractionStore } from '@/layers/entities/interactions';
import { PresenceStrip } from '../ui/PresenceStrip';
import type { PresenceFollowTarget } from '../lib/presence-rows';
import { usePresenceRows } from './use-presence-rows';

/**
 * The strip and whether it will draw anything.
 *
 * Two fields rather than a bare node, because a node cannot be asked. A strip
 * that decided to render nothing looks exactly like one about to fill a line,
 * and the difference decides whether an otherwise idle cockpit shows an empty
 * bordered box or no header at all.
 *
 * Structurally the pinned header's own `TriagePresenceSlot`, and deliberately
 * not that type: the header is a widget and this is a feature, so the import
 * could only go the wrong way. TypeScript matches them by shape, which is what
 * makes the seam work without either side importing the other.
 */
export interface PresenceSlot {
  /**
   * Whether the strip has anybody to draw.
   *
   * `false` when nobody is working, and that answer is the point: the strip
   * does not say "nobody is working" — it stands down, and the header collapses
   * around it. The quiet-state copy belongs to the home surface, which knows
   * what else is on the page.
   */
  occupied: boolean;
  /** The strip itself, drawn whenever the host draws at all. */
  node: ReactNode;
}

/**
 * Who is working, ready to hand to the pinned triage header.
 *
 * **Following is a read, and the whole etiquette rule rides on that.** A room
 * opens as a reader and a session opens as a watcher; neither posts anything,
 * and the session lock is claimed only by writes (`X-Client-Id` rides
 * `postMessage`, command intents and UI actions and nothing else). So watching
 * an agent mid-turn cannot interrupt it, cannot steal its session, and cannot
 * be mistaken by the server for a second operator on the same transcript.
 *
 * Navigation PUSHES a history entry, like every other row in the cockpit that
 * changes what is on screen — following someone into a room and pressing Back
 * returns you to your own page.
 *
 * **Watching and looking up are two different questions, and the strip answers
 * both without confusing them.** Pressing a chip follows the work; the hover
 * card the same chip opens carries "View profile", which lands on the same
 * `?profile=<id>` address a Team card or a mention pill opens.
 *
 * @param excludeRoomIds - Rooms whose presence is already being narrated
 *   elsewhere on the page. The home surface passes its own `#team` room here,
 *   because that room draws a presence line under its composer and the same
 *   agent must not be announced twice, three lines apart, in two different
 *   sentences. An excluded room's claim still suppresses that agent's session
 *   row — see `PresenceRowsInput.excludeRoomIds` in `lib/presence-rows`, which
 *   is where the exclusion is applied and why it is applied there.
 * @returns The slot: whether anybody is working, and the strip to draw.
 */
export function usePresenceStrip(excludeRoomIds: readonly string[] = []): PresenceSlot {
  const rows = usePresenceRows(excludeRoomIds);
  const navigate = useNavigate();
  // The same address every other face in the cockpit opens — `?profile=<id>`,
  // pushed rather than replaced, so the phone's back gesture closes it.
  const { open: viewProfile } = useProfileDeepLink();

  const follow = useCallback(
    (target: PresenceFollowTarget) => {
      // Following IS opening, so it records one — the same write the sidebar's
      // own rows make (`SidebarChrome.openTarget`). Without it the strip was a
      // door into a conversation that Today then claimed the operator had never
      // been in (DOR-1156).
      if (target.kind === 'room') {
        useInteractionStore.getState().recordOpened('room', target.roomId);
        void navigate({ to: '/channels', search: { id: target.roomId } });
        return;
      }
      useInteractionStore.getState().recordOpened('session', target.sessionId);
      if (target.cwd) useInteractionStore.getState().recordOpened('agent', target.cwd);
      void navigate({
        to: '/session',
        search: { session: target.sessionId, dir: target.cwd },
      });
    },
    [navigate]
  );

  // The element is memoised, not just the rows, and that is what makes the
  // stability above worth having: React bails out of re-rendering a subtree
  // whose element is referentially identical, so twenty session-status events
  // that change nobody's presence redraw no avatars, no hover cards and no
  // DOM at all — even though the store woke this hook twenty times.
  const node = useMemo(
    () => <PresenceStrip rows={rows} onFollow={follow} onViewProfile={viewProfile} />,
    [rows, follow, viewProfile]
  );

  return { occupied: rows.length > 0, node };
}
