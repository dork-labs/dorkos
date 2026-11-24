import {
  fake,
  token,
  remoteCommunityId,
  remoteAgentId,
  remoteRoomId,
  remoteAttachmentId,
  qualified,
  requests,
  directory,
  origin,
} from './fake-community.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RemoteConnectionStore, RemoteConnectionNotFoundError } from '../../connection-store.js';
import { RemoteCommunityPairingService } from '../../pairing-service.js';
import {
  RemoteCommunityAdapter,
  remoteOriginIdempotencyKeyOf,
  remoteThreadReplySeqOf,
  type RemoteNativeRoomEvent,
} from '../../remote-community-adapter.js';

describe('private remote pairing with real HTTP and encrypted local storage', () => {
  it('closes a quiet generic room subscription without requiring a caller abort', async () => {
    const adapter = new RemoteCommunityAdapter(
      'remote-generic-return' as never,
      'adapter-owner',
      new RemoteConnectionStore(directory)
    );
    let unblock: ((result: IteratorResult<RemoteNativeRoomEvent>) => void) | undefined;
    let nativeReturned = false;
    vi.spyOn(adapter, 'subscribeNativeRoom').mockImplementation(() => ({
      [Symbol.asyncIterator](): AsyncIterator<RemoteNativeRoomEvent> {
        let sentSnapshot = false;
        return {
          next: () => {
            if (!sentSnapshot) {
              sentSnapshot = true;
              return Promise.resolve({
                done: false,
                value: {
                  type: 'snapshot',
                  room: {
                    community: adapter.community,
                    roomId: 'quiet-room',
                    kind: 'channel',
                    title: 'Quiet room',
                    slug: null,
                    topic: null,
                    archived: false,
                    createdAt: new Date(0).toISOString(),
                    lastActivityAt: new Date(0).toISOString(),
                    unreadCount: 0,
                  },
                  entries: [],
                  cursor: 'quiet-cursor' as never,
                  capturedSeq: 0,
                },
              });
            }
            return new Promise<IteratorResult<RemoteNativeRoomEvent>>((resolve) => {
              unblock = resolve;
            });
          },
          return: async () => {
            nativeReturned = true;
            unblock?.({ done: true, value: undefined as never });
            return { done: true, value: undefined as never };
          },
        };
      },
    }));

    const iterator = adapter.subscribeRoom('quiet-room')[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('snapshot');
    const pending = iterator.next();

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    expect(nativeReturned).toBe(true);
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it('uses the private store for a live HTTP adapter and rejects an unowned agent before a request', async () => {
    fake.approved = true;
    const store = new RemoteConnectionStore(directory);
    const service = new RemoteCommunityPairingService(store);
    const requestStart = requests.length;
    const started = await service.start(
      'adapter-owner',
      `${origin}/c/${remoteCommunityId}`,
      'Adapter test'
    );
    expect((await service.poll(started.connection.ref, 'adapter-owner')).status).toBe('connected');
    expect(await service.status(started.connection.ref, 'adapter-owner')).toMatchObject({
      status: 'connected',
      access: {
        state: 'verified',
        effective: { read: true, post: true, enrollAgent: true, stream: true },
      },
    });
    const adapter = new RemoteCommunityAdapter(started.connection.ref, 'adapter-owner', store);
    expect((await adapter.connect()).status).toBe('connected');
    expect(await adapter.attention()).toEqual({ unreadCount: 7, mentionCount: 2 });
    expect((await adapter.listRooms()).map((item) => item.roomId)).toEqual([remoteRoomId]);
    const history = await adapter.listEntries(remoteRoomId);
    expect(history.entries).toHaveLength(1);
    expect(remoteOriginIdempotencyKeyOf(history.entries[0]!)).toBe('owner-wire-key');
    expect(history.entries[0]!.attachments).toEqual([
      {
        id: remoteAttachmentId,
        name: 'shot.png',
        contentType: 'image/png',
        byteSize: 5,
        checksum: 'checksum-1',
      },
    ]);
    // The port's own read carries no counts; the browser's read asks for them.
    expect(history.entries[0]!.thread).toBeUndefined();
    const browserHistory = await adapter.listEntriesWithThreadRoot(remoteRoomId);
    expect(browserHistory.entries[0]!.thread).toEqual({
      replyCount: 3,
      lastReplyAt: '2026-09-23T12:05:00.000Z',
    });
    expect(remoteThreadReplySeqOf(browserHistory.entries[0]!)).toBe(9);
    // A server from before the route costs the counts and never the history.
    fake.threadsAnswer = 404;
    const olderServer = await adapter.listEntriesWithThreadRoot(remoteRoomId);
    fake.threadsAnswer = 'counts';
    expect(olderServer.entries.map((item) => item.id)).toEqual(['entry-1']);
    expect(olderServer.entries[0]!.thread).toBeUndefined();
    expect(remoteThreadReplySeqOf(olderServer.entries[0]!)).toBeUndefined();
    expect(await adapter.getReadCursor(remoteRoomId)).toBe('resume-1');
    await adapter.setReadCursor(remoteRoomId, 'resume-1' as never);
    const upload = await adapter.uploadAttachment(remoteRoomId, {
      idempotencyKey: 'qualified-upload',
      name: 'proof.txt',
      contentType: 'text/plain',
      byteSize: 5,
      bytes: (async function* () {
        yield new TextEncoder().encode('hello');
      })(),
    });
    expect(upload.id).toBe(remoteAttachmentId);
    const download = await adapter.downloadAttachment(remoteRoomId, remoteAttachmentId);
    const downloaded: Uint8Array[] = [];
    for await (const chunk of download.bytes) downloaded.push(chunk);
    expect(Buffer.concat(downloaded).toString()).toBe('hello');
    const stream = adapter.subscribeNativeRoom(remoteRoomId)[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'snapshot', room: { roomId: remoteRoomId } },
    });
    await stream.return?.();
    const agent = await adapter.admitAgent({ agentId: randomUUID(), displayName: 'Test Agent' });
    expect(agent.memberId).toBe(remoteAgentId);
    expect(requests.slice(requestStart).map((request) => request.path)).toEqual(
      expect.arrayContaining([
        `${qualified}/community`,
        `${qualified}/channels`,
        `${qualified}/channels/${remoteRoomId}/entries`,
        `${qualified}/channels/${remoteRoomId}/events`,
        `${qualified}/channels/${remoteRoomId}/attachments`,
        `${qualified}/attachments/${remoteAttachmentId}`,
      ])
    );
    expect(
      requests
        .slice(requestStart)
        .filter((request) => request.path.startsWith('/api/v1/'))
        .every((request) => request.path.startsWith(qualified))
    ).toBe(true);
    await expect(adapter.listRooms({ actingMemberId: randomUUID() })).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    const metadata = await readFile(
      join(directory, 'communities', 'remote', 'connections.json'),
      'utf8'
    );
    expect(metadata).not.toContain('private-agent-token');
    await service.disconnect(started.connection.ref, 'adapter-owner');
    fake.approved = false;
    fake.pollCount = 0;
  });
});
