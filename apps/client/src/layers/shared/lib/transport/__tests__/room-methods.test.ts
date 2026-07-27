// @vitest-environment jsdom
/**
 * `postToRoom` — the room write. Its URL and method are the whole contract with
 * `POST /api/rooms/:id/entries`, and a typo in either fails only at runtime,
 * where the mock Transport every component test uses cannot see it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoomMethods } from '../room-methods';

function setup() {
  return createRoomMethods('http://localhost:4242/api');
}

/** The URL and `RequestInit` the last `fetch` call was made with. */
function lastCall(): [string, RequestInit] {
  const call = vi.mocked(globalThis.fetch).mock.calls.at(-1)!;
  return [call[0] as string, call[1] as RequestInit];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ accepted: true, entryId: 'entry-1', seq: 7 }),
    })
  );
});

describe('postToRoom', () => {
  it('posts the message to the room it names', async () => {
    await setup().postToRoom('room-1', { text: 'ship it' });
    const [url, init] = lastCall();
    expect(url).toBe('http://localhost:4242/api/rooms/room-1/entries');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ text: 'ship it' }));
  });

  it('returns the accepted entry’s identity, not the entry', async () => {
    const accepted = await setup().postToRoom('room-1', { text: 'ship it' });
    expect(accepted).toEqual({ accepted: true, entryId: 'entry-1', seq: 7 });
  });

  it('rejects with the server’s own sentence, so it can be shown as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: () => Promise.resolve({ error: 'This room is archived', code: 'ROOM_ARCHIVED' }),
      })
    );
    await expect(setup().postToRoom('room-1', { text: 'anyone still here?' })).rejects.toThrow(
      'This room is archived'
    );
  });
});
