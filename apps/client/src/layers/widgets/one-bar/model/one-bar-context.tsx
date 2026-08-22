import { createContext, use, type ReactNode } from 'react';
import type { SessionOrigin } from '@dorkos/shared/types';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { TeamViewMode } from '@/layers/shared/lib';

/**
 * What the shell already knows that a route's bar needs.
 *
 * Route headers are declared in `router.tsx` as zero-prop components (see
 * `resolveRouteHeader`), which is what lets a route own its header without the
 * shell keeping a switch. They still need a few values the shell resolves once
 * and would otherwise resolve twice — the open room's title, the active
 * session's agent — so those ride a context rather than a prop drill through
 * `staticData`.
 *
 * Everything here is read-only and derived. Nothing writes back through it.
 */
export interface OneBarRouteState {
  /** Active session's agent name, absent when the session has no agent yet. */
  agentName: string | undefined;
  /** Active session's resolved origin. Absent or `'user'` shows no chip. */
  origin: SessionOrigin | undefined;
  /** The session's own origin label, preferred over the descriptor's fallback. */
  originLabel: string | undefined;
  /**
   * The open room on `/channels`, roster and all, resolved once by the shell
   * (`useRoomDocumentTitle`).
   *
   * The whole room rather than only its name, because the channel bar says four
   * more things about it — archived, bridge visibility, how many are working,
   * how many are in it — and every one of them is a field on this object. One
   * resolution, shared: the browser tab and the bar read the same room through
   * the same query, so they can never disagree about what is open, and the bar
   * costs no request of its own (`useRoom` is a TanStack cache read of the query
   * the page below already runs).
   *
   * `null` off `/channels`, and on it whenever the id is missing or the room
   * read fails — which is exactly when the bar falls back to a plain "Channels"
   * title beside the page saying the conversation isn't here (spec §5 case 6).
   *
   * An ARCHIVED room is not one of those cases: `GET /api/rooms/:id` returns it
   * like any other, so an archived channel opened by id arrives here whole and
   * the bar says so with its badge. Only the room LIST hides archived rooms,
   * which is a different read and the reason #team's archived state is resolved
   * separately (`useTeamRoom`).
   */
  room: RoomWithRoster | null;
  /**
   * Which `/team` view is showing. Read off the URL rather than through
   * `useSearch`, so the header keeps rendering during a route exit animation.
   */
  teamViewMode: TeamViewMode;
}

const OneBarContext = createContext<OneBarRouteState | null>(null);

/**
 * Supplies the shell-resolved values every route bar reads.
 *
 * Mounted by `AppShell` around the header slot. Tests and playground showcases
 * that render a route bar directly mount it too.
 *
 * @param props - The resolved state, plus the bar it wraps.
 */
export function OneBarProvider({
  value,
  children,
}: {
  value: OneBarRouteState;
  children: ReactNode;
}) {
  return <OneBarContext value={value}>{children}</OneBarContext>;
}

/**
 * Read the shell-resolved bar state.
 *
 * Throws outside a provider rather than defaulting: a bar rendering an empty
 * room title because nobody mounted the provider is the exact class of bug
 * DOR-587 was, and it is invisible until somebody notices the wrong word in the
 * header.
 */
export function useOneBarState(): OneBarRouteState {
  const value = use(OneBarContext);
  if (!value) {
    throw new Error('useOneBarState must be used inside a OneBarProvider');
  }
  return value;
}
