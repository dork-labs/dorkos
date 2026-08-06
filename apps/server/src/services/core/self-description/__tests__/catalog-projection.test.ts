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

describe('projectCatalog — default (no arguments)', () => {
  it('returns every capability, compact, bounded, with no schemas', () => {
    const res = projectCatalog(synthetic, parse({}));
    expect(res.detail).toBe('compact');
    expect(res.total).toBe(6);
    expect(res.returned).toBe(6);
    expect(res.nextCursor).toBeUndefined();
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
    const beyond = Buffer.from('999', 'utf8').toString('base64url');
    const page = projectCatalog(synthetic, parse({ cursor: beyond }));
    expect(page.returned).toBe(0);
    expect(page.total).toBe(6);
    expect(page.nextCursor).toBeUndefined();
  });

  it('rejects a cursor that does not decode to an offset', () => {
    const bad = Buffer.from('notanumber', 'utf8').toString('base64url');
    expect(() => projectCatalog(synthetic, parse({ cursor: bad }))).toThrow(InvalidCursorError);
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
});
