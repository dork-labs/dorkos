/**
 * Tests for `GET /api/capabilities/catalog` (spec `capability-registry`, task 2.3;
 * filtering + pagination DOR-940).
 *
 * The route parses its query string through the capability's own Zod schema and
 * serves the same {@link projectCatalog} projection the `list_capabilities` MCP
 * tool does, so these cover both the compact default and the query parameters that
 * narrow it, including the two ways a request can be rejected.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { noopLogger } from '@dorkos/shared/logger';

import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';
import { composeDorkOsCapabilityRegistry } from '../../services/core/self-description/dorkos-registry.js';
import { createCapabilitiesCatalogRouter } from '../capabilities-catalog.js';

function buildApp() {
  const registry = composeDorkOsCapabilityRegistry({
    logger: noopLogger,
    operatorDeps: {} as McpToolDeps,
  });
  const app = express();
  app.use('/api/capabilities/catalog', createCapabilitiesCatalogRouter(registry));
  return app;
}

describe('GET /api/capabilities/catalog', () => {
  it('defaults to a compact, bounded page carrying the version and totals', async () => {
    const res = await request(buildApp()).get('/api/capabilities/catalog');
    expect(res.status).toBe(200);
    expect(res.body.catalogVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(res.body).toHaveProperty('generatedAt');
    expect(res.body.detail).toBe('compact');
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.capabilities)).toBe(true);
    // Compact entries drop the heavy schemas — that is the whole point.
    const compact = res.body.capabilities[0] as Record<string, unknown>;
    expect(compact).toHaveProperty('summary');
    expect(compact).not.toHaveProperty('inputSchema');
  });

  it('detail=full projects list_capabilities with its JSON Schemas and surfaces', async () => {
    const res = await request(buildApp()).get('/api/capabilities/catalog?detail=full');
    expect(res.body.detail).toBe('full');
    const entry = (res.body.capabilities as { id: string }[]).find(
      (c) => c.id === 'capabilities.list'
    ) as
      | {
          tier: string;
          inputSchema: unknown;
          outputSchema: unknown;
          surfaces: { mcp?: { toolName: string }; http?: { path: string } };
        }
      | undefined;
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe('observe');
    expect(entry!.surfaces.mcp?.toolName).toBe('list_capabilities');
    expect(entry!.surfaces.http?.path).toBe('/api/capabilities/catalog');
    expect(entry!.inputSchema).toBeTypeOf('object');
    expect(entry!.outputSchema).toBeTypeOf('object');
  });

  it('domain filter narrows to one domain, at full detail', async () => {
    const res = await request(buildApp()).get('/api/capabilities/catalog?domain=capabilities');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect((res.body.capabilities as { id: string }[]).map((c) => c.id)).toEqual([
      'capabilities.list',
    ]);
    expect(res.body.detail).toBe('full');
  });

  it('toolGroup filter reaches the query schema rather than being ignored', async () => {
    // The cockpit's two Tools tabs ask this route for the tools behind a grant
    // (DOR-1611). An unrecognized query parameter is DROPPED by the schema
    // rather than refused, so a parameter that never landed would come back as
    // the whole unfiltered catalog and look like a working request — which is
    // exactly what happened before it was wired.
    const all = await request(buildApp()).get('/api/capabilities/catalog?limit=200');
    expect(all.body.total).toBeGreaterThan(1);

    const res = await request(buildApp()).get('/api/capabilities/catalog?toolGroup=roomsManage');
    expect(res.status).toBe(200);
    // No `roomDeps` here, so the rooms domain is not composed and nothing in
    // THIS registry declares a grant. Zero is the discriminating answer: an
    // ignored parameter would have returned every capability there is.
    expect(res.body.total).toBe(0);
  });

  it('rejects an out-of-range limit with 400', async () => {
    const res = await request(buildApp()).get('/api/capabilities/catalog?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('rejects a cursor that does not decode to an offset with 400', async () => {
    const bad = Buffer.from('notanumber', 'utf8').toString('base64url');
    const res = await request(buildApp()).get(`/api/capabilities/catalog?cursor=${bad}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('cursor');
  });
});
