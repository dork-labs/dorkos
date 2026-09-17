/**
 * Community connection requests through the local server; remote credentials never enter the browser.
 * @module shared/lib/transport/community-methods
 */
import {
  CommunityConnectionListResponseSchema,
  CommunityConnectionStartResponseSchema,
  CommunityConnectionStatusResponseSchema,
  CommunityConnectionPollResponseSchema,
  type CommunityConnectionTransport,
} from '@dorkos/shared/community-connections';
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
        throw new Error('The community returned an invalid approval address.');
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
    disconnectCommunity(ref) {
      return fetchNoContent(baseUrl, path(ref), { method: 'DELETE' });
    },
  };
}
