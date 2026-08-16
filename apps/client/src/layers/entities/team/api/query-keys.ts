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
 * this install invalidates exactly this.
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
