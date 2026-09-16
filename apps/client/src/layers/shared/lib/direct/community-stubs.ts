/** Community connections need the local web server, which the embedded app does not run. */
import type { CommunityConnectionTransport } from '@dorkos/shared/community-connections';

async function unavailable(): Promise<never> {
  throw new Error('Connect communities in the DorkOS web or desktop app.');
}

/** Explicit embedded-mode refusal for server-owned community operations. */
export const communityStubs: CommunityConnectionTransport = {
  listCommunityConnections: async () => [],
  startCommunityConnection: unavailable,
  getCommunityConnection: unavailable,
  pollCommunityConnection: unavailable,
  cancelCommunityConnection: unavailable,
  disconnectCommunity: unavailable,
};
