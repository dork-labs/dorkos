/**
 * Direct messages with an agent in a remote space (DOR-2955, specs/everything-is-a-space C6).
 *
 * - `GET /:ref/dms`: whether the space holds them, the person's own, and the ones someone has
 *   with this install's enrolled agents, which the owner reads through that agent (read-only).
 * - `POST /:ref/dms {agentMemberId}`: the person starts one with an agent, or finds it.
 * - `PUT /:ref/agents/:localAgentId/dms {accepts}`: the owner turns one of their agents' direct
 *   messages on or off.
 * - `GET /:ref/dms/:roomId/entries?agent=`: the owner reads one of their agents' direct messages,
 *   with that agent's credential; the space decides whether the agent is in it.
 *
 * Reading and posting in the person's own direct message use the ordinary room routes, since its
 * id is a channel id. Every call goes through the owner's verified connection, and no credential
 * reaches the browser.
 *
 * @module routes/remote-community-dms
 */
import type { Context, Hono } from 'hono';
import {
  AGENT_NOT_TAKING_DMS,
  RemoteCommunityAgentDmsRequestSchema,
  RemoteCommunityAgentDmsResponseSchema,
  RemoteCommunityDmsResponseSchema,
  RemoteCommunityStartDmRequestSchema,
  RemoteCommunityStartDmResponseSchema,
  type RemoteCommunityDm,
} from '@dorkos/shared/community-dm-views';
import { RemoteCommunityHistoryResponseSchema } from '@dorkos/shared/community-views';
import type { CommunityWireDirectMessage } from '@dorkos/shared/community-wire';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import {
  getRemoteCommunityAdapter,
  getRemoteCommunityEnrollmentStore,
} from '../services/communities/remote/state.js';
import { getAgentDmsStore } from '../services/communities/remote/dms/agent-dms-store.js';
import { PinnedHttpError } from '../services/communities/remote/pinned-origin.js';
import {
  communityFailure,
  communityTarget,
  remoteEntry,
  verifiedConnection,
} from './remote-community-http.js';

function project(
  ref: CommunityRef,
  dm: CommunityWireDirectMessage,
  readOnly: { localAgentId: string } | null
): RemoteCommunityDm {
  return {
    community: ref,
    roomId: dm.id,
    member: dm.member,
    agent: {
      memberId: dm.agent.memberId,
      displayName: dm.agent.displayName,
      ownerMemberId: dm.agent.ownerMemberId,
      ownerDisplayName: dm.agent.ownerDisplayName,
    },
    readOnly: readOnly !== null,
    ...(readOnly ? { localAgentId: readOnly.localAgentId } : {}),
    unreadCount: dm.unreadCount,
    createdAt: dm.createdAt,
  };
}

/** A space's refusal to reach an agent that takes no direct messages, said plainly. */
function notTakingDms(c: Context, error: unknown): Response | null {
  if (!(error instanceof PinnedHttpError) || error.remoteCode !== AGENT_NOT_TAKING_DMS) return null;
  return c.json(
    { code: AGENT_NOT_TAKING_DMS, error: 'This agent isn’t taking direct messages.' },
    409
  );
}

/**
 * Register the direct-message routes on the `/api/communities` routes.
 *
 * @param router - The `/api/communities` routes.
 */
export function registerRemoteCommunityDmRoutes(router: Hono<ApiEnv>): void {
  router.get('/:ref/dms', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    try {
      await verifiedConnection(ref, owner, 'read');
      const adapter = getRemoteCommunityAdapter(ref, owner);
      const available = await adapter.supportsDirectMessages();
      if (!available)
        return c.json(
          RemoteCommunityDmsResponseSchema.parse({ community: ref, available, dms: [] })
        );
      const own = (await adapter.listDirectMessages()).map((dm) => project(ref, dm, null));
      const seen = new Set(own.map((dm) => dm.roomId));
      const agents: RemoteCommunityDm[] = [];
      for (const enrollment of getRemoteCommunityEnrollmentStore().activeForOwner(ref, owner)) {
        // Someone else's direct message with this install's agent: read through the agent, and
        // never the owner's own, which is already listed above with its composer.
        for (const dm of await adapter.listDirectMessages({
          actingMemberId: enrollment.remoteMemberId,
        })) {
          if (seen.has(dm.id)) continue;
          seen.add(dm.id);
          agents.push(project(ref, dm, { localAgentId: enrollment.localAgentId }));
        }
      }
      return c.json(
        RemoteCommunityDmsResponseSchema.parse({
          community: ref,
          available,
          dms: [...own, ...agents],
        })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });

  router.post('/:ref/dms', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const input = RemoteCommunityStartDmRequestSchema.safeParse(readJsonBody(c));
    if (!input.success) return c.json({ error: 'Name the agent to message.' }, 400);
    try {
      await verifiedConnection(ref, owner, 'post');
      const adapter = getRemoteCommunityAdapter(ref, owner);
      if (!(await adapter.supportsDirectMessages()))
        return c.json({ error: 'This space doesn’t hold direct messages.' }, 404);
      const dm = await adapter.startDirectMessage(input.data.agentMemberId);
      return c.json(RemoteCommunityStartDmResponseSchema.parse({ dm: project(ref, dm, null) }));
    } catch (error) {
      return notTakingDms(c, error) ?? communityFailure(c, error);
    }
  });

  router.put('/:ref/agents/:localAgentId/dms', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const localAgentId = c.req.param('localAgentId');
    const input = RemoteCommunityAgentDmsRequestSchema.safeParse(readJsonBody(c));
    if (!input.success) return c.json({ error: 'Say whether it takes direct messages.' }, 400);
    try {
      await verifiedConnection(ref, owner, 'enrollAgent');
      const enrollment = getRemoteCommunityEnrollmentStore()
        .activeForOwner(ref, owner)
        .find((item) => item.localAgentId === localAgentId);
      if (!enrollment) return c.json({ error: 'Agent not found in this space.' }, 404);
      const adapter = getRemoteCommunityAdapter(ref, owner);
      if (!(await adapter.supportsDirectMessages()))
        return c.json({ error: 'This space doesn’t hold direct messages.' }, 404);
      const accepts = await adapter.setAgentDirectMessages(
        enrollment.remoteMemberId,
        input.data.accepts
      );
      await getAgentDmsStore().set(ref, owner, localAgentId, accepts);
      return c.json(
        RemoteCommunityAgentDmsResponseSchema.parse({ localAgentId, acceptsDms: accepts })
      );
    } catch (error) {
      return communityFailure(c, error, 'enroll-agent');
    }
  });

  router.get('/:ref/dms/:roomId/entries', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const roomId = c.req.param('roomId');
    const query = readQuery(c);
    const enrollment = getRemoteCommunityEnrollmentStore()
      .activeForOwner(ref, owner)
      .find((item) => item.localAgentId === query.agent);
    if (!enrollment) return c.json({ error: 'Agent not found in this space.' }, 404);
    try {
      await verifiedConnection(ref, owner, 'read');
      // Read as the agent: the space answers only for a direct message the agent is in.
      const page = await getRemoteCommunityAdapter(ref, owner).listEntriesWithThreadRoot(roomId, {
        limit: 100,
        actingMemberId: enrollment.remoteMemberId,
      });
      const entries = page.entries.map((entry) => remoteEntry(entry, owner));
      return c.json(
        RemoteCommunityHistoryResponseSchema.parse({
          community: ref,
          roomId,
          entries,
          nextCursor: page.nextCursor,
          lastRemoteSeq: entries.at(-1)?.remoteSeq ?? 0,
          stale: false,
        })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
}
