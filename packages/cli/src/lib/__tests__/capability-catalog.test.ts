/**
 * Tests for `fetchFullCatalog()` — the CLI's pager over the now-paginated
 * `GET /api/capabilities/catalog` (DOR-940).
 *
 * The endpoint bounds each response, so this helper is the silent-truncation
 * safety net: it must follow every `nextCursor` to the end and stop only when one
 * is absent. A single-page mock would never exercise that loop, so the load-bearing
 * case here is the two-page one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api-client.js', () => ({ apiCall: vi.fn() }));

import { apiCall } from '../api-client.js';
import { fetchFullCatalog } from '../capability-catalog.js';

const apiCallMock = vi.mocked(apiCall);

/** A minimal full catalog entry keyed by id. */
const cap = (id: string) => ({ id, title: id, description: 'd', tier: 'observe' });

const FIRST_PAGE = '/api/capabilities/catalog?detail=full&limit=200';
const SECOND_PAGE = '/api/capabilities/catalog?detail=full&limit=200&cursor=CURSOR2';

beforeEach(() => {
  apiCallMock.mockReset();
});

describe('fetchFullCatalog', () => {
  it('follows nextCursor across pages and returns the whole catalog, in order, de-duped', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        catalogVersion: 'v1',
        generatedAt: 'T',
        nextCursor: 'CURSOR2',
        capabilities: [cap('a.one'), cap('b.two')],
      })
      .mockResolvedValueOnce({
        catalogVersion: 'v1',
        generatedAt: 'T',
        capabilities: [cap('c.three')],
      });

    const catalog = await fetchFullCatalog();

    // Every entry from both pages, concatenated in the server's id order.
    expect(catalog.capabilities.map((c) => c.id)).toEqual(['a.one', 'b.two', 'c.three']);
    // No page bled into the next: no duplicate ids.
    expect(new Set(catalog.capabilities.map((c) => c.id)).size).toBe(catalog.capabilities.length);
    expect(catalog.catalogVersion).toBe('v1');

    // Exactly two requests: page one with no cursor, page two carrying nextCursor.
    expect(apiCallMock).toHaveBeenCalledTimes(2);
    expect(apiCallMock).toHaveBeenNthCalledWith(1, 'GET', FIRST_PAGE);
    expect(apiCallMock).toHaveBeenNthCalledWith(2, 'GET', SECOND_PAGE);
  });

  it('stops after one request when the first page has no nextCursor', async () => {
    apiCallMock.mockResolvedValueOnce({
      catalogVersion: 'v9',
      generatedAt: 'T',
      capabilities: [cap('only.one')],
    });

    const catalog = await fetchFullCatalog();

    expect(catalog.capabilities.map((c) => c.id)).toEqual(['only.one']);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(apiCallMock).toHaveBeenNthCalledWith(1, 'GET', FIRST_PAGE);
  });
});
