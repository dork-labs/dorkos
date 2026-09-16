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
import { Router } from 'express';
import { z } from 'zod';
import {
  CommunityRefSchema,
  type CommunityEntry,
  type CommunityRoom,
} from '@dorkos/shared/community-adapter';
import {
  RemoteCommunityHistoryResponseSchema,
  RemoteCommunityAttachmentResponseSchema,
  RemoteCommunityEjectionResponseSchema,
  RemoteCommunityEnrollmentResponseSchema,
  RemoteCommunityEnrollmentsResponseSchema,
  RemoteCommunityEnrollRequestSchema,
  RemoteCommunityEventSchema,
  RemoteCommunityMembersResponseSchema,
  RemoteCommunityPostRequestSchema,
  RemoteCommunityPostResponseSchema,
  RemoteCommunityReadCursorSchema,
  RemoteCommunityRoomResponseSchema,
  RemoteCommunityRoomsResponseSchema,
} from '@dorkos/shared/community-views';
import { resolveCommunityOwner } from './community-connections.js';
import {
  getRemoteCommunityAdapter,
  getRemoteConnectionStore,
  getRemoteCommunityDeliverySnapshot,
  getRemoteCommunityEnrollmentStore,
  getRemoteCommunityLifecycle,
  getRemoteCommunityOriginIdempotencyKey,
  onRemoteCommunityDeliveryChange,
  resolveRemoteCommunityLocalAgent,
  retryRemoteCommunityDelivery,
} from '../services/communities/remote/state.js';
import { getRoomService } from '../services/rooms/index.js';
import {
  remoteAuthorOf,
  remoteOriginIdempotencyKeyOf,
  remoteRoomAccessOf,
  remoteSequenceOf,
} from '../services/communities/remote/remote-community-adapter.js';

const attachmentHeadersSchema = z.object({
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  byteSize: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(25 * 1024 * 1024),
  idempotencyKey: z.string().min(1).max(128),
});

/** Write one strict event payload without exposing adapter or credential state. */
function writeEvent(res: import('express').Response, event: unknown): void {
  const parsed = RemoteCommunityEventSchema.parse(event);
  res.write(`event: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`);
}

/** Turn an incoming HTTP byte stream into the adapter's portable byte source. */
async function* requestBytes(req: import('express').Request): AsyncIterable<Uint8Array> {
  for await (const chunk of req) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
}

function fail(res: import('express').Response, error: unknown): void {
  const status =
    error instanceof Error && error.name === 'RemoteConnectionNotFoundError' ? 404 : 502;
  res
    .status(status)
    .json({ error: status === 404 ? 'Community connection not found.' : 'Community unavailable.' });
}

function remoteRoom(room: CommunityRoom, remoteCommunityId: string) {
  const access = remoteRoomAccessOf(room);
  if (!access) throw new Error('Native remote room lost visibility metadata');
  return {
    ...room,
    remoteCommunityId,
    visibility: access.visibility,
    readable: access.visibility === 'public' || access.joined,
    writable: access.joined && !room.archived,
    joined: access.joined,
    stale: false,
    cacheCursor: null,
    lastRemoteSeq: 0,
  };
}

function remoteEntry(entry: CommunityEntry, ownerAuthorId?: string) {
  const seq = remoteSequenceOf(entry);
  const author = remoteAuthorOf(entry);
  if (seq === undefined || !author)
    throw new Error('Native remote entry lost authoritative metadata');
  const originIdempotencyKey =
    ownerAuthorId && author.kind === 'agent'
      ? (getRemoteCommunityOriginIdempotencyKey(
          entry.community,
          entry.roomId,
          ownerAuthorId,
          entry.id
        ) ?? remoteOriginIdempotencyKeyOf(entry))
      : null;
  return {
    ...entry,
    remoteSeq: seq,
    authorDisplayName: author.displayName,
    authorKind: author.kind,
    ...(originIdempotencyKey ? { originIdempotencyKey } : {}),
  };
}

/** Build routes for remote community discovery and read-only qualified views. */
export function createRemoteCommunitiesRouter(): Router {
  const router = Router();
  router.get('/:ref/rooms', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const store = getRemoteConnectionStore();
      const connection = await store.get(ref.data, owner);
      const adapter = getRemoteCommunityAdapter(ref.data, owner);
      const connected = await adapter.connect();
      if (connected.status !== 'connected') throw new Error('Community unavailable');
      const rooms = (await adapter.listRooms()).map((room) =>
        remoteRoom(room, connection.remoteCommunityId)
      );
      res.json(
        RemoteCommunityRoomsResponseSchema.parse({ community: ref.data, rooms, stale: false })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/:ref/rooms/:roomId', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const store = getRemoteConnectionStore();
      const connection = await store.get(ref.data, owner);
      const room = await getRemoteCommunityAdapter(ref.data, owner).getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: 'Room not found.' });
      res.json(
        RemoteCommunityRoomResponseSchema.parse({
          room: remoteRoom(room, connection.remoteCommunityId),
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/:ref/rooms/:roomId/entries', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return res.status(400).json({ error: 'Use a history limit from 1 through 100.' });
    try {
      const page = await getRemoteCommunityAdapter(ref.data, owner).listEntriesWithThreadRoot(
        req.params.roomId,
        {
          cursor: typeof req.query.cursor === 'string' ? (req.query.cursor as never) : undefined,
          limit,
          thread: typeof req.query.threadRootId === 'string' ? req.query.threadRootId : undefined,
        }
      );
      const entries = page.entries.map((entry) => remoteEntry(entry, owner));
      const lastRemoteSeq = entries.at(-1)?.remoteSeq ?? 0;
      res.json(
        RemoteCommunityHistoryResponseSchema.parse({
          community: ref.data,
          roomId: req.params.roomId,
          entries,
          nextCursor: page.nextCursor,
          lastRemoteSeq,
          stale: false,
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/:ref/rooms/:roomId/read-cursor', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const adapter = getRemoteCommunityAdapter(ref.data, owner);
      const [cursor, room] = await Promise.all([
        adapter.getReadCursor(req.params.roomId),
        adapter.getRoom(req.params.roomId),
      ]);
      if (!room) return res.status(404).json({ error: 'Room not found.' });
      res.json(
        RemoteCommunityReadCursorSchema.parse({ cursor, unreadCount: room.unreadCount ?? 0 })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.put('/:ref/rooms/:roomId/read-cursor', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    const cursor = typeof req.body?.cursor === 'string' ? req.body.cursor : null;
    if (!owner || !ref.success) return;
    if (!cursor) return res.status(400).json({ error: 'A cursor is required.' });
    try {
      const adapter = getRemoteCommunityAdapter(ref.data, owner);
      await adapter.setReadCursor(req.params.roomId, cursor as never);
      const room = await adapter.getRoom(req.params.roomId);
      if (!room) return res.status(404).json({ error: 'Room not found.' });
      res.json(
        RemoteCommunityReadCursorSchema.parse({ cursor, unreadCount: room.unreadCount ?? 0 })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/:ref/rooms/:roomId/membership', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const connection = await getRemoteConnectionStore().get(ref.data, owner);
      const room = await getRemoteCommunityAdapter(ref.data, owner).joinRoom(req.params.roomId);
      res.json(
        RemoteCommunityRoomResponseSchema.parse({
          room: remoteRoom(room, connection.remoteCommunityId),
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.delete('/:ref/rooms/:roomId/membership', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      await getRemoteCommunityAdapter(ref.data, owner).leaveRoom(req.params.roomId);
      res.status(204).end();
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/:ref/rooms/:roomId/members', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const members = await getRemoteCommunityAdapter(ref.data, owner).listMembers(
        req.params.roomId
      );
      res.json(
        RemoteCommunityMembersResponseSchema.parse({
          community: ref.data,
          roomId: req.params.roomId,
          members,
          stale: false,
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/:ref/rooms/:roomId/entries', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    const input = RemoteCommunityPostRequestSchema.safeParse(req.body);
    if (!owner || !ref.success) return;
    if (!input.success) {
      res.status(400).json({ error: 'Enter a message with a valid retry key.' });
      return;
    }
    try {
      const entry = await getRemoteCommunityAdapter(ref.data, owner).postEntry(
        req.params.roomId,
        input.data
      );
      res
        .status(201)
        .json(RemoteCommunityPostResponseSchema.parse({ entry: remoteEntry(entry, owner) }));
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/:ref/rooms/:roomId/attachments', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    const input = attachmentHeadersSchema.safeParse({
      name: req.header('x-file-name'),
      contentType: req.header('content-type')?.split(';', 1)[0],
      byteSize: req.header('x-file-size'),
      idempotencyKey: req.header('idempotency-key'),
    });
    if (!input.success) {
      res.status(400).json({ error: 'Provide valid file metadata and a retry key.' });
      return;
    }
    try {
      const attachment = await getRemoteCommunityAdapter(ref.data, owner).uploadAttachment(
        req.params.roomId,
        { ...input.data, bytes: requestBytes(req) }
      );
      res.status(201).json(RemoteCommunityAttachmentResponseSchema.parse({ attachment }));
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/:ref/rooms/:roomId/attachments/:attachmentId', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const download = await getRemoteCommunityAdapter(ref.data, owner).downloadAttachment(
        req.params.roomId,
        req.params.attachmentId
      );
      res.setHeader('Content-Type', download.attachment.contentType);
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      for await (const chunk of download.bytes) res.write(chunk);
      res.end();
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/:ref/rooms/:roomId/events', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    const abort = new AbortController();
    req.once('close', () => abort.abort());
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let sawSnapshot = false;
    const writeDeliveries = () => {
      if (!sawSnapshot || abort.signal.aborted || res.writableEnded) return;
      const deliveries = getRemoteCommunityDeliverySnapshot(ref.data, req.params.roomId, owner);
      writeEvent(res, { type: 'deliveries', ...deliveries });
    };
    const removeDeliveryListener = onRemoteCommunityDeliveryChange((changedOwnerAuthorId) => {
      if (changedOwnerAuthorId === owner) writeDeliveries();
    });
    try {
      const adapter = getRemoteCommunityAdapter(ref.data, owner);
      for await (const event of adapter.subscribeRoom(
        req.params.roomId,
        typeof req.query.since === 'string' ? (req.query.since as never) : undefined,
        abort.signal
      )) {
        if (event.type === 'snapshot') {
          const connection = await getRemoteConnectionStore().get(ref.data, owner);
          const entries = event.entries.map((entry) => remoteEntry(entry, owner));
          writeEvent(res, {
            type: 'snapshot',
            room: remoteRoom(event.room, connection.remoteCommunityId),
            entries,
            cursor: event.cursor,
            lastRemoteSeq: entries.at(-1)?.remoteSeq ?? 0,
            stale: false,
          });
          sawSnapshot = true;
          writeDeliveries();
        } else if (event.type === 'entry') {
          const author = remoteAuthorOf(event.entry);
          if (!author) throw new Error('Native remote entry lost authoritative metadata');
          writeEvent(res, { type: 'entry', entry: remoteEntry(event.entry, owner) });
        } else if (event.type === 'room_closed') {
          writeEvent(res, {
            type: 'closed',
            community: ref.data,
            roomId: req.params.roomId,
            reason: event.reason === 'access-revoked' ? 'revoked' : 'unavailable',
          });
          break;
        }
      }
    } catch (error) {
      if (!abort.signal.aborted)
        writeEvent(res, {
          type: 'closed',
          community: ref.data,
          roomId: req.params.roomId,
          reason: 'unavailable',
        });
    } finally {
      removeDeliveryListener();
      if (!res.writableEnded) res.end();
    }
  });
  router.post('/:ref/rooms/:roomId/deliveries/:idempotencyKey/retry', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    if (!owner) return;
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    const roomId = z.string().min(1).max(128).safeParse(req.params.roomId);
    const idempotencyKey = z.string().min(1).max(128).safeParse(req.params.idempotencyKey);
    if (!ref.success || !roomId.success || !idempotencyKey.success) {
      res.status(400).json({ error: 'Use valid community, room, and delivery identifiers.' });
      return;
    }
    try {
      const result = await retryRemoteCommunityDelivery({
        communityRef: ref.data,
        remoteRoomId: roomId.data,
        ownerAuthorId: owner,
        idempotencyKey: idempotencyKey.data,
      });
      if (result === 'missing') return res.status(404).json({ error: 'Delivery not found.' });
      if (result !== 'retried')
        return res.status(409).json({ error: 'Delivery cannot be retried.' });
      res.json(getRemoteCommunityDeliverySnapshot(ref.data, roomId.data, owner));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/:ref/rooms/:roomId/halt', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const stopped = await getRemoteCommunityLifecycle().haltRoom(
        ref.data,
        req.params.roomId,
        owner
      );
      res.json({ stopped: stopped > 0 });
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/:ref/rooms/:roomId/agents/:localAgentId/halt', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const stopped = await getRemoteCommunityLifecycle().haltRoomAgent(
        ref.data,
        req.params.roomId,
        req.params.localAgentId,
        owner
      );
      res.json({ stopped: stopped > 0 });
    } catch (error) {
      fail(res, error);
    }
  });
  router.get('/:ref/agents', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const [agents, bindings] = await Promise.all([
        getRemoteCommunityAdapter(ref.data, owner).listEnrolledAgents(),
        Promise.resolve(getRemoteCommunityEnrollmentStore().activeForOwner(ref.data, owner)),
      ]);
      const author = getRoomService().authorRegistry.getById(owner);
      const byRemoteId = new Map(agents.map((agent) => [agent.memberId, agent]));
      const adapter = getRemoteCommunityAdapter(ref.data, owner);
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
                community: ref.data,
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
      res.json(
        RemoteCommunityEnrollmentsResponseSchema.parse({ community: ref.data, agents: rows })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/:ref/agents/:localAgentId/enroll', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    const input = RemoteCommunityEnrollRequestSchema.safeParse(req.body ?? {});
    if (!input.success) {
      res.status(400).json({ error: 'Use a valid community handle.' });
      return;
    }
    try {
      const localAgent = resolveRemoteCommunityLocalAgent(req.params.localAgentId);
      if (!localAgent) return res.status(404).json({ error: 'Local agent not found.' });
      const adapter = getRemoteCommunityAdapter(ref.data, owner);
      const member = await adapter.recoverAgent({
        // Keep the public Mesh manifest id durable. The local author id is
        // intentionally private and is resolved again at dispatch time.
        agentId: req.params.localAgentId,
        displayName: localAgent.displayName,
        ...(input.data.handle ? { handle: input.data.handle } : {}),
      });
      getRemoteCommunityLifecycle().refreshSubscriptions();
      res.status(201).json(
        RemoteCommunityEnrollmentResponseSchema.parse({
          agent: {
            community: ref.data,
            localAgentId: req.params.localAgentId,
            remoteMemberId: member.memberId,
            displayName: member.displayName,
            ownerMemberId: member.ownerMemberId ?? '',
            ownerDisplayName:
              getRoomService().authorRegistry.getById(owner)?.displayName ?? 'Owner',
            roomIds: [],
            active: true,
          },
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  router.delete('/:ref/agents/:localAgentId', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const enrollments = getRemoteCommunityEnrollmentStore();
      const binding = enrollments.findAnyRemoteMember(ref.data, req.params.localAgentId, owner);
      if (!binding) return res.status(404).json({ error: 'Agent enrollment not found.' });
      // Fence the exact local enrollment before any remote cleanup. This aborts
      // its stream and pending work, revokes only its mirror accessors, and
      // prevents a directory pass already in flight from restoring that grant.
      await getRemoteCommunityLifecycle().revokeEnrollment(
        ref.data,
        req.params.localAgentId,
        owner
      );
      let remoteRevoked = true;
      try {
        await getRemoteCommunityAdapter(ref.data, owner).revokeAgent(binding.remoteMemberId);
      } catch {
        remoteRevoked = false;
      }
      getRemoteCommunityLifecycle().refreshSubscriptions();
      res.json(RemoteCommunityEjectionResponseSchema.parse({ localRevoked: true, remoteRevoked }));
    } catch (error) {
      fail(res, error);
    }
  });
  router.post('/:ref/rooms/:roomId/agents/:localAgentId/membership', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const binding = getRemoteCommunityEnrollmentStore().findRemoteMember(
        ref.data,
        req.params.localAgentId,
        owner
      );
      if (!binding) return res.status(404).json({ error: 'Active agent enrollment not found.' });
      await getRemoteCommunityAdapter(ref.data, owner).addMember(
        req.params.roomId,
        binding.remoteMemberId
      );
      getRemoteCommunityLifecycle().refreshSubscriptions();
      res.status(204).end();
    } catch (error) {
      fail(res, error);
    }
  });
  router.delete('/:ref/rooms/:roomId/agents/:localAgentId/membership', async (req, res) => {
    const owner = resolveCommunityOwner(req, res);
    const ref = CommunityRefSchema.safeParse(req.params.ref);
    if (!owner || !ref.success) return;
    try {
      const binding = getRemoteCommunityEnrollmentStore().findRemoteMember(
        ref.data,
        req.params.localAgentId,
        owner
      );
      if (!binding) return res.status(404).json({ error: 'Active agent enrollment not found.' });
      await getRemoteCommunityAdapter(ref.data, owner).removeMember(
        req.params.roomId,
        binding.remoteMemberId
      );
      await getRemoteCommunityLifecycle().leaveRoom(
        ref.data,
        req.params.roomId,
        req.params.localAgentId,
        owner
      );
      res.json(
        RemoteCommunityEjectionResponseSchema.parse({ localRevoked: true, remoteRevoked: true })
      );
    } catch (error) {
      fail(res, error);
    }
  });
  return router;
}
