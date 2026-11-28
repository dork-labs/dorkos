/**
 * A whole-list read follows `nextCursor` to the end, in server order, and
 * stops rather than spin when a server repeats a cursor or never ends
 * (DOR-4982), as the app's own reads do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAllPages } from '../read-all-pages.js';

type Page = { rows: string[]; nextCursor: string | null };

/** Answer each request with the next page, recording the URLs asked for. */
function serve(next: (call: number) => Page) {
  let call = 0;
  const fetchMock = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => next(call++),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('readAllPages', () => {
  it('reads every page in order', async () => {
    const pages: Page[] = [
      { rows: ['b', 'a'], nextCursor: 'c1' },
      { rows: ['z'], nextCursor: null },
    ];
    const fetchMock = serve((call) => pages[call]!);
    const { rows } = await readAllPages('/api/x', {}, (p: Page) => p.rows);
    expect(rows).toEqual(['b', 'a', 'z']);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/api\/x\?cursor=c1&limit=200$/);
  });

  it('stops when a cursor comes back twice', async () => {
    serve(() => ({ rows: ['a'], nextCursor: 'same' }));
    await expect(readAllPages('/api/x', {}, (p: Page) => p.rows)).rejects.toThrow(
      /kept giving more pages/
    );
  });

  it('stops at 50 pages when the list never ends', async () => {
    const fetchMock = serve((call) => ({ rows: ['a'], nextCursor: `c${call}` }));
    await expect(readAllPages('/api/x', {}, (p: Page) => p.rows)).rejects.toThrow(
      /stopped after 50/
    );
    expect(fetchMock).toHaveBeenCalledTimes(50);
  });
});
