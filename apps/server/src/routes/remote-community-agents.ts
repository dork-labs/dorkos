/**
 * The owner's agents in a remote space: which are enrolled, enrolling one, removing one, and
 * putting one in or out of a channel. Each goes through the owner's own verified connection; an
 * agent's credential stays on this server.
 *
 * @module routes/remote-community-agents
 */
import type { Hono } from 'hono';
import {
  RemoteCommunityEjectionResponseSchema,
  RemoteCommunityEnrollmentResponseSchema,
  RemoteCommunityEnrollmentsResponseSchema,
  RemoteCommunityEnrollRequestSchema,
} from '@dorkos/shared/community-views';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import {
  getRemoteCommunityAdapter,
  getRemoteCommunityEnrollmentStore,
  getRemoteCommunityLifecycle,
  getRemotePairingService,
  resolveRemoteCommunityLocalAgent,
} from '../services/communities/remote/state.js';
import { remoteRoomAccessOf } from '../services/communities/remote/remote-community-adapter.js';
import { getRoomService } from '../services/rooms/index.js';
import { communityFailure, communityTarget, verifiedConnection } from './remote-community-http.js';

/**
 * Register the agent routes on the `/api/communities` routes.
 *
 * @param router - The `/api/communities` routes.
 */
export function registerRemoteCommunityAgentRoutes(router: Hono<ApiEnv>): void {
  router.get('/:ref/agents', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    try {
      await verifiedConnection(ref, owner, 'enrollAgent');
      const [agents, bindings] = await Promise.all([
        getRemoteCommunityAdapter(ref, owner).listEnrolledAgents(),
        Promise.resolve(getRemoteCommunityEnrollmentStore().activeForOwner(ref, owner)),
      ]);
      const author = getRoomService().authorRegistry.getById(owner);
      const byRemoteId = new Map(agents.map((agent) => [agent.memberId, agent]));
      const adapter = getRemoteCommunityAdapter(ref, owner);
      const joinedRooms = new Map(
        await Promise.all(
          bindings.map(
            async (binding) =>
              [
                binding.localAgentId,
                (await adapter.listRooms({ actingMemberId: binding.remoteMemberId }))
                  .filter(
                    (room) => room.archived === false && remoteRoomAccessOf(room)?.joined === true
                  )
                  .map((room) => room.roomId),
              ] as const
          )
        )
      );
      const rows = bindings.flatMap((binding) => {
        const agent = byRemoteId.get(binding.remoteMemberId);
        return agent
          ? [
              {
                community: ref,
                localAgentId: binding.localAgentId,
                remoteMemberId: agent.memberId,
                displayName: agent.displayName,
                ownerMemberId: agent.ownerMemberId ?? '',
                ownerDisplayName: author?.displayName ?? 'Owner',
                roomIds: joinedRooms.get(binding.localAgentId) ?? [],
                active: true,
              },
            ]
          : [];
      });
      return c.json(
        RemoteCommunityEnrollmentsResponseSchema.parse({ community: ref, agents: rows })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.post('/:ref/agents/:localAgentId/enroll', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const localAgentId = c.req.param('localAgentId');
    const input = RemoteCommunityEnrollRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!input.success) return c.json({ error: 'Use a valid space handle.' }, 400);
    try {
      await verifiedConnection(ref, owner, 'enrollAgent');
      const localAgent = resolveRemoteCommunityLocalAgent(localAgentId);
      if (!localAgent) return c.json({ error: 'Local agent not found.' }, 404);
      const adapter = getRemoteCommunityAdapter(ref, owner);
      const member = await adapter.recoverAgent({
        // Keep the public Mesh manifest id durable. The local author id is
        // intentionally private and is resolved again at dispatch time.
        agentId: localAgentId,
        displayName: localAgent.displayName,
        ...(input.data.handle ? { handle: input.data.handle } : {}),
      });
      getRemoteCommunityLifecycle().refreshSubscriptions();
      return c.json(
        RemoteCommunityEnrollmentResponseSchema.parse({
          agent: {
            community: ref,
            localAgentId,
            remoteMemberId: member.memberId,
            displayName: member.displayName,
            ownerMemberId: member.ownerMemberId ?? '',
            ownerDisplayName:
              getRoomService().authorRegistry.getById(owner)?.displayName ?? 'Owner',
            roomIds: [],
            active: true,
          },
        }),
        201
      );
    } catch (error) {
      return communityFailure(c, error, 'enroll-agent');
    }
  });
  router.delete('/:ref/agents/:localAgentId', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const localAgentId = c.req.param('localAgentId');
    try {
      const enrollments = getRemoteCommunityEnrollmentStore();
      const binding = enrollments.findAnyRemoteMember(ref, localAgentId, owner);
      if (!binding) return c.json({ error: 'Agent enrollment not found.' }, 404);
      // Fence the exact local enrollment before any remote cleanup. This aborts
      // its stream and pending work, revokes only its mirror accessors, and
      // prevents a directory pass already in flight from restoring that grant.
      await getRemoteCommunityLifecycle().revokeEnrollment(ref, localAgentId, owner);
      let remoteRevoked = false;
      try {
        const connection = await getRemotePairingService().status(ref, owner);
        if (
          connection.status === 'connected' &&
          connection.access?.state === 'verified' &&
          connection.access.effective.enrollAgent
        ) {
          await getRemoteCommunityAdapter(ref, owner).revokeAgent(binding.remoteMemberId);
          remoteRevoked = true;
        }
      } catch {
        remoteRevoked = false;
      }
      getRemoteCommunityLifecycle().refreshSubscriptions();
      return c.json(
        RemoteCommunityEjectionResponseSchema.parse({ localRevoked: true, remoteRevoked })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.post('/:ref/rooms/:roomId/agents/:localAgentId/membership', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    try {
      await verifiedConnection(ref, owner, 'enrollAgent');
      const binding = getRemoteCommunityEnrollmentStore().findRemoteMember(
        ref,
        c.req.param('localAgentId'),
        owner
      );
      if (!binding) return c.json({ error: 'Active agent enrollment not found.' }, 404);
      await getRemoteCommunityAdapter(ref, owner).addMember(
        c.req.param('roomId'),
        binding.remoteMemberId
      );
      getRemoteCommunityLifecycle().refreshSubscriptions();
      return c.body(null, 204);
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.delete('/:ref/rooms/:roomId/agents/:localAgentId/membership', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const roomId = c.req.param('roomId');
    const localAgentId = c.req.param('localAgentId');
    try {
      await verifiedConnection(ref, owner, 'enrollAgent');
      const binding = getRemoteCommunityEnrollmentStore().findRemoteMember(
        ref,
        localAgentId,
        owner
      );
      if (!binding) return c.json({ error: 'Active agent enrollment not found.' }, 404);
      await getRemoteCommunityAdapter(ref, owner).removeMember(roomId, binding.remoteMemberId);
      await getRemoteCommunityLifecycle().leaveRoom(ref, roomId, localAgentId, owner);
      return c.json(
        RemoteCommunityEjectionResponseSchema.parse({ localRevoked: true, remoteRevoked: true })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
}
