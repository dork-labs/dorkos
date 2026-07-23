/**
 * Tests for `GET /api/capabilities/catalog` (spec `capability-registry`, task 2.3).
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
  it('returns the catalog shape { catalogVersion, generatedAt, capabilities }', async () => {
    const res = await request(buildApp()).get('/api/capabilities/catalog');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('catalogVersion');
    expect(res.body).toHaveProperty('generatedAt');
    expect(Array.isArray(res.body.capabilities)).toBe(true);
    expect(res.body.catalogVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it('includes list_capabilities with its input/output JSON Schema and surfaces', async () => {
    const res = await request(buildApp()).get('/api/capabilities/catalog');
    const entry = (res.body.capabilities as { id: string }[]).find(
      (c) => c.id === 'capabilities.list'
    ) as
      | {
          id: string;
          title: string;
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
    // Every entry projects real JSON Schemas (never absent).
    expect(entry!.inputSchema).toBeTypeOf('object');
    expect(entry!.outputSchema).toBeTypeOf('object');
  });
});
