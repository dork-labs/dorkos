/**
 * Where the person is, as mini-app tab placement sees it (spec
 * `mini-app-placement`).
 *
 * @module features/right-panel/model/use-placement-here
 */
import { useMemo, useState } from 'react';
import { pageKeyForPath, type PlacementHere } from '@dorkos/shared/mini-app-placement';
import { useCurrentAgent } from '@/layers/entities/agent';
import { useRouteRoom } from '@/layers/entities/room';
import { useAppStore } from '@/layers/shared/model';

/** Where the person is, or that it is still being worked out. */
export type PlacementHereState =
  | { status: 'ready'; here: PlacementHere }
  /**
   * Still resolving: Home's #team lookup, or the agent of the chat on screen.
   * `last` is the previous answer, so the panel can keep showing what it
   * showed instead of dropping a mini-app tab for a frame and then jumping
   * to another tab.
   */
  | { status: 'pending'; last: PlacementHere | null };

/**
 * Resolve where the person is.
 *
 * - In a chat (`/session`), the agent registered at the chat's folder. Read
 *   from the agent query rather than the store's `currentAgentId`, which an
 *   effect sets a moment later and so briefly names the previous agent.
 * - In a room on this computer (`/channels?id=`, or Home, which is #team), the
 *   room. A room from a connected community has no id here, so it is only the
 *   `channels` page.
 * - Anywhere else, just the page.
 *
 * @param pathname - The route on screen.
 * @param isRemoteCommunityRoom - Whether the open channel belongs to a connected community.
 */
export function usePlacementHere(
  pathname: string,
  isRemoteCommunityRoom: boolean
): PlacementHereState {
  const page = pageKeyForPath(pathname);
  const room = useRouteRoom();
  const cwd = useAppStore((s) => s.selectedCwd);
  const inChat = page === 'session';
  const agent = useCurrentAgent(inChat ? cwd : null);
  const pending = room.status === 'loading' || (inChat && cwd !== null && agent.isPending);
  const roomId = room.status === 'ready' && !isRemoteCommunityRoom ? room.roomId : null;
  const agentId = inChat ? (agent.data?.id ?? null) : null;
  // One object per distinct place, so readers can memoize on it.
  const here = useMemo(
    () => hereOf(page, roomId, agentId, inChat),
    [page, roomId, agentId, inChat]
  );

  // The last settled answer, updated during render (React's "store
  // information from previous renders" pattern) so a pending render can hand
  // it straight back.
  const [last, setLast] = useState<PlacementHere | null>(null);
  if (!pending && last !== here) setLast(here);

  return pending ? { status: 'pending', last } : { status: 'ready', here };
}

function hereOf(
  page: string,
  roomId: string | null,
  agentId: string | null,
  inChat: boolean
): PlacementHere {
  const here: PlacementHere = { page };
  if (roomId) here.roomId = roomId;
  if (inChat) here.agentId = agentId;
  return here;
}
