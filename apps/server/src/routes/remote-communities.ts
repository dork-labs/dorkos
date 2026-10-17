/**
 * Owner-qualified local views over browser-approved remote communities.
 *
 * The browser never receives a bearer or local mirror identifier. Every read
 * constructs the native adapter through the production state factory, which
 * binds the current owner, protected connection record and durable enrollment
 * authority together.
 *
 * @module routes/remote-communities
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  RemoteCommunityHistoryResponseSchema,
  RemoteCommunityAttachmentResponseSchema,
  RemoteCommunityMembersResponseSchema,
  RemoteCommunityPostRequestSchema,
  RemoteCommunityPostResponseSchema,
  RemoteCommunityReadCursorSchema,
  RemoteCommunityRoomResponseSchema,
  RemoteCommunityRoomsResponseSchema,
} from '@dorkos/shared/community-views';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { resolveCommunityOwner } from './community-connections.js';
import {
  getRemoteCommunityAdapter,
  getRemoteCommunityDeliverySnapshot,
  getRemoteCommunityLifecycle,
  retryRemoteCommunityDelivery,
} from '../services/communities/remote/state.js';
import { RemoteConnectionAuthorizationError } from '../services/communities/remote/connection-store.js';
import { attachmentHeaders, requestBytes } from './remote-community-attachment-http.js';
import { registerRemoteCommunityAgentRoutes } from './remote-community-agents.js';
import { registerRemoteCommunityDmRoutes } from './remote-community-dms.js';
import { registerRemoteCommunityConductRoutes } from './remote-community-conduct.js';
import { remoteRoomEvents } from './remote-community-events.js';
import {
  communityFailure,
  communityTarget,
  remoteEntry,
  remoteRoom,
  verifiedConnection,
} from './remote-community-http.js';

/** Build the routes for remote community discovery and qualified views. */
export function createRemoteCommunitiesRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.get('/:ref/rooms', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    try {
      const connection = await verifiedConnection(ref, owner, 'read');
      const adapter = getRemoteCommunityAdapter(ref, owner);
      const connected = await adapter.connect();
      if (connected.status === 'unauthorized') throw new RemoteConnectionAuthorizationError();
      if (connected.status !== 'connected') throw new Error('Space unavailable');
      const rooms = (await adapter.listRooms()).map((room) =>
        remoteRoom(room, connection.remoteCommunityId, connection.access!)
      );
      return c.json(
        RemoteCommunityRoomsResponseSchema.parse({ community: ref, rooms, stale: false })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.get('/:ref/rooms/:roomId', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    try {
      const connection = await verifiedConnection(ref, owner, 'read');
      const room = await getRemoteCommunityAdapter(ref, owner).getRoom(c.req.param('roomId'));
      if (!room) return c.json({ error: 'Room not found.' }, 404);
      return c.json(
        RemoteCommunityRoomResponseSchema.parse({
          room: remoteRoom(room, connection.remoteCommunityId, connection.access!),
        })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.get('/:ref/rooms/:roomId/entries', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const roomId = c.req.param('roomId');
    const query = readQuery(c);
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return c.json({ error: 'Use a history limit from 1 through 100.' }, 400);
    try {
      await verifiedConnection(ref, owner, 'read');
      const page = await getRemoteCommunityAdapter(ref, owner).listEntriesWithThreadRoot(roomId, {
        cursor: typeof query.cursor === 'string' ? (query.cursor as never) : undefined,
        limit,
        thread: typeof query.threadRootId === 'string' ? query.threadRootId : undefined,
      });
      const entries = page.entries.map((entry) => remoteEntry(entry, owner));
      const lastRemoteSeq = entries.at(-1)?.remoteSeq ?? 0;
      return c.json(
        RemoteCommunityHistoryResponseSchema.parse({
          community: ref,
          roomId,
          entries,
          nextCursor: page.nextCursor,
          lastRemoteSeq,
          stale: false,
        })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.get('/:ref/rooms/:roomId/read-cursor', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const roomId = c.req.param('roomId');
    try {
      await verifiedConnection(ref, owner, 'read');
      const adapter = getRemoteCommunityAdapter(ref, owner);
      const [cursor, room] = await Promise.all([
        adapter.getReadCursor(roomId),
        adapter.getRoom(roomId),
      ]);
      if (!room) return c.json({ error: 'Room not found.' }, 404);
      return c.json(
        RemoteCommunityReadCursorSchema.parse({ cursor, unreadCount: room.unreadCount ?? 0 })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.put('/:ref/rooms/:roomId/read-cursor', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const roomId = c.req.param('roomId');
    const body = readJsonBody(c) as { cursor?: unknown } | undefined;
    const cursor = typeof body?.cursor === 'string' ? body.cursor : null;
    if (!cursor) return c.json({ error: 'A cursor is required.' }, 400);
    try {
      await verifiedConnection(ref, owner, 'read');
      const adapter = getRemoteCommunityAdapter(ref, owner);
      await adapter.setReadCursor(roomId, cursor as never);
      const room = await adapter.getRoom(roomId);
      if (!room) return c.json({ error: 'Room not found.' }, 404);
      return c.json(
        RemoteCommunityReadCursorSchema.parse({ cursor, unreadCount: room.unreadCount ?? 0 })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.post('/:ref/rooms/:roomId/membership', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    try {
      const connection = await verifiedConnection(ref, owner, 'post');
      const room = await getRemoteCommunityAdapter(ref, owner).joinRoom(c.req.param('roomId'));
      return c.json(
        RemoteCommunityRoomResponseSchema.parse({
          room: remoteRoom(room, connection.remoteCommunityId, connection.access!),
        })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.delete('/:ref/rooms/:roomId/membership', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    try {
      await verifiedConnection(ref, owner, 'post');
      await getRemoteCommunityAdapter(ref, owner).leaveRoom(c.req.param('roomId'));
      return c.body(null, 204);
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.get('/:ref/rooms/:roomId/members', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const roomId = c.req.param('roomId');
    try {
      await verifiedConnection(ref, owner, 'read');
      const members = await getRemoteCommunityAdapter(ref, owner).listMembers(roomId);
      return c.json(
        RemoteCommunityMembersResponseSchema.parse({
          community: ref,
          roomId,
          members,
          stale: false,
        })
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.post('/:ref/rooms/:roomId/entries', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const input = RemoteCommunityPostRequestSchema.safeParse(readJsonBody(c));
    if (!input.success) return c.json({ error: 'Enter a message with a valid retry key.' }, 400);
    try {
      await verifiedConnection(ref, owner, 'post');
      const entry = await getRemoteCommunityAdapter(ref, owner).postEntry(
        c.req.param('roomId'),
        input.data
      );
      return c.json(
        RemoteCommunityPostResponseSchema.parse({ entry: remoteEntry(entry, owner) }),
        201
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.post('/:ref/rooms/:roomId/attachments', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    const input = attachmentHeaders(c);
    if (!input) return c.json({ error: 'Provide valid file metadata and a retry key.' }, 400);
    try {
      await verifiedConnection(ref, owner, 'post');
      const attachment = await getRemoteCommunityAdapter(ref, owner).uploadAttachment(
        c.req.param('roomId'),
        { ...input, bytes: requestBytes(c.env.incoming) }
      );
      return c.json(RemoteCommunityAttachmentResponseSchema.parse({ attachment }), 201);
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.get('/:ref/rooms/:roomId/attachments/:attachmentId', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    const { owner, ref } = target;
    let download;
    try {
      await verifiedConnection(ref, owner, 'read');
      download = await getRemoteCommunityAdapter(ref, owner).downloadAttachment(
        c.req.param('roomId'),
        c.req.param('attachmentId')
      );
    } catch (error) {
      return communityFailure(c, error);
    }
    const { attachment, bytes } = download;
    return streamToNodeResponse(c, async (res) => {
      res.setHeader('Content-Type', attachment.contentType);
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      for await (const chunk of bytes) res.write(chunk);
      res.end();
    });
  });
  router.get('/:ref/rooms/:roomId/events', remoteRoomEvents);
  router.post('/:ref/rooms/:roomId/deliveries/:idempotencyKey/retry', async (c) => {
    const owner = resolveCommunityOwner(c);
    if (typeof owner !== 'string') return owner;
    const ref = CommunityRefSchema.safeParse(c.req.param('ref'));
    const roomId = z.string().min(1).max(128).safeParse(c.req.param('roomId'));
    const idempotencyKey = z.string().min(1).max(128).safeParse(c.req.param('idempotencyKey'));
    if (!ref.success || !roomId.success || !idempotencyKey.success) {
      return c.json({ error: 'Use valid space, room, and delivery identifiers.' }, 400);
    }
    try {
      await verifiedConnection(ref.data, owner, 'post');
      const result = await retryRemoteCommunityDelivery({
        communityRef: ref.data,
        remoteRoomId: roomId.data,
        ownerAuthorId: owner,
        idempotencyKey: idempotencyKey.data,
      });
      if (result === 'missing') return c.json({ error: 'Delivery not found.' }, 404);
      if (result === 'terminal') return c.json({ error: 'Delivery cannot be retried.' }, 409);
      return c.json(
        getRemoteCommunityDeliverySnapshot(ref.data, roomId.data, owner),
        result === 'in-flight' || result === 'queued' ? 202 : 200
      );
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.post('/:ref/rooms/:roomId/halt', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    try {
      const stopped = await getRemoteCommunityLifecycle().haltRoom(
        target.ref,
        c.req.param('roomId'),
        target.owner
      );
      return c.json({ stopped });
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  router.post('/:ref/rooms/:roomId/agents/:localAgentId/halt', async (c) => {
    const target = communityTarget(c);
    if (target instanceof Response) return target;
    try {
      const stopped = await getRemoteCommunityLifecycle().haltRoomAgent(
        target.ref,
        c.req.param('roomId'),
        c.req.param('localAgentId'),
        target.owner
      );
      return c.json({ stopped });
    } catch (error) {
      return communityFailure(c, error);
    }
  });
  registerRemoteCommunityAgentRoutes(router);
  registerRemoteCommunityDmRoutes(router);
  registerRemoteCommunityConductRoutes(router);
  return router;
}
