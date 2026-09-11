/**
 * Which room the page is showing.
 *
 * It lives with the room ENTITY rather than with the room-management feature
 * that first asked it (DOR-1974). Two surfaces now need the answer and they are
 * in different features — the right panel's Room tab, and every affordance that
 * opens an agent's session from inside a room — so a home either of them could
 * import from is the only one that keeps "which room is on screen" a single
 * answer. It reads nothing but the route and this slice's own `#team` lookup,
 * so entities is where it always belonged.
 *
 * @module entities/room/model/use-route-room
 */
import { useSafePathname, useSafeSearch } from '@/layers/shared/model';
// Same-slice sibling, not the barrel: a slice's own barrel importing back into
// its own module is the self-reference the entity DAG rule exists to keep out.
import { useTeamRoom } from './use-team-room';

/** The route that addresses a room by search param. */
const CHANNELS_PATHNAME = '/channels';

/** The route that IS a room — Home renders #team (team-room-home spec D3.2). */
const HOME_PATHNAME = '/';

/**
 * Whether this route puts a room on screen.
 *
 * Shared by the Room tab's `visibleWhen` in `init-extensions.ts` and by
 * {@link useRouteRoom}, so the tab can never be offered on a route where the
 * panel would have nothing to describe.
 *
 * @param pathname - The route being shown.
 */
export function routeShowsRoom(pathname: string): boolean {
  return pathname === CHANNELS_PATHNAME || pathname === HOME_PATHNAME;
}

/** What {@link useRouteRoom} could work out about the room on screen. */
export type RouteRoom =
  /** This route shows no room, or the one it names cannot be resolved. */
  | { status: 'none' }
  /** Still finding out — only Home's #team lookup can be in this state. */
  | { status: 'loading' }
  /** The room the page is showing. */
  | { status: 'ready'; roomId: string };

/**
 * Resolve the room the current route displays.
 *
 * Two routes show a room and they address it differently: `/channels` names one
 * by `?id=`, and Home IS #team, which is found by its well-known key. Both are
 * resolved from queries the page below already holds, so the panel costs no
 * request of its own and can never describe a different room from the bar above
 * it.
 *
 * **An archived #team resolves to no room.** Home draws no conversation for one
 * — it offers to bring it back instead — so a panel for it would be settings for
 * something that is not on screen.
 *
 * **An `?id=` that names no room still resolves here, deliberately.** This hook
 * cannot tell a deleted room from one whose read has not landed; only the read
 * can. So the id is taken at its word and the panel says "That room isn't here"
 * when the read comes back 404 ({@link RoomPanelBody}) — which is the same
 * sentence, in the same place, as a room that has genuinely gone.
 *
 * Router-free by construction: `useSafePathname`/`useSafeSearch` answer honestly
 * with no router mounted, so this hook — and the panel around it — is safe in the
 * embed, which has neither router nor room routes.
 */
export function useRouteRoom(): RouteRoom {
  const pathname = useSafePathname();
  const search = useSafeSearch() as { id?: string };
  const team = useTeamRoom();

  if (pathname === CHANNELS_PATHNAME) {
    return search.id ? { status: 'ready', roomId: search.id } : { status: 'none' };
  }
  if (pathname !== HOME_PATHNAME) return { status: 'none' };
  if (team.status === 'loading') return { status: 'loading' };
  return team.status === 'ready' ? { status: 'ready', roomId: team.room.id } : { status: 'none' };
}
