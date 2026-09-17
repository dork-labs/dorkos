import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunityCursorSchema } from '@dorkos/shared/community-adapter';
import { createRemoteCommunityMethods } from '../remote-community-methods';
import { communityStubs } from '../../direct/community-stubs';

const room = {
  community: 'community-a',
  roomId: 'same-id',
  remoteCommunityId: 'deployment-a',
  kind: 'channel',
  title: 'General',
  slug: 'general',
  topic: null,
  archived: false,
  createdAt: '2026-09-16T10:00:00Z',
  lastActivityAt: '2026-09-16T10:00:00Z',
  unreadCount: 0,
  visibility: 'public',
  readable: true,
  writable: true,
  joined: true,
  stale: false,
  cacheCursor: 'opaque-cursor',
  lastRemoteSeq: 1,
};
const entry = {
  community: 'community-a',
  roomId: 'same-id',
  id: 'entry-id',
  authorId: 'person',
  authorDisplayName: 'Alex',
  authorKind: 'human',
  text: 'Hello',
  mentions: [],
  parentEntryId: null,
  threadRootEntryId: null,
  depth: 0,
  cursor: 'opaque-cursor',
  createdAt: '2026-09-16T10:00:00Z',
  remoteSeq: 1,
  attachments: [],
};
const snapshot = {
  type: 'snapshot',
  room,
  entries: [entry],
  cursor: entry.cursor,
  lastRemoteSeq: 1,
  stale: false,
};
const methods = () => createRemoteCommunityMethods('/api');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function answer(data: unknown, status = 200) {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(status === 204 ? null : JSON.stringify(data), { status })
    );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function stream(...events: unknown[]) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(
          new TextEncoder().encode(
            `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
          )
        );
    },
    cancel,
  });
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetch);
  return { fetch, cancel };
}

describe('qualified remote community transport', () => {
  it('retries the exact qualified delivery and rejects a foreign replacement snapshot', async () => {
    const fetch = answer({ community: 'ref-a', roomId: 'room/b', deliveries: [] });
    await expect(
      methods().retryRemoteCommunityDelivery('ref-a', 'room/b', 'key/c')
    ).resolves.toEqual({
      community: 'ref-a',
      roomId: 'room/b',
      deliveries: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/communities/ref-a/rooms/room%2Fb/deliveries/key%2Fc/retry',
      expect.objectContaining({ method: 'POST' })
    );
    answer({ community: 'other', roomId: 'room/b', deliveries: [] });
    await expect(
      methods().retryRemoteCommunityDelivery('ref-a', 'room/b', 'key/c')
    ).rejects.toThrow('different room');
    await expect(
      communityStubs.retryRemoteCommunityDelivery('ref-a', 'room/b', 'key/c')
    ).rejects.toThrow('web or desktop');
  });

  it('changes agent membership through the qualified membership route', async () => {
    const joined = answer(null, 204);
    await methods().joinRemoteCommunityAgentRoom('community-a', 'room/id', 'manifest/id');
    expect(joined).toHaveBeenCalledWith(
      '/api/communities/community-a/rooms/room%2Fid/agents/manifest%2Fid/membership',
      expect.objectContaining({ method: 'POST' })
    );
    const left = answer({ localRevoked: true, remoteRevoked: true });
    await methods().leaveRemoteCommunityAgentRoom('community-a', 'room/id', 'manifest/id');
    expect(left).toHaveBeenCalledWith(
      '/api/communities/community-a/rooms/room%2Fid/agents/manifest%2Fid/membership',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('stops qualified local work directly without a remote permission preflight', async () => {
    const fetch = answer({ stopped: 2 });
    await expect(methods().haltRemoteCommunityRoom('ref/a', 'same/id')).resolves.toEqual({
      stopped: 2,
    });
    await expect(
      methods().haltRemoteCommunityAgent('ref/b', 'same/id', 'agent/id')
    ).resolves.toEqual({ stopped: 2 });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/communities/ref%2Fa/rooms/same%2Fid/halt',
      '/api/communities/ref%2Fb/rooms/same%2Fid/agents/agent%2Fid/halt',
    ]);
    expect(fetch.mock.calls.every(([, options]) => options.method === 'POST')).toBe(true);
    answer({ stopped: -1 });
    await expect(methods().haltRemoteCommunityRoom('a', 'b')).rejects.toThrow();
    await expect(communityStubs.haltRemoteCommunityRoom('a', 'b')).rejects.toThrow(
      'web or desktop'
    );
  });
  it('validates private delivery events against the selected community and requires a room snapshot first', async () => {
    const pending = {
      type: 'deliveries',
      community: 'community-a',
      roomId: 'same-id',
      deliveries: [],
    };
    stream(pending);
    await expect(
      methods().subscribeRemoteCommunityRoom('community-a', 'same-id', vi.fn())
    ).rejects.toThrow('begin with a snapshot');
    const foreign = stream(snapshot, { ...pending, community: 'community-b' });
    await expect(
      methods().subscribeRemoteCommunityRoom('community-a', 'same-id', vi.fn())
    ).rejects.toThrow('different room');
    expect(foreign.cancel).toHaveBeenCalled();
    stream(snapshot, pending, {
      type: 'closed',
      community: 'community-a',
      roomId: 'same-id',
      reason: 'revoked',
    });
    const onEvent = vi.fn();
    await methods().subscribeRemoteCommunityRoom('community-a', 'same-id', onEvent);
    expect(onEvent).toHaveBeenCalledWith(pending);
  });

  it('keeps identical remote room IDs under distinct local connection refs', async () => {
    const fetch = answer({ room });
    await expect(methods().getRemoteCommunityRoom('community-a', 'same-id')).resolves.toEqual(room);
    await expect(methods().getRemoteCommunityRoom('community-b', 'same-id')).rejects.toThrow(
      'different room'
    );
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/communities/community-a/rooms/same-id',
      '/api/communities/community-b/rooms/same-id',
    ]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  });

  it('uses opaque thread paging and refuses injected acting identity before sending', async () => {
    const fetch = answer({
      community: 'community-a',
      roomId: 'same-id',
      entries: [entry],
      nextCursor: null,
      lastRemoteSeq: 1,
      stale: false,
    });
    await methods().listRemoteCommunityEntries('community-a', 'same-id', {
      cursor: CommunityCursorSchema.parse('opaque+/='),
      threadRootId: 'root',
      limit: 20,
    });
    expect(fetch.mock.calls[0][0]).toContain('cursor=opaque%2B%2F%3D&limit=20&threadRootId=root');
    await expect(
      methods().postRemoteCommunityEntry('community-a', 'same-id', {
        text: 'hi',
        idempotencyKey: 'once',
        actingMemberId: 'other',
      } as never)
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not claim remote ejection when only local participation stopped', async () => {
    const fetch = answer({ localRevoked: true, remoteRevoked: false });
    await expect(
      methods().ejectRemoteCommunityAgent('community-a', 'local/agent')
    ).resolves.toEqual({ localRevoked: true, remoteRevoked: false });
    expect(fetch.mock.calls[0][0]).toBe('/api/communities/community-a/agents/local%2Fagent');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  it('preserves authorization failures and consumes no-content membership responses', async () => {
    answer({ error: 'Membership removed.', code: 'MEMBERSHIP_REMOVED' }, 403);
    await expect(methods().getRemoteCommunityRoom('community-a', 'same-id')).rejects.toMatchObject({
      status: 403,
      code: 'MEMBERSHIP_REMOVED',
    });
    answer(null, 204);
    await expect(
      methods().leaveRemoteCommunityRoom('community-a', 'same-id')
    ).resolves.toBeUndefined();
    await expect(communityStubs.getRemoteCommunityRoom('community-a', 'same-id')).rejects.toThrow(
      'web or desktop'
    );
  });

  it('uploads raw file bytes with encoded metadata and refuses oversized bytes', async () => {
    const attachment = {
      id: 'file',
      name: 'résumé 📎.png',
      contentType: 'image/png',
      byteSize: 3,
      checksum: 'sha',
    };
    const fetch = answer({ attachment });
    const file = new File(['abc'], attachment.name, { type: attachment.contentType });
    await expect(
      methods().uploadRemoteCommunityAttachment('community-a', 'same-id', file, 'stable')
    ).resolves.toEqual(attachment);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/communities/community-a/rooms/same-id/attachments');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(attachment.name),
        'x-file-content-type': attachment.contentType,
        'x-file-size': '3',
        'idempotency-key': 'stable',
      },
    });
    expect(options.body).toBe(file);
    await expect((options.body as File).text()).resolves.toBe('abc');
    await expect(
      methods().uploadRemoteCommunityAttachment(
        'community-a',
        'same-id',
        { size: 25 * 1024 * 1024 + 1 } as File,
        'stable'
      )
    ).rejects.toThrow('25 MB');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caps actual downloaded bytes even when a response lies about its length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1));
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Length': '1' } }))
    );
    await expect(
      methods().downloadRemoteCommunityAttachment('community-a', 'same-id', 'file')
    ).rejects.toThrow('25 MB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('delivers a qualified snapshot and closes the pending reader on owner cancellation', async () => {
    const { fetch, cancel } = stream(snapshot);
    const controller = new AbortController();
    const onEvent = vi.fn(() => controller.abort());
    await methods().subscribeRemoteCommunityRoom('community-a', 'same-id', onEvent, {
      since: 'resume+/=',
      signal: controller.signal,
    });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain(
      '/communities/community-a/rooms/same-id/events?since=resume%2B%2F%3D'
    );
  });

  it('refuses foreign-room stream data and cancels the response body', async () => {
    const { cancel } = stream({
      ...snapshot,
      room: { ...room, community: 'community-b' },
      entries: [],
    });
    const onEvent = vi.fn();
    await expect(
      methods().subscribeRemoteCommunityRoom('community-a', 'same-id', onEvent)
    ).rejects.toThrow('different room');
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('requires snapshot-first and treats a closure as terminal without waiting for EOF', async () => {
    stream({ type: 'entry', entry });
    await expect(
      methods().subscribeRemoteCommunityRoom('community-a', 'same-id', vi.fn())
    ).rejects.toThrow('snapshot');
    const { cancel } = stream({
      type: 'closed',
      community: 'community-a',
      roomId: 'same-id',
      reason: 'revoked',
    });
    const onEvent = vi.fn();
    await expect(
      methods().subscribeRemoteCommunityRoom('community-a', 'same-id', onEvent)
    ).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'closed', reason: 'revoked' })
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps an established stream alive beyond the request deadline and aborts a parked read', async () => {
    vi.useFakeTimers();
    const { fetch, cancel } = stream(snapshot);
    const controller = new AbortController();
    let received!: () => void;
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    const running = methods().subscribeRemoteCommunityRoom('community-a', 'same-id', received, {
      signal: controller.signal,
    });
    await ready;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not silently report a dropped stream as a completed subscription', async () => {
    const bytes = new TextEncoder().encode(
      `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(bytes, { headers: { 'Content-Type': 'text/event-stream' } })
        )
    );
    const onEvent = vi.fn();
    await expect(
      methods().subscribeRemoteCommunityRoom('community-a', 'same-id', onEvent)
    ).rejects.toThrow('connection ended');
    expect(onEvent).toHaveBeenCalledOnce();
  });
});
