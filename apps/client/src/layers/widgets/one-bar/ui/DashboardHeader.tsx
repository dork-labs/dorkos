import { HomeSurfaceBar } from './HomeSurfaceBar';
import { HomeMembersChip } from './HomeMembersChip';

/**
 * Home's bar — the home surface strip, with #team's head count beside it.
 *
 * The word "Home" is not written here any more, and that is the point: the tab
 * says it, and a title over a tab saying the same thing was the same screen
 * saying one word twice. What is Home's own is the room it opens on — so the
 * members chip is the only thing this route adds to the shared bar, and the
 * #team identity row that used to sit under the header is gone with it.
 */
export function DashboardHeader() {
  return <HomeSurfaceBar chips={<HomeMembersChip />} />;
}
