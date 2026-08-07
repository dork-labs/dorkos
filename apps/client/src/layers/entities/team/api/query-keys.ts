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
