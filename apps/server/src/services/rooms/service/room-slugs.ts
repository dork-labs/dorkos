/**
 * A channel's `#slug`: how one is derived from a title, and how a name DorkOS
 * mints for itself steps over the ones already taken.
 *
 * Shared by every path that names a channel — creating one, renaming one,
 * opening a system room, and bridging a platform chat — so the four of them
 * cannot drift into four ideas of what a title slugs to.
 *
 * @module server/services/rooms/service/room-slugs
 */
import type { RoomStore } from '../room-store.js';

/**
 * Derive a channel slug from a title: lowercase, hyphenated, trimmed to 80.
 * Returns `null` when the title has nothing sluggable in it, so the caller can
 * ask for a slug rather than inventing one nobody would recognise.
 *
 * @param title - The title to derive from.
 */
export function slugify(title: string): string | null {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      // Single `-`, not `-+`: the collapse above leaves hyphen runs of length
      // one, so the `+` could only retry at every offset of a run that cannot
      // exist — quadratic in shape (CodeQL js/polynomial-redos), and this one
      // sits on a request path where a title arrives uncapped.
      .replace(/^-|-$/g, '')
      .slice(0, 80)
      .replace(/-$/, '') || null
  );
}

/**
 * A free channel slug, appending `-2`, `-3`, … until one is (spec §3.4,
 * A3.4). Never throws `SLUG_TAKEN` — this is the path for names DorkOS mints
 * rather than names a person typed, and there is nobody behind a platform
 * title or a boot hook who could rename anything to resolve a collision.
 *
 * **`includeArchived` decides which question is being asked**, and both
 * callers are right about their own. A bridged room asks "may I take this
 * name?", so it steps over LIVE channels only: an archived channel has
 * released its slug and holding it in reserve forever would make every
 * bridged `#standup` a `#standup-2`. A system room asks the stronger
 * question, "is this name somebody's to come back to?", because it opens once
 * and keeps its name for the life of the install — taking an archived
 * channel's slug would leave that channel unable to un-archive at all, its
 * only way back being the name that had been quietly given away.
 *
 * @param store - The room table, for the collision lookups.
 * @param base - The slugified title to start from.
 * @param opts.includeArchived - Step over archived channels too. Defaults to
 *   false, which is "a live channel is the only thing in my way".
 */
export function uniqueChannelSlug(
  store: RoomStore,
  base: string,
  opts: { includeArchived?: boolean } = {}
): string {
  const taken = opts.includeArchived
    ? (slug: string) => store.anyChannelHoldsSlug(slug)
    : (slug: string) => store.findLiveChannelBySlug(slug) !== null;
  let candidate = base;
  for (let suffix = 2; taken(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
