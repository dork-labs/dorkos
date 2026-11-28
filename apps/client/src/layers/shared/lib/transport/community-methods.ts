/**
 * Community connection requests through the local server; remote credentials never enter the browser.
 * @module shared/lib/transport/community-methods
 */
import {
  CommunityConnectionListResponseSchema,
  CommunityConnectionStartResponseSchema,
  CommunityConnectionStatusResponseSchema,
  CommunityConnectionPollResponseSchema,
  CommunityDisconnectImpactSchema,
  CommunityDisconnectResponseSchema,
  CommunityWakeAgentsFromSchema,
  type CommunityConnectionTransport,
} from '@dorkos/shared/community-connections';
import { CommunityTeammateSpendSchema } from '@dorkos/shared/community-teammates';
import { COMMUNITY_SPACE_READ_SCHEMAS } from '@dorkos/shared/community-space-settings';
import {
  CommunityNavigationResolveResponseSchema,
  CommunityNavigationStateSchema,
} from '@dorkos/shared/community-navigation';
import { createTransportApiClient } from './api-client';
import { fetchJSON, fetchNoContent } from './http-client';

/** Create owner-scoped community methods bound to the local API base URL. */
export function createCommunityMethods(baseUrl: string): CommunityConnectionTransport {
  const api = createTransportApiClient(baseUrl);
  const path = (ref: string) => `/community-connections/${encodeURIComponent(ref)}`;
  return {
    // Stays hand-written: `GET /api/community-connections` has no operationId (DOR-5473).
    async listCommunityConnections() {
      return CommunityConnectionListResponseSchema.parse(
        await fetchJSON(baseUrl, '/community-connections')
      ).connections;
    },
    // Stays hand-written: the API document leaves out its body (DOR-5473).
    async startCommunityConnection(input) {
      const result = CommunityConnectionStartResponseSchema.parse(
        await fetchJSON(baseUrl, '/community-connections', {
          method: 'POST',
          body: JSON.stringify(input),
        })
      );
      const approval = new URL(result.approvalUrl);
      if (
        !['https:', 'http:'].includes(approval.protocol) ||
        approval.origin !== new URL(result.connection.pinnedOrigin).origin ||
        approval.username ||
        approval.password
      ) {
        throw new Error('The space sent an approval link DorkOS couldn’t read.');
      }
      return result;
    },
    // Stays hand-written: `GET /api/community-connections/{ref}` has no operationId (DOR-5473).
    async getCommunityConnection(ref) {
      return CommunityConnectionStatusResponseSchema.parse(await fetchJSON(baseUrl, path(ref)))
        .connection;
    },
    // Stays hand-written: `POST /api/community-connections/{ref}/poll` has no operationId (DOR-5473).
    async pollCommunityConnection(ref) {
      return CommunityConnectionPollResponseSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/poll`, { method: 'POST' })
      );
    },
    // Stays hand-written: `POST /api/community-connections/{ref}/cancel` has no operationId (DOR-5473).
    cancelCommunityConnection(ref) {
      return fetchNoContent(baseUrl, `${path(ref)}/cancel`, { method: 'POST' });
    },
    // Stays hand-written: `DELETE /api/community-connections/{ref}` has no operationId (DOR-5473).
    async disconnectCommunity(ref) {
      return CommunityDisconnectResponseSchema.parse(
        await fetchJSON(baseUrl, path(ref), { method: 'DELETE' })
      );
    },
    // Stays hand-written: `GET /api/community-connections/{ref}/disconnect-impact` has no operationId (DOR-5473).
    async getCommunityDisconnectImpact(ref) {
      return CommunityDisconnectImpactSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/disconnect-impact`)
      );
    },
    // Stays hand-written: `GET /api/community-connections/{ref}/wake-agents-from` has no operationId (DOR-5473).
    async getCommunityWakeAgentsFrom(ref) {
      return CommunityWakeAgentsFromSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/wake-agents-from`)
      );
    },
    // Stays hand-written: the API document leaves out its body (DOR-5473).
    async setCommunityWakeAgentsFrom(ref, wakeAgentsFrom) {
      return CommunityWakeAgentsFromSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/wake-agents-from`, {
          method: 'PUT',
          body: JSON.stringify({ wakeAgentsFrom }),
        })
      );
    },
    // Stays hand-written: `GET /api/community-connections/{ref}/teammate-spend` has no operationId (DOR-5473).
    async getCommunityTeammateSpend(ref) {
      return CommunityTeammateSpendSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/teammate-spend`)
      );
    },
    async setCommunityTeammateSpendLimit(ref, monthlyLimitUsd) {
      return CommunityTeammateSpendSchema.parse(
        await api.call('communityConnections.updateTeammateSpend', {
          path: { ref },
          body: { monthlyLimitUsd },
        })
      );
    },
    // Stays hand-written: `GET /api/community-connections/{ref}/space/{read}` has no operationId (DOR-5473).
    async readCommunitySpace(ref, read) {
      // A fixed read name, never a path: the server asks the space for one fixed path per read.
      return COMMUNITY_SPACE_READ_SCHEMAS[read].parse(
        await fetchJSON(baseUrl, `${path(ref)}/space/${read}`)
      ) as never;
    },
    // Stays hand-written: `GET /api/community-connections/navigation` has no operationId (DOR-5473).
    async getCommunityNavigation() {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation')
      );
    },
    // Stays hand-written: `POST /api/community-connections/navigation/move` has no operationId (DOR-5473).
    async moveCommunityNavigation(input) {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation/move', {
          method: 'POST',
          body: JSON.stringify(input),
        })
      );
    },
    // Stays hand-written: `PUT /api/community-connections/navigation/destination` has no operationId (DOR-5473).
    async rememberCommunityNavigation(destination) {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation/destination', {
          method: 'PUT',
          body: JSON.stringify(destination),
        })
      );
    },
    // Stays hand-written: `PUT /api/community-connections/navigation/installation` has no operationId (DOR-5473).
    async rememberCommunityInstallationDestination(destination) {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation/installation', {
          method: 'PUT',
          body: JSON.stringify({ destination }),
        })
      );
    },
    // Stays hand-written: `GET /api/community-connections/navigation/{ref}/destination` has no operationId (DOR-5473).
    async resolveCommunityNavigation(ref) {
      return CommunityNavigationResolveResponseSchema.parse(
        await fetchJSON(
          baseUrl,
          `/community-connections/navigation/${encodeURIComponent(ref)}/destination`
        )
      ).destination;
    },
  };
}
