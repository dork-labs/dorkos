/**
 * Tests for the self-description domain and the DorkOS registry composition
 * (spec `capability-registry`, task 2.3): the `list_capabilities` capability, the
 * self-referential catalog, boot-time deps assertion, and the isError round-trip
 * through the registry → CapabilityToolError → re-wrapped MCP result.
 *
 * @vitest-environment node
 */
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
import { operatorDomain } from '../../operator/operator-capabilities.js';
import { marketplaceDomain } from '../../../marketplace-mcp/marketplace-capabilities.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import { capabilitiesDomain, capabilityCatalogSchema } from '../capabilities-domain.js';
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
