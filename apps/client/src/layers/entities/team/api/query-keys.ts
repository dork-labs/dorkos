/**
 * Query keys for the team roster.
 *
 * @module entities/team/api/query-keys
 */

/**
 * The one cache entry the roster lives in.
 *
 * Deliberately unparameterised: filtering, grouping and search all run in
 * memory over this single payload (spec §W2.4), so a filter change must never
 * become a second key and a second request. Anything that changes who is on
 * this install invalidates exactly this entry.
 *
 * **It is also the root of a key FAMILY, not a lone key**: `['team']` is a
 * PREFIX of {@link memberRoomsKey}, so invalidating it refreshes every member's
 * rooms too — intended, since the things that change the roster can change who
 * is in a room. What that costs is the right to write through this prefix:
 * `setQueryData(TEAM_ROSTER_KEY, …)` on this exact key stays fine, but nothing
 * may ever `setQueriesData` across `['team']`, because the entries under it
 * hold a different shape and a prefixed writer cannot know it.
 */
export const TEAM_ROSTER_KEY = ['team'] as const;

/**
 * The rooms one member is in (spec `profile-unification` §3.2).
 *
 * **Nested under {@link TEAM_ROSTER_KEY} on purpose**, even though the two hold
 * different shapes. Everything that invalidates `['team']` — a rename, a new
 * face, a freshly registered agent — is also something that can change who is in
 * a room, so a prefix match refreshing both is the behaviour rather than a side
 * effect. What makes that safe is that `['team']` has invalidators and no
 * PREFIX WRITERS: nothing calls `setQueriesData` over it, which is the trap a
 * mixed-shape prefix would otherwise be (see `roomKeys.wellKnown` for the
 * version of this that had to be moved out).
 *
 * @param memberId - The member's roster id.
 */
export const memberRoomsKey = (memberId: string) => ['team', 'rooms', memberId] as const;
