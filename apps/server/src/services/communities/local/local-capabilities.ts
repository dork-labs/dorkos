/**
 * What the local rooms backend declares, and the one refusal every local read shares. Every value
 * is argued in `local-community-adapter.ts`'s module doc.
 *
 * @module server/services/communities/local/local-capabilities
 */
import {
  CommunityUnsupportedError,
  type CommunityCapabilities,
  type CommunityReadContext,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';

/** Refuse a selected agent before local reads can fall back to the human view. */
export function requireHumanReader(
  community: CommunityRef,
  context: CommunityReadContext | undefined,
  method: string
): void {
  if (context?.actingMemberId !== undefined) {
    throw new CommunityUnsupportedError(community, 'agentActing', method);
  }
}

/** What this backend declares. Every value is argued in the adapter's module doc. */
export const LOCAL_CAPABILITIES: CommunityCapabilities = {
  type: 'local',
  roomList: 'push',
  roomAddressing: 'slug',
  canPost: true,
  roomAdmin: true,
  agentActing: false,
  attachments: false,
  conduct: false,
  reports: false,
  roles: { supported: false, values: [] },
  admission: 'open',
  invite: 'none',
  agentAdmission: 'none',
  readCursor: 'server',
  responseMode: true,
  threadDepth: 1,
  signals: 'both',
  credential: 'none',
  features: {},
};
