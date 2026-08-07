/**
 * Team roster Transport method (spec `identity-consistency` §W2.2).
 *
 * One `GET /api/team` and nothing else — the roster is read-only by decision
 * (ADR 260806-222535), so this factory has no write counterpart to grow into.
 *
 * @module shared/lib/transport/team-methods
 */
import type { TeamRosterResponse } from '@dorkos/shared/team-schemas';
import { fetchJSON } from './http-client';

/** Create the team-roster method bound to a base URL. */
export function createTeamMethods(baseUrl: string) {
  return {
    getTeamRoster(): Promise<TeamRosterResponse> {
      // The envelope goes back untouched, `warnings` included: a degraded read
      // is a 200 the page renders a banner for, not an error the caller has to
      // reconstruct from a missing field.
      return fetchJSON<TeamRosterResponse>(baseUrl, '/team');
    },
  };
}
