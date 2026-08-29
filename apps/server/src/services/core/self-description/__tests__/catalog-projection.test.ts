/**
 * Tests for {@link projectCatalog} — the pure filter/paginate/compact function
 * behind `list_capabilities` and `GET /api/capabilities/catalog` (DOR-940).
 *
 * A synthetic six-capability catalog gives EXACT, independent counts (3 mcp, one
 * with a unique word in its description) so a filter that matched everything, or
 * searched only the id, would be caught. The real docs catalog is then projected
 * to prove the same filter picks exactly the mcp.* domain out of the live set.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { CapabilityCatalog, SerializedCapability } from '@dorkos/shared/capabilities';

import {
  DEFAULT_CAPABILITY_LIMIT,
  FULL_DETAIL_THRESHOLD,
  InvalidCursorError,
  listCapabilitiesInputSchema,
  projectCatalog,
} from '../catalog-projection.js';
import { composeCapabilityRegistryForDocs } from '../dorkos-registry.js';

/** Build a synthetic serialized entry with a controllable description. */
function entry(id: string, title: string, description: string): SerializedCapability {
  return {
    id,
    title,
    description,
    tier: 'observe',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    surfaces: {},
  };
}

/** Six capabilities: 3 mcp, 2 operator (one with the unique word "zebra"), 1 marketplace. */
const synthetic: CapabilityCatalog = {
  catalogVersion: 'synthetic-v1',
  generatedAt: '2026-08-06T00:00:00.000Z',
  capabilities: [
    entry('mcp.add', 'Add server', 'Register an MCP server.'),
    entry('mcp.remove', 'Remove server', 'Unregister an MCP server.'),
    entry('mcp.test', 'Test server', 'Ping an MCP server.'),
    entry('operator.config_get', 'Get config', 'Read a configuration value.'),
    entry('operator.update_agent', 'Update agent', 'Change an agent manifest, code zebra.'),
    entry('marketplace.search', 'Search marketplace', 'Find packages.'),
  ],
};

const parse = (input: unknown) => listCapabilitiesInputSchema.parse(input);
const SORTED_IDS = [...synthetic.capabilities.map((c) => c.id)].sort();

/**
 * Mint a cursor by hand, mirroring the module's `${catalogVersion}:${offset}`
 * encoding, so a test can hand it an offset the server would never produce.
 */
const cursorFor = (version: string, offset: number | string) =>
  Buffer.from(`${version}:${offset}`, 'utf8').toString('base64url');

describe('projectCatalog — default (no arguments)', () => {
  it('returns every capability, compact, bounded, with no schemas', () => {
    const res = projectCatalog(synthetic, parse({}));
    expect(res.detail).toBe('compact');
    expect(res.total).toBe(6);
    expect(res.returned).toBe(6);
    expect(res.nextCursor).toBeUndefined();
    // The one page with nothing to explain: compact, complete, unfiltered.
    expect(res.guidance).toBeUndefined();
    for (const c of res.capabilities) {
      expect(c).toHaveProperty('summary');
      expect(c).not.toHaveProperty('inputSchema');
      expect(c).not.toHaveProperty('description');
    }
  });

  it('elides the summary to the first sentence of the description', () => {
    const res = projectCatalog(synthetic, parse({}));
    // Narrow to the compact branch before reading the compact-only `summary`.
    expect(res.detail).toBe('compact');
    if (res.detail !== 'compact') throw new Error('expected compact');
    const add = res.capabilities.find((c) => c.id === 'mcp.add');
    expect(add?.summary).toBe('Register an MCP server.');
  });
});

describe('projectCatalog — domain filter', () => {
  it('domain:"mcp" returns exactly the three mcp.* entries, at full detail', () => {
    const res = projectCatalog(synthetic, parse({ domain: 'mcp' }));
    expect(res.total).toBe(3);
    expect(res.returned).toBe(3);
    expect(res.capabilities.map((c) => c.id).sort()).toEqual(['mcp.add', 'mcp.remove', 'mcp.test']);
    expect(res.detail).toBe('full');
    for (const c of res.capabilities) expect(c).toHaveProperty('inputSchema');
  });

  it('is case-insensitive on the domain segment', () => {
    expect(projectCatalog(synthetic, parse({ domain: 'MCP' })).total).toBe(3);
  });

  it('matches the whole domain segment, not a prefix (mc does not match mcp)', () => {
    expect(projectCatalog(synthetic, parse({ domain: 'mc' })).total).toBe(0);
  });
});

// A zero-match filter passes the selectivity threshold trivially (0 <= 8), so it
// arrives at the guidance builder looking like the most selective query there is.
// Left to the general path it described full schemas for entries that do not
// exist and told the agent to narrow a filter that already matches nothing.
describe('projectCatalog — nothing matched', () => {
  it.each([
    ['a query', { query: 'zzzz-nomatch' }],
    ['a domain', { domain: 'nosuchdomain' }],
    ['both together', { domain: 'mcp', query: 'zebra' }],
  ])('tells the caller to broaden when %s matches nothing', (_label, input) => {
    const res = projectCatalog(synthetic, parse(input));
    expect(res.total).toBe(0);
    expect(res.capabilities).toEqual([]);
    expect(res.guidance).toBe(
      'Nothing matched. Broaden the query, drop the domain filter, or call with no arguments to see everything.'
    );
    // The two sentences that would be false here: schemas that are not there,
    // and an instruction to narrow further.
    expect(res.guidance).not.toMatch(/JSON Schema/i);
    expect(res.guidance).not.toMatch(/narrow/i);
  });

  it('says the catalog is empty when there is nothing to match against', () => {
    const empty = { ...synthetic, capabilities: [] };
    const res = projectCatalog(empty, parse({}));
    expect(res.total).toBe(0);
    expect(res.guidance).toMatch(/catalog is empty/i);
    expect(res.guidance).not.toMatch(/narrow/i);
  });
});

describe('projectCatalog — query filter (spans id, title, description)', () => {
  it('finds a word that lives only in a description', () => {
    const res = projectCatalog(synthetic, parse({ query: 'zebra' }));
    expect(res.total).toBe(1);
    expect(res.capabilities.map((c) => c.id)).toEqual(['operator.update_agent']);
  });

  it('finds a word that lives in titles and descriptions', () => {
    const res = projectCatalog(synthetic, parse({ query: 'server' }));
    expect(res.total).toBe(3);
    expect(res.capabilities.every((c) => c.id.startsWith('mcp.'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(projectCatalog(synthetic, parse({ query: 'ZEBRA' })).total).toBe(1);
  });
});

describe('projectCatalog — pagination', () => {
  it('reaches every capability across pages, id-sorted, without duplicates', () => {
    const pageSize = 2;
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = projectCatalog(
        synthetic,
        parse({ limit: pageSize, ...(cursor ? { cursor } : {}) })
      );
      expect(page.returned).toBeLessThanOrEqual(pageSize);
      collected.push(...page.capabilities.map((c) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual(SORTED_IDS);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('caps a page and reports how many were omitted plus a cursor', () => {
    const page = projectCatalog(synthetic, parse({ limit: 2 }));
    expect(page.returned).toBe(2);
    expect(page.total).toBe(6);
    expect(page.offset).toBe(0);
    expect(page.nextCursor).toBeTruthy();
    expect(page.guidance).toContain('6');
    expect(page.guidance).toContain('4'); // 6 total minus the 2 shown
    expect(page.guidance).toContain('cursor');
  });

  it('clamps an out-of-range cursor to an empty tail rather than erroring', () => {
    const beyond = cursorFor(synthetic.catalogVersion, 999);
    const page = projectCatalog(synthetic, parse({ cursor: beyond }));
    expect(page.returned).toBe(0);
    expect(page.total).toBe(6);
    expect(page.nextCursor).toBeUndefined();
  });

  it('rejects a cursor that does not decode to an offset', () => {
    const bad = cursorFor(synthetic.catalogVersion, 'notanumber');
    expect(() => projectCatalog(synthetic, parse({ cursor: bad }))).toThrow(InvalidCursorError);
  });

  // `Number('')` is 0, so before the digit check any base64url that decoded to
  // an empty (or blank) offset was silently served as "start from the top".
  it.each([
    ['empty offset', ''],
    ['blank offset', '  '],
  ])('rejects a cursor whose offset is %s rather than reading it as 0', (_label, offset) => {
    const bad = cursorFor(synthetic.catalogVersion, offset);
    expect(() => projectCatalog(synthetic, parse({ cursor: bad }))).toThrow(InvalidCursorError);
  });

  it('rejects a cursor with no version binding at all', () => {
    const bare = Buffer.from('2', 'utf8').toString('base64url');
    expect(() => projectCatalog(synthetic, parse({ cursor: bare }))).toThrow(InvalidCursorError);
  });

  it('rejects a cursor minted against a different catalog version', () => {
    const stale = projectCatalog(synthetic, parse({ limit: 2 })).nextCursor;
    expect(stale).toBeTruthy();
    // Same entries, different content hash: the offsets a cursor names are only
    // meaningful against the catalog that minted it.
    const rehashed = { ...synthetic, catalogVersion: 'synthetic-v2' };
    expect(() => projectCatalog(rehashed, parse({ cursor: stale! }))).toThrow(InvalidCursorError);
    expect(() => projectCatalog(rehashed, parse({ cursor: stale! }))).toThrow(/catalog changed/i);
    // ...and still works against the catalog it was minted from.
    expect(projectCatalog(synthetic, parse({ cursor: stale! })).offset).toBe(2);
  });
});

describe('projectCatalog — a filter only auto-expands when it is selective', () => {
  /** A synthetic catalog of `count` entries that ALL match `query:'widget'`. */
  const broadCatalog = (count: number): CapabilityCatalog => ({
    catalogVersion: `broad-${count}`,
    generatedAt: '2026-08-06T00:00:00.000Z',
    capabilities: Array.from({ length: count }, (_, i) =>
      entry(`broad.n${String(i).padStart(2, '0')}`, `Widget ${i}`, 'A widget capability.')
    ),
  });

  it(`stays compact when a filter leaves more than ${FULL_DETAIL_THRESHOLD} matches`, () => {
    const res = projectCatalog(broadCatalog(FULL_DETAIL_THRESHOLD + 1), parse({ query: 'widget' }));
    expect(res.total).toBe(FULL_DETAIL_THRESHOLD + 1);
    expect(res.detail).toBe('compact');
  });

  it(`expands to full at exactly ${FULL_DETAIL_THRESHOLD} matches`, () => {
    const res = projectCatalog(broadCatalog(FULL_DETAIL_THRESHOLD), parse({ query: 'widget' }));
    expect(res.total).toBe(FULL_DETAIL_THRESHOLD);
    expect(res.detail).toBe('full');
  });
});

describe('projectCatalog — over the real composed catalog', () => {
  const docsCatalog = composeCapabilityRegistryForDocs().catalog();

  it('a no-argument call is bounded to the default limit and compact', () => {
    const res = projectCatalog(docsCatalog, parse({}));
    expect(res.total).toBe(docsCatalog.capabilities.length);
    expect(res.returned).toBe(Math.min(DEFAULT_CAPABILITY_LIMIT, docsCatalog.capabilities.length));
    expect(res.detail).toBe('compact');
  });

  it('domain:"mcp" returns exactly the live mcp.* capabilities', () => {
    const mcpIds = docsCatalog.capabilities
      .filter((c) => c.id.startsWith('mcp.'))
      .map((c) => c.id)
      .sort();
    // Guard the guard: the real catalog really does have mcp.* AND other domains,
    // so "return everything" and "return nothing" both fail this.
    expect(mcpIds.length).toBeGreaterThan(0);
    expect(mcpIds.length).toBeLessThan(docsCatalog.capabilities.length);

    const res = projectCatalog(docsCatalog, parse({ domain: 'mcp' }));
    expect(res.total).toBe(mcpIds.length);
    expect(res.capabilities.map((c) => c.id).sort()).toEqual(mcpIds);
  });

  /** Every entry the projection's own filter would keep for `query`. */
  const matching = (query: string) =>
    docsCatalog.capabilities.filter((c) =>
      `${c.id}\n${c.title}\n${c.description}`.toLowerCase().includes(query.toLowerCase())
    );

  it('a broad query stays compact and small instead of dumping every schema', () => {
    // Guard the guard: this query has to be genuinely broad on the real catalog,
    // or the selectivity rule is not what is under test here.
    expect(matching('server').length).toBeGreaterThan(FULL_DETAIL_THRESHOLD);

    const res = projectCatalog(docsCatalog, parse({ query: 'server' }));
    expect(res.detail).toBe('compact');
    // A capped or expensive page always says so; this one names the escape hatch.
    expect(res.guidance).toBeDefined();
    expect(res.guidance).toMatch(/detail:'full'/);

    // The bound is derived from the payload this fix exists to stop serving by
    // default, not guessed: the same query at explicit full detail.
    const compactChars = JSON.stringify(res).length;
    const fullChars = JSON.stringify(
      projectCatalog(docsCatalog, parse({ query: 'server', detail: 'full' }))
    ).length;
    expect(compactChars).toBeLessThan(fullChars / 4);
    // And an absolute ceiling, so a catalog that grows cheap-but-huge is caught too.
    expect(compactChars).toBeLessThan(20_000);
  });

  it("honors an explicit detail:'full' on a broad query, and explains its cost", () => {
    const res = projectCatalog(docsCatalog, parse({ query: 'server', detail: 'full' }));
    expect(res.detail).toBe('full');
    for (const c of res.capabilities) expect(c).toHaveProperty('inputSchema');
    expect(res.guidance).toBeDefined();
    expect(res.guidance).toMatch(/detail:'compact'/);
  });

  it('auto-expands a query selective enough to name one capability', () => {
    const target = docsCatalog.capabilities[0]!;
    expect(matching(target.id).length).toBeLessThanOrEqual(FULL_DETAIL_THRESHOLD);

    const res = projectCatalog(docsCatalog, parse({ query: target.id }));
    expect(res.detail).toBe('full');
    expect(res.capabilities.map((c) => c.id)).toContain(target.id);
  });
});

describe('projectCatalog — the toolGroup filter (DOR-1611)', () => {
  /** The synthetic six, plus two capabilities that sit behind a per-agent grant. */
  const withGrants: CapabilityCatalog = {
    ...synthetic,
    capabilities: [
      ...synthetic.capabilities,
      {
        ...entry('rooms.create', 'Open a room', 'Open a channel, or a direct message.'),
        tier: 'act',
        toolGroup: 'roomsManage',
        surfaces: { mcp: { toolName: 'create_room', servers: ['in-session', 'external'] } },
      },
      {
        ...entry('rooms.leave', 'Leave a channel', 'Step out of a channel you are finished with.'),
        tier: 'act',
        toolGroup: 'roomsManage',
        surfaces: { mcp: { toolName: 'leave_room', servers: ['in-session', 'external'] } },
      },
    ],
  };

  it('returns only what sits behind that grant, at full detail', () => {
    const res = projectCatalog(withGrants, parse({ toolGroup: 'roomsManage' }));
    expect(res.total).toBe(2);
    // Selective, so it upgrades itself the way the domain filter does — which is
    // what puts the tool names on the entries at all.
    expect(res.detail).toBe('full');
    expect(
      (res.capabilities as SerializedCapability[]).map((c) => c.surfaces.mcp?.toolName)
    ).toEqual(['create_room', 'leave_room']);
  });

  it('matches the key exactly, never loosely', () => {
    // A grant key is an identifier the caller already holds, not text it is
    // searching for. Matching it case-insensitively or by prefix would invent a
    // second spelling of a key that has exactly one.
    expect(projectCatalog(withGrants, parse({ toolGroup: 'roomsmanage' })).total).toBe(0);
    expect(projectCatalog(withGrants, parse({ toolGroup: 'rooms' })).total).toBe(0);
  });

  it('is why a caller after a grant cannot read the unfiltered page', () => {
    // The defect this filter exists to remove, pinned so nobody simplifies a
    // caller back onto the bare path: the default projection is COMPACT, and a
    // compact entry carries neither the grant nor a tool name. A Tools tab
    // reading it would render an empty group, with no error to notice.
    const bare = projectCatalog(withGrants, parse({}));
    expect(bare.detail).toBe('compact');
    for (const capability of bare.capabilities) {
      expect(capability).not.toHaveProperty('toolGroup');
      expect(capability).not.toHaveProperty('surfaces');
    }
  });
});
