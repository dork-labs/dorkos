/**
 * Tests for the self-description domain and the DorkOS registry composition
 * (spec `capability-registry`, task 2.3): the `list_capabilities` capability, the
 * self-referential catalog, boot-time deps assertion, and the isError round-trip
 * through the registry → CapabilityToolError → re-wrapped MCP result.
 *
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';

import {
  composeRegistry,
  defineCapability,
  type CapabilityDomain,
} from '../../capabilities/index.js';
import { unwrapMcpEnvelope, CapabilityToolError } from '../../capabilities/mcp-envelope.js';
import { invokeCapabilityAsMcpResult } from '../../capabilities/mcp-projection.js';
import { MCP_TOOL_TIERS } from '../../mcp-tool-tiers.js';
import { operatorDomain } from '../../operator/operator-capabilities.js';
import { marketplaceDomain } from '../../../marketplace-mcp/marketplace-capabilities.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import { capabilitiesDomain, UNREGISTERED_TOOL_FAMILIES } from '../capabilities-domain.js';
import {
  capabilityCatalogSchema,
  DEFAULT_CAPABILITY_LIMIT,
  type ListCapabilitiesResult,
} from '../catalog-projection.js';
import { composeDorkOsCapabilityRegistry } from '../dorkos-registry.js';

const stubOperatorDeps = {} as McpToolDeps;
const stubMarketplaceDeps = {} as MarketplaceMcpDeps;

describe('composeDorkOsCapabilityRegistry', () => {
  it('folds operator + marketplace + self-description into one registry', () => {
    const registry = composeDorkOsCapabilityRegistry({
      logger: noopLogger,
      operatorDeps: stubOperatorDeps,
      marketplaceDeps: stubMarketplaceDeps,
    });
    const ids = registry.capabilities.map((c) => c.id);
    expect(ids).toContain('operator.config_get');
    expect(ids).toContain('marketplace.search');
    expect(ids).toContain('capabilities.list');
  });

  it('omits a domain whose deps are absent (marketplace disabled)', () => {
    const registry = composeDorkOsCapabilityRegistry({
      logger: noopLogger,
      operatorDeps: stubOperatorDeps,
    });
    const ids = registry.capabilities.map((c) => c.id);
    expect(ids).toContain('operator.config_get');
    expect(ids).toContain('capabilities.list');
    expect(ids.some((id) => id.startsWith('marketplace.'))).toBe(false);
  });

  it('back-writes the registry so list_capabilities can serialize itself', async () => {
    const registry = composeDorkOsCapabilityRegistry({
      logger: noopLogger,
      operatorDeps: stubOperatorDeps,
    });
    const catalog = (await registry.invoke('capabilities.list', {})) as {
      capabilities: { id: string }[];
    };
    // The catalog contains the very capability that produced it — the
    // self-reference resolves without recursion (catalog() returns plain data).
    expect(catalog.capabilities.some((c) => c.id === 'capabilities.list')).toBe(true);
  });

  it('serves a catalog that validates against the real catalog schema', async () => {
    const registry = composeDorkOsCapabilityRegistry({
      logger: noopLogger,
      operatorDeps: stubOperatorDeps,
    });
    const catalog = registry.catalog();
    expect(() => capabilityCatalogSchema.parse(catalog)).not.toThrow();
    expect(catalog.catalogVersion).toMatch(/^[0-9a-f]{12}$/);
  });
});

/**
 * DOR-940: `list_capabilities` filters, paginates, and compacts by default so a
 * discovery call cannot dump the whole schema catalog into an agent's context.
 *
 * These run through `registry.invoke('capabilities.list', ...)` — the real
 * handler path the MCP tool and `dorkos call` both take — so reverting the
 * handler back to `requireRegistry(deps).catalog()` reddens every one: the raw
 * catalog has no `detail`/`total`, ignores `limit`/`domain`, and carries the
 * heavy `inputSchema` on every entry. Counts are derived from the live catalog,
 * never hard-coded, so they stay exact as domains are added.
 */
describe('list_capabilities filtering + pagination (DOR-940)', () => {
  const registry = composeDorkOsCapabilityRegistry({
    logger: noopLogger,
    operatorDeps: stubOperatorDeps,
    marketplaceDeps: stubMarketplaceDeps,
  });
  const allIds = registry.catalog().capabilities.map((c) => c.id);
  const invoke = (input: unknown) =>
    registry.invoke('capabilities.list', input) as Promise<ListCapabilitiesResult>;

  it('a no-argument call returns the whole catalog once, compact and bounded', async () => {
    const res = await invoke({});
    expect(res.detail).toBe('compact');
    expect(res.total).toBe(allIds.length);
    expect(res.returned).toBe(Math.min(DEFAULT_CAPABILITY_LIMIT, allIds.length));
    expect(res.capabilities).toHaveLength(res.returned);
    // Compact entries carry a one-line summary and DROP the heavy schemas and
    // full description that made the raw catalog overflow the token budget.
    for (const entry of res.capabilities) {
      expect(entry).toHaveProperty('summary');
      expect(entry).not.toHaveProperty('inputSchema');
      expect(entry).not.toHaveProperty('description');
    }
  });

  it('domain:"marketplace" returns exactly the marketplace.* capabilities, at full detail', async () => {
    const expected = allIds.filter((id) => id.startsWith('marketplace.')).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(allIds.length); // a real filter, not the whole set

    const res = await invoke({ domain: 'marketplace' });
    expect(res.total).toBe(expected.length);
    expect(res.returned).toBe(expected.length);
    expect(res.capabilities.map((c) => c.id).sort()).toEqual(expected);
    // A filter narrows detail to full, so the schemas are back for the few matches.
    expect(res.detail).toBe('full');
    for (const entry of res.capabilities) expect(entry).toHaveProperty('inputSchema');
  });

  it('an explicit detail:"compact" wins even when a filter is set', async () => {
    const res = await invoke({ domain: 'marketplace', detail: 'compact' });
    expect(res.detail).toBe('compact');
    for (const entry of res.capabilities) expect(entry).not.toHaveProperty('inputSchema');
  });

  it('paging with a small limit reaches every capability, id-sorted, no duplicates', async () => {
    const pageSize = 2;
    const collected: string[] = [];
    let cursor: string | undefined;
    // Bound the loop well above the page count so a stuck cursor fails loudly.
    for (let i = 0; i < allIds.length + 5; i += 1) {
      const page = await invoke({ limit: pageSize, ...(cursor ? { cursor } : {}) });
      expect(page.returned).toBeLessThanOrEqual(pageSize);
      collected.push(...page.capabilities.map((c) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual([...allIds].sort());
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('a capped page states how many were omitted and how to page on', async () => {
    const page = await invoke({ limit: 2 });
    expect(page.returned).toBe(2);
    expect(page.total).toBe(allIds.length);
    expect(page.nextCursor).toBeTruthy();
    expect(page.guidance).toContain(String(allIds.length));
    expect(page.guidance).toContain('cursor');
  });
});

describe('boot-time deps assertion (fail-fast)', () => {
  it('throws when a domain is composed without its deps', () => {
    // A registry composed with operator capabilities but no operatorDeps must
    // fail at composition, not on the first invoke.
    expect(() => composeRegistry([operatorDomain], { logger: noopLogger })).toThrow(/operatorDeps/);
  });

  it('throws for the marketplace domain without its deps', () => {
    expect(() => composeRegistry([marketplaceDomain], { logger: noopLogger })).toThrow(
      /marketplaceDeps/
    );
  });
});

describe('list_capabilities surface', () => {
  it('advertises the list_capabilities tool on both MCP servers, read-only', () => {
    const cap = capabilitiesDomain.capabilities.find((c) => c.id === 'capabilities.list');
    expect(cap?.surfaces.mcp?.toolName).toBe('list_capabilities');
    expect(cap?.surfaces.mcp?.servers).toEqual(['in-session', 'external']);
    expect(cap?.surfaces.mcp?.readOnlyCarveOut).toBe(true);
    expect(cap?.tier).toBe('observe');
    expect(cap?.surfaces.http).toEqual({ method: 'get', path: '/api/capabilities/catalog' });
  });

  /**
   * The description is a model-facing interface, and while it is not exhaustive it
   * must not claim to be. Around two dozen DorkOS tools (tasks, relay, mesh,
   * binding, extension, UI) are hand-registered on the MCP servers with no registry
   * entry, so an earlier description that said this listed "everything you can do"
   * and to "call this first to discover what actions and tools are available" gave
   * an obedient model a false premise: it sees no `tasks_*` entry and concludes it
   * cannot manage tasks. These assertions fail if that overclaim comes back.
   */
  describe('its description does not overclaim', () => {
    const description = () =>
      capabilitiesDomain.capabilities.find((c) => c.id === 'capabilities.list')!.description;

    it('never claims to list everything the agent can do', () => {
      const text = description().toLowerCase();
      expect(text).not.toContain('everything you can do');
      expect(text).not.toContain('all the tools');
    });

    it('says the catalog is not the full tool list', () => {
      // Any wording is fine as long as the caveat is present and negative.
      expect(description()).toMatch(
        /not the full list|not the whole|do not appear|rather than in/i
      );
    });

    /**
     * Asserted against the REGISTRY, not against the description's own wording.
     *
     * A wording-only check (`toContain('task')`) is a one-way ratchet: once those
     * domains migrate onto the registry the caveat becomes false, and the assertion
     * keeps passing and preserves it. That is the exact inverse of the instruction
     * on the domain itself, which says to DELETE the caveat at migration rather
     * than reword it. So the test binds the two together: naming a family is only
     * correct while it is genuinely absent from the composed registry.
     *
     * The list is NOT restated here. It comes from the same exported
     * `UNREGISTERED_TOOL_FAMILIES` the description is built from, so the prose and
     * the guard cannot drift, and every family the description claims is absent is
     * covered rather than an arbitrary three of them. The entries are domain
     * prefixes (`tasks`, not `task`) precisely because that is what a migrated
     * capability id would carry: an earlier version of this test compared `'task'`
     * by exact `Set` membership and therefore could never have caught the `tasks`
     * domain migrating, which is the family the original defect was about.
     */
    it('only names families that really are absent from the registry', () => {
      const text = description().toLowerCase();
      const registeredDomains = new Set(
        composeDorkOsCapabilityRegistry({
          logger: noopLogger,
          operatorDeps: {} as McpToolDeps,
        }).capabilities.map((c) => c.id.split('.')[0])
      );

      expect(UNREGISTERED_TOOL_FAMILIES.length).toBeGreaterThan(0);
      for (const family of UNREGISTERED_TOOL_FAMILIES) {
        // The description really does name it...
        expect(text).toContain(family);
        // ...and it really is absent. If this fails, the family migrated onto the
        // registry: drop it from UNREGISTERED_TOOL_FAMILIES, which removes it from
        // the description too. Do not reword the caveat.
        expect(registeredDomains).not.toContain(family);
      }
      expect(text).toContain('tool list');
    });

    it('does not name a family that IS on the registry (the agent overclaim)', () => {
      // `operator.update_agent` and `operator.agents_recent_activity` are catalog
      // entries with tiers, and `managing-agents` teaches
      // `dorkos call operator.update_agent`. So a bare "agent" in the absent list
      // would be its own overclaim, one surface further out.
      expect(UNREGISTERED_TOOL_FAMILIES).not.toContain('agent');
      expect(UNREGISTERED_TOOL_FAMILIES).not.toContain('operator');
      expect(UNREGISTERED_TOOL_FAMILIES).not.toContain('marketplace');
    });

    it('points at the universal actuation path by name', () => {
      expect(description()).toContain('dorkos call');
    });

    /**
     * The description said those families "carry no permission tier" (DOR-509).
     *
     * True when written; false from DOR-468, which gave all 47 hand-registered
     * tools a tier behind the choke point in `core/mcp-tool-gate.ts`. Absent from
     * the CATALOG and carrying no TIER are two different facts, and conflating them
     * told every model that calls `list_capabilities` that half the product runs
     * without asking anyone. The destructive names are read out of the tier table
     * rather than typed here, so promoting a tool puts it under this assertion on
     * the same commit.
     *
     * The set is narrowed to tools that are NOT catalog capabilities, which is the
     * same union blind spot review found in the pack guard, seen from the other
     * side. This description's scope is explicitly the tools ABSENT from the
     * catalog, so naming a destructive CAPABILITY here would be the overclaim the
     * `agent` test below already guards against, one tier down. Deriving the
     * exclusion means that if `tasks_delete` ever migrates onto the registry, this
     * fails and forces the sentence to stop calling it an absent tool, rather than
     * leaving a now-false example in the highest-traffic model-facing text there is.
     */
    it('does not tell the model that hand-registered tools are untiered', () => {
      const text = description();
      expect(text.toLowerCase()).not.toContain('carry no permission tier');
      expect(text.toLowerCase()).not.toContain('carries no permission tier');

      const catalogToolNames = new Set(
        composeDorkOsCapabilityRegistry({
          logger: noopLogger,
          operatorDeps: stubOperatorDeps,
          marketplaceDeps: stubMarketplaceDeps,
        }).capabilities.flatMap((c) => (c.surfaces.mcp ? [c.surfaces.mcp.toolName] : []))
      );
      const destructiveHandRegistered = Object.entries(MCP_TOOL_TIERS)
        .filter(
          ([name, declared]) => declared.tier === 'destructive' && !catalogToolNames.has(name)
        )
        .map(([name]) => name);

      // The sentence names these by ACTION, not by tool name (DOR-1292): this
      // description is served verbatim to the external `/mcp` server too, where a
      // bare `tasks_delete` is not what the caller's harness exposes. The
      // "stays true" guarantee the derivation exists for is kept by pinning the
      // SET — a third destructive hand-registered tool fails here and forces
      // whoever added it to update the sentence.
      expect(destructiveHandRegistered.sort()).toEqual(['mesh_unregister', 'tasks_delete']);
      expect(text).toContain('deleting a schedule and unregistering an agent');
      for (const tool of destructiveHandRegistered) expect(text).not.toContain(tool);
    });

    it('is written without em-dashes (repo-wide ban on model-facing prose)', () => {
      for (const cap of capabilitiesDomain.capabilities) {
        expect(cap.description).not.toContain('—');
      }
    });
  });
});

/**
 * The committed, generated API artifacts must carry the corrected description.
 *
 * `capabilities.list` projects onto `GET /api/capabilities/catalog`, so its
 * description is copied verbatim into `docs/api/openapi.json` and rendered into
 * `docs/api/api/capabilities/catalog/get.mdx`. Those files are committed, so a
 * corrected source with an unregenerated artifact still publishes the false
 * sentence. `docs-openapi-check` catches that in CI; this catches it in the
 * targeted local loop, and states the specific claim that must never come back
 * rather than only "something differs".
 *
 * The verbatim assertion is the load-bearing one: a check for the absence of a
 * phrase is satisfied by an artifact that dropped the whole description, so the
 * pair asserts the artifact tracks the source AND that the source is right.
 */
describe('committed API artifacts (DOR-509)', () => {
  const repoRoot = new URL('../../../../../../../', import.meta.url);
  const read = async (rel: string) => readFile(fileURLToPath(new URL(rel, repoRoot)), 'utf-8');
  const liveDescription = capabilitiesDomain.capabilities.find(
    (c) => c.id === 'capabilities.list'
  )!.description;

  it('openapi.json carries the live description verbatim, false claim gone', async () => {
    const spec = await read('docs/api/openapi.json');
    expect(spec.length).toBeGreaterThan(0);
    expect(spec).not.toContain('carry no permission tier');
    // JSON-encode so the comparison survives any quoting in the description.
    expect(spec).toContain(JSON.stringify(liveDescription).slice(1, -1));
  });

  it('the rendered catalog MDX no longer says the tools are untiered', async () => {
    // The generator hard-wraps prose, so compare on collapsed whitespace.
    const mdx = (await read('docs/api/api/capabilities/catalog/get.mdx')).replace(/\s+/g, ' ');
    expect(mdx.length).toBeGreaterThan(0);
    expect(mdx).not.toContain('carry no permission tier');
    expect(mdx).toContain('carry a permission tier all the same');
  });
});

describe('isError round-trip through the registry', () => {
  it('re-wraps a handler isError result into an isError CallToolResult with identical text', async () => {
    const errorPayload = { error: 'boom', code: 'FAILED', detail: { why: 'test' } };
    // A synthetic capability whose handler produced an MCP isError envelope; its
    // invoke unwraps that envelope, which re-raises it as a CapabilityToolError.
    const domain: CapabilityDomain = {
      name: 'synthetic',
      capabilities: [
        defineCapability({
          id: 'synthetic.fails',
          title: 'Always fails',
          description: 'Test capability that surfaces an isError result.',
          tier: 'observe',
          input: z.object({}),
          output: z.unknown(),
          surfaces: { mcp: { toolName: 'synthetic_fails', servers: ['external'] } },
          invoke: async () =>
            unwrapMcpEnvelope({
              content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
              isError: true,
            }),
        }),
      ],
    };
    const registry = composeRegistry([domain], { logger: noopLogger });

    // The invoke path throws a CapabilityToolError...
    await expect(registry.invoke('synthetic.fails', {})).rejects.toBeInstanceOf(
      CapabilityToolError
    );

    // ...and the MCP adapter re-wraps it into an isError envelope whose text is
    // byte-identical to what the original handler produced.
    const result = await invokeCapabilityAsMcpResult(registry, 'synthetic.fails', {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(errorPayload, null, 2) }]);
  });
});
