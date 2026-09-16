/** Community connections need the local web server, which the embedded app does not run. */
import type { CommunityConnectionTransport } from '@dorkos/shared/community-connections';
import type { RemoteCommunityTransport } from '@dorkos/shared/community-views';

async function unavailable(): Promise<never> {
  throw new Error('Connect communities in the DorkOS web or desktop app.');
}

/** Explicit embedded-mode refusal for server-owned community operations. */
export const communityStubs: CommunityConnectionTransport & RemoteCommunityTransport = {
  listCommunityConnections: async () => [],
  startCommunityConnection: unavailable,
  getCommunityConnection: unavailable,
  pollCommunityConnection: unavailable,
  cancelCommunityConnection: unavailable,
  disconnectCommunity: unavailable,
  listRemoteCommunityRooms: unavailable,
  getRemoteCommunityRoom: unavailable,
  listRemoteCommunityEntries: unavailable,
  postRemoteCommunityEntry: unavailable,
  subscribeRemoteCommunityRoom: unavailable,
  listRemoteCommunityMembers: unavailable,
  joinRemoteCommunityRoom: unavailable,
  leaveRemoteCommunityRoom: unavailable,
  getRemoteCommunityReadCursor: unavailable,
  setRemoteCommunityReadCursor: unavailable,
  listRemoteCommunityAgents: unavailable,
  enrollRemoteCommunityAgent: unavailable,
  ejectRemoteCommunityAgent: unavailable,
  joinRemoteCommunityAgentRoom: unavailable,
  leaveRemoteCommunityAgentRoom: unavailable,
  uploadRemoteCommunityAttachment: unavailable,
  downloadRemoteCommunityAttachment: unavailable,
};
