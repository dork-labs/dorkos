/**
 * Team roster Transport methods (spec `identity-consistency` §W2.2, spec
 * `profile-unification` §3.2), through the generated API client (DOR-5473).
 *
 * Two reads and no writes — the roster is read-only by decision (ADR
 * 260806-222535), so this factory has no write counterpart to grow into.
 *
 * @module shared/lib/transport/team-methods
 */
import type { MemberRoomsResponse, TeamRosterResponse } from '@dorkos/shared/team-schemas';
import { createTransportApiClient } from './api-client';

/** Create the team-roster methods bound to a base URL. */
export function createTeamMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    getTeamRoster(): Promise<TeamRosterResponse> {
      // The envelope goes back untouched, `warnings` included: a degraded read
      // is a 200 the page renders a banner for, not an error the caller has to
      // reconstruct from a missing field.
      return api.call('team.get', {});
    },

    listMemberRooms(memberId: string): Promise<MemberRoomsResponse> {
      // The client encodes the id: a roster id is opaque, and "today's ids
      // happen to be URL-safe" is not a thing a client gets to assume about an
      // id it was handed.
      return api.call('team.getRooms', { path: { memberId } });
    },
  };
}
