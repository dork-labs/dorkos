/**
 * Team roster Transport methods (spec `identity-consistency` §W2.2, spec
 * `profile-unification` §3.2).
 *
 * Two reads and no writes — the roster is read-only by decision (ADR
 * 260806-222535), so this factory has no write counterpart to grow into.
 *
 * @module shared/lib/transport/team-methods
 */
import type { MemberRoomsResponse, TeamRosterResponse } from '@dorkos/shared/team-schemas';
import { fetchJSON } from './http-client';

/** Create the team-roster methods bound to a base URL. */
export function createTeamMethods(baseUrl: string) {
  return {
    getTeamRoster(): Promise<TeamRosterResponse> {
      // The envelope goes back untouched, `warnings` included: a degraded read
      // is a 200 the page renders a banner for, not an error the caller has to
      // reconstruct from a missing field.
      return fetchJSON<TeamRosterResponse>(baseUrl, '/team');
    },

    listMemberRooms(memberId: string): Promise<MemberRoomsResponse> {
      // Encoded because a roster id is opaque: today they are ULIDs, and
      // "today's ids happen to be URL-safe" is not a thing a client gets to
      // assume about an id it was handed.
      return fetchJSON<MemberRoomsResponse>(baseUrl, `/team/${encodeURIComponent(memberId)}/rooms`);
    },
  };
}
