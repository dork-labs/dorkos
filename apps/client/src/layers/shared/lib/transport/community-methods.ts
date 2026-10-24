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
import { fetchJSON, fetchNoContent } from './http-client';

/** Create owner-scoped community methods bound to the local API base URL. */
export function createCommunityMethods(baseUrl: string): CommunityConnectionTransport {
  const path = (ref: string) => `/community-connections/${encodeURIComponent(ref)}`;
  return {
    async listCommunityConnections() {
      return CommunityConnectionListResponseSchema.parse(
        await fetchJSON(baseUrl, '/community-connections')
      ).connections;
    },
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
    async getCommunityConnection(ref) {
      return CommunityConnectionStatusResponseSchema.parse(await fetchJSON(baseUrl, path(ref)))
        .connection;
    },
    async pollCommunityConnection(ref) {
      return CommunityConnectionPollResponseSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/poll`, { method: 'POST' })
      );
    },
    cancelCommunityConnection(ref) {
      return fetchNoContent(baseUrl, `${path(ref)}/cancel`, { method: 'POST' });
    },
    async disconnectCommunity(ref) {
      return CommunityDisconnectResponseSchema.parse(
        await fetchJSON(baseUrl, path(ref), { method: 'DELETE' })
      );
    },
    async getCommunityDisconnectImpact(ref) {
      return CommunityDisconnectImpactSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/disconnect-impact`)
      );
    },
    async getCommunityWakeAgentsFrom(ref) {
      return CommunityWakeAgentsFromSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/wake-agents-from`)
      );
    },
    async setCommunityWakeAgentsFrom(ref, wakeAgentsFrom) {
      return CommunityWakeAgentsFromSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/wake-agents-from`, {
          method: 'PUT',
          body: JSON.stringify({ wakeAgentsFrom }),
        })
      );
    },
    async getCommunityTeammateSpend(ref) {
      return CommunityTeammateSpendSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/teammate-spend`)
      );
    },
    async setCommunityTeammateSpendLimit(ref, monthlyLimitUsd) {
      return CommunityTeammateSpendSchema.parse(
        await fetchJSON(baseUrl, `${path(ref)}/teammate-spend`, {
          method: 'PUT',
          body: JSON.stringify({ monthlyLimitUsd }),
        })
      );
    },
    async readCommunitySpace(ref, read) {
      // A fixed read name, never a path: the server asks the space for one fixed path per read.
      return COMMUNITY_SPACE_READ_SCHEMAS[read].parse(
        await fetchJSON(baseUrl, `${path(ref)}/space/${read}`)
      ) as never;
    },
    async getCommunityNavigation() {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation')
      );
    },
    async moveCommunityNavigation(input) {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation/move', {
          method: 'POST',
          body: JSON.stringify(input),
        })
      );
    },
    async rememberCommunityNavigation(destination) {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation/destination', {
          method: 'PUT',
          body: JSON.stringify(destination),
        })
      );
    },
    async rememberCommunityInstallationDestination(destination) {
      return CommunityNavigationStateSchema.parse(
        await fetchJSON(baseUrl, '/community-connections/navigation/installation', {
          method: 'PUT',
          body: JSON.stringify({ destination }),
        })
      );
    },
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
