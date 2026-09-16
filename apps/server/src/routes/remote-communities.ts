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
import {
  CommunityRefSchema,
  type CommunityEntry,
  type CommunityRoom,
} from '@dorkos/shared/community-adapter';
import {
  RemoteCommunityHistoryResponseSchema,
  RemoteCommunityMembersResponseSchema,
  RemoteCommunityReadCursorSchema,
  RemoteCommunityRoomResponseSchema,
  RemoteCommunityRoomsResponseSchema,
} from '@dorkos/shared/community-views';
import { resolveCommunityOwner } from './community-connections.js';
import {
  getRemoteCommunityAdapter,
  getRemoteConnectionStore,
} from '../services/communities/remote/state.js';
import {
  remoteAuthorOf,
  remoteRoomAccessOf,
  remoteSequenceOf,
} from '../services/communities/remote/remote-community-adapter.js';

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

function remoteEntry(entry: CommunityEntry) {
  const seq = remoteSequenceOf(entry);
  const author = remoteAuthorOf(entry);
  if (seq === undefined || !author)
    throw new Error('Native remote entry lost authoritative metadata');
  return {
    ...entry,
    remoteSeq: seq,
    authorDisplayName: author.displayName,
    authorKind: author.kind,
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
      const entries = page.entries.map(remoteEntry);
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
  return router;
}
