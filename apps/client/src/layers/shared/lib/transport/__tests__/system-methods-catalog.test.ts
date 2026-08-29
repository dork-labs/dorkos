// @vitest-environment jsdom
/**
 * `getCapabilityCatalog` — the one Transport method whose correctness lives in
 * the QUERY STRING it sends and in a check it makes on the way back, neither of
 * which anything above this seam can see (DOR-1611).
 *
 * `GET /api/capabilities/catalog` serves the agent-facing projection: bounded at
 * 50 entries, sorted by id, and COMPACT unless asked otherwise — and a compact
 * entry carries neither `surfaces` nor `toolGroup`. So a request that forgets
 * `detail=full` comes back well-formed, 200, and useless, and a request that
 * forgets `limit` comes back TRUNCATED, which is indistinguishable from a small
 * catalog to every caller that counts what it got. Both failures render an empty
 * or short list with nothing throwing anywhere, which is why they are pinned
 * here against a real `Response` rather than a mocked Transport.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_CAPABILITY_LIMIT } from '@dorkos/shared/capabilities';
import { createSystemMethods } from '../system-methods';

const BASE = 'http://localhost:4242/api';

/** One full catalog entry, in the shape `detail=full` really serves. */
function entry(id: string, toolName: string, toolGroup?: string) {
  return {
    id,
    title: id,
    description: 'x',
    tier: 'act',
    inputSchema: {},
    outputSchema: {},
    surfaces: { mcp: { toolName, servers: ['external'] } },
    ...(toolGroup ? { toolGroup } : {}),
  };
}

/** Answer the next fetch with this page envelope. */
function servePage(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  );
}

/** The URL the last `fetch` call was made with. */
function lastUrl(): string {
  return vi.mocked(globalThis.fetch).mock.calls.at(-1)![0] as string;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('getCapabilityCatalog', () => {
  it('asks for full detail and the page ceiling, so the answer is neither compact nor short', async () => {
    servePage({ catalogVersion: 'v1', generatedAt: 'now', total: 0, capabilities: [] });

    await createSystemMethods(BASE).getCapabilityCatalog();

    const url = new URL(lastUrl());
    expect(url.pathname).toBe('/api/capabilities/catalog');
    expect(url.searchParams.get('detail')).toBe('full');
    expect(url.searchParams.get('limit')).toBe(String(MAX_CAPABILITY_LIMIT));
    // No filter asked for, so none sent — the caller gets the whole catalog.
    expect(url.searchParams.get('toolGroup')).toBeNull();
  });

  it('narrows to one grant when asked, which is what keeps the page to one request', async () => {
    servePage({ catalogVersion: 'v1', generatedAt: 'now', total: 0, capabilities: [] });

    await createSystemMethods(BASE).getCapabilityCatalog({ toolGroup: 'roomsManage' });

    expect(new URL(lastUrl()).searchParams.get('toolGroup')).toBe('roomsManage');
  });

  it('unwraps the paging envelope to the catalog the port promises', async () => {
    // The route's envelope — `total`, `returned`, `offset`, `detail` — is its own
    // contract. Leaking it through this seam would make every caller learn a
    // pagination story it has no use for.
    servePage({
      catalogVersion: 'v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      total: 1,
      returned: 1,
      offset: 0,
      detail: 'full',
      capabilities: [entry('rooms.create', 'create_room', 'roomsManage')],
    });

    const catalog = await createSystemMethods(BASE).getCapabilityCatalog({
      toolGroup: 'roomsManage',
    });

    expect(catalog).toEqual({
      catalogVersion: 'v1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      capabilities: [entry('rooms.create', 'create_room', 'roomsManage')],
    });
  });

  it('refuses a truncated page rather than handing back a short list as a complete one', async () => {
    // The failure this exists for. Every reader DERIVES something from the whole
    // set — the tools behind a grant, and a count rendered beside them — so a
    // dropped tail is a wrong number with nothing failing. Loud beats short.
    servePage({
      catalogVersion: 'v1',
      generatedAt: 'now',
      total: 3,
      capabilities: [entry('rooms.create', 'create_room', 'roomsManage')],
    });

    await expect(
      createSystemMethods(BASE).getCapabilityCatalog({ toolGroup: 'roomsManage' })
    ).rejects.toThrow(/truncated: 1 of 3/);
  });

  it('accepts a page that carries everything it counted', async () => {
    // The discriminating other half: the check is `>`, not `!==`, so a complete
    // page passes and a check that could never fire would fail this row.
    servePage({
      catalogVersion: 'v1',
      generatedAt: 'now',
      total: 2,
      capabilities: [entry('rooms.create', 'create_room'), entry('rooms.leave', 'leave_room')],
    });

    await expect(createSystemMethods(BASE).getCapabilityCatalog()).resolves.toMatchObject({
      capabilities: [{ id: 'rooms.create' }, { id: 'rooms.leave' }],
    });
  });
});
