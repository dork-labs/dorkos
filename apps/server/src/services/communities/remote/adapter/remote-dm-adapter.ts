/**
 * The space adapter with direct messages (DOR-2955, specs/everything-is-a-space C6).
 *
 * A direct message is a channel of its own kind on the space: one person and one agent. Its
 * messages, files and stream use the channel routes the base adapter already speaks, so this
 * adds only what is new: listing them, starting one, and the owner's switch. Every call is made
 * only when the space says it holds them (`features.agentDms`); an older space answers none.
 *
 * A subclass rather than more of `RemoteCommunityAdapter`, which is at its size limit; the base
 * shares its request and its feature read with it and nothing else.
 *
 * @module services/communities/remote/adapter/remote-dm-adapter
 */
import type { CommunityReadContext, CommunityRoom } from '@dorkos/shared/community-adapter';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityWireAgentDirectMessagesResponseSchema,
  CommunityWireDirectMessageListResponseSchema,
  CommunityWireDirectMessageResponseSchema,
  type CommunityWireDirectMessage,
} from '@dorkos/shared/community-wire';
import { PinnedHttpError } from '../pinned-origin.js';
import { RemoteCommunityAdapter } from '../remote-community-adapter.js';
import { room } from './remote-community-projection.js';

/** The title an agent's copy of a direct message carries, so its turns know who it is with. */
export function directMessageTitle(dm: CommunityWireDirectMessage): string {
  return `Direct message with ${dm.member.displayName}`;
}

/** The base adapter plus direct messages. */
export class RemoteDmCommunityAdapter extends RemoteCommunityAdapter {
  /** Whether this space holds direct messages. Never throws: a failed read answers no. */
  supportsDirectMessages(): Promise<boolean> {
    return this.features.has('agentDms');
  }

  /**
   * The direct messages the caller is in: this install's person, or with `context`, one of its
   * enrolled agents. None from a space that holds none.
   *
   * @param context - Read as an enrolled agent instead of the person.
   */
  async listDirectMessages(context?: CommunityReadContext): Promise<CommunityWireDirectMessage[]> {
    if (!(await this.supportsDirectMessages())) return [];
    return CommunityWireDirectMessageListResponseSchema.parse(
      await this.request(COMMUNITY_API_V1_ROUTES.dms, undefined, context, 'GET')
    ).dms;
  }

  /**
   * An enrolled agent's direct messages as rooms of kind `dm`, joined, for the subscription
   * runtime that keeps the agent's copy of each. Empty from a space that holds none.
   *
   * Asks the space directly rather than through its features: a failed feature read answers
   * "none", and an empty answer here would revoke the agent's copies as gone. Only a space with
   * no such route (404) answers none; any other failure throws and changes nothing.
   *
   * @param context - The enrolled agent to read as.
   */
  async listDirectMessageRooms(context: CommunityReadContext): Promise<CommunityRoom[]> {
    let dms: CommunityWireDirectMessage[];
    try {
      dms = CommunityWireDirectMessageListResponseSchema.parse(
        await this.request(COMMUNITY_API_V1_ROUTES.dms, undefined, context, 'GET')
      ).dms;
    } catch (error) {
      if (error instanceof PinnedHttpError && error.status === 404 && !error.remoteCode) return [];
      throw error;
    }
    return dms.map((dm) => {
      const projected = room(this.community, {
        id: dm.id,
        name: directMessageTitle(dm),
        description: null,
        archived: false,
        createdAt: dm.createdAt,
        unreadCount: dm.unreadCount,
        visibility: 'private',
        joined: true,
      });
      // In place, not spread: the projection keeps the room's access beside this very object.
      projected.kind = 'dm';
      return projected;
    });
  }

  /**
   * Start a direct message with an agent as this install's person, or find the one started.
   * The space refuses it (`AGENT_NOT_TAKING_DMS`) unless the agent's owner turned them on.
   *
   * @param agentMemberId - The agent's member id in the space.
   */
  async startDirectMessage(agentMemberId: string): Promise<CommunityWireDirectMessage> {
    return CommunityWireDirectMessageResponseSchema.parse(
      await this.request(COMMUNITY_API_V1_ROUTES.dms, { agentId: agentMemberId }, undefined, 'POST')
    ).dm;
  }

  /**
   * Turn one of this install's enrolled agents' direct messages on or off, with the person's
   * grant. Only the agent's owner may, which the space checks.
   *
   * @param agentMemberId - The agent's member id in the space.
   * @param accepts - Whether it takes them.
   */
  async setAgentDirectMessages(agentMemberId: string, accepts: boolean): Promise<boolean> {
    const path = COMMUNITY_API_V1_ROUTES.agentDms.replace(':id', encodeURIComponent(agentMemberId));
    return CommunityWireAgentDirectMessagesResponseSchema.parse(
      await this.request(path, { accepts }, undefined, 'PUT')
    ).acceptsDms;
  }
}
