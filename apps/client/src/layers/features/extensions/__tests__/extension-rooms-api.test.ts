/**
 * @vitest-environment jsdom
 */
/**
 * `api.rooms` in the browser (DOR-3017): every call goes to THIS mini app's own
 * routes, the writes carry the window's client id, a refusal throws a
 * `RoomAccessError` with the server's code, and a thread stream closes when the
 * mini app deactivates.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RoomAccessError } from '@dorkos/extension-api';
import { createExtensionRoomsApi } from '../model/extension-rooms-api';

/** A fetch that answers once with this status and body. */
function answer(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
}

/** A stand-in EventSource that records what it was opened on and lets a test emit. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (event: MessageEvent<string>) => void) {
    this.listeners.set(name, fn);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.rooms', () => {
  it('reads a thread from this mini app’s own route', async () => {
    const fetchMock = answer(200, { roomId: 'r1', replies: [] });
    vi.stubGlobal('fetch', fetchMock);
    const rooms = createExtensionRoomsApi('social', []);

    await rooms.readThread('r1', 'e1');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/extensions/social/rooms/r1/threads/e1');
  });

  it('replies with the window’s client id and the text, never an author', async () => {
    const fetchMock = answer(201, { id: 'e2', text: 'Looks good' });
    vi.stubGlobal('fetch', fetchMock);
    const rooms = createExtensionRoomsApi('social', []);

    await rooms.reply('r1', 'e1', 'Looks good');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/extensions/social/rooms/r1/threads/e1/replies');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Client-Id']).toMatch(/^web-/);
    expect(JSON.parse(init.body)).toEqual({ text: 'Looks good' });
  });

  it('throws the server’s refusal as a RoomAccessError with its code', async () => {
    vi.stubGlobal(
      'fetch',
      answer(403, { error: 'This mini app may not use that room.', code: 'room_not_allowed' })
    );
    const rooms = createExtensionRoomsApi('social', []);

    const err = await rooms.reply('r1', 'e1', 'hi').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RoomAccessError);
    expect(err).toMatchObject({
      code: 'room_not_allowed',
      message: 'This mini app may not use that room.',
    });
  });

  it('asks about many threads in one call, and none for an empty list', async () => {
    const fetchMock = answer(200, { counts: { a: 2, b: 0 } });
    vi.stubGlobal('fetch', fetchMock);
    const rooms = createExtensionRoomsApi('social', []);

    expect(await rooms.unreadCounts('r1', [])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rooms.unreadCounts('r1', ['a', 'b'])).toEqual({ a: 2, b: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/extensions/social/rooms/r1/unread?threads=a%2Cb');
  });

  it('marks read with the window’s client id', async () => {
    const fetchMock = answer(204, {});
    vi.stubGlobal('fetch', fetchMock);
    await createExtensionRoomsApi('social', []).markRead('r1', 'e1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/extensions/social/rooms/r1/threads/e1/read');
    expect(init).toMatchObject({ method: 'PUT' });
    expect(init.headers['X-Client-Id']).toMatch(/^web-/);
  });

  it('streams replies and closes the stream when the mini app deactivates', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const cleanups: Array<() => void> = [];
    const seen: unknown[] = [];
    createExtensionRoomsApi('social', cleanups).subscribeThread('r1', 'e1', (e) => seen.push(e));
    const source = FakeEventSource.last!;

    expect(source.url).toBe('/api/extensions/social/rooms/r1/threads/e1/events');
    source.emit('reply', { id: 'e3', text: 'New' });
    expect(seen).toEqual([{ id: 'e3', text: 'New' }]);

    for (const cleanup of cleanups) cleanup();
    expect(source.closed).toBe(true);
  });

  it('stops listening when asked, and leaves nothing for deactivate to close', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const cleanups: Array<() => void> = [];
    const stop = createExtensionRoomsApi('social', cleanups).subscribeThread('r1', 'e1', () => {});
    stop();
    expect(FakeEventSource.last!.closed).toBe(true);
    expect(cleanups).toHaveLength(0);
  });

  it('turns a network failure into an unavailable refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const err = await createExtensionRoomsApi('social', [])
      .listRooms()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unavailable' });
  });
});
