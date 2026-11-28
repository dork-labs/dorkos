/** The backup calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupsMethods } from '../backups-methods';

/** Answer every request with one JSON body, and record what was sent. */
function answer(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL, method (`fetch` sends GET when none is named) and body of the first request. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, method: init?.method ?? 'GET', body: init?.body };
}

afterEach(() => vi.unstubAllGlobals());

describe('createBackupsMethods', () => {
  const methods = createBackupsMethods('/api');

  it('lists, removes and moves a copy at its encoded name', async () => {
    let fetchMock = answer({ copies: [] });
    await methods.listBackups();
    expect(sent(fetchMock)).toEqual({ url: '/api/config/backups', method: 'GET', body: undefined });

    fetchMock = answer({ ok: true });
    await methods.removeBackup('a b/c.db');
    expect(sent(fetchMock)).toEqual({
      url: '/api/config/backups/a%20b%2Fc.db',
      method: 'DELETE',
      body: undefined,
    });

    fetchMock = answer({ ok: true });
    await methods.moveBackup('a.db', '/Volumes/x');
    expect(sent(fetchMock)).toEqual({
      url: '/api/config/backups/a.db/move',
      method: 'POST',
      body: '{"destination":"/Volumes/x"}',
    });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
  });

  it('gives a move ten minutes and every other call the usual 30 seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      answer({ ok: true });
      await methods.moveBackup('a.db', '/Volumes/x');
      expect(timeout).toHaveBeenLastCalledWith(10 * 60_000);

      answer({ copies: [] });
      await methods.listBackups();
      expect(timeout).toHaveBeenLastCalledWith(30_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
