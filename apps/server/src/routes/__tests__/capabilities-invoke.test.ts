/**
 * Tests for `POST /api/capabilities/:id/invoke` (spec `capability-registry`,
 * task 2.4).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';

import {
  composeRegistry,
  defineCapability,
  CapabilityToolError,
  type CapabilityDomain,
} from '../../services/core/capabilities/index.js';
import { createCapabilitiesInvokeRouter } from '../capabilities-invoke.js';
import { createCapabilitiesCatalogRouter } from '../capabilities-catalog.js';
import capabilitiesMatrixRouter from '../capabilities.js';

const testDomain: CapabilityDomain = {
  name: 'test',
  capabilities: [
    defineCapability({
      id: 'test.echo',
      title: 'Echo',
      description: 'Echo the message back.',
      tier: 'observe',
      input: z.object({ msg: z.string() }),
      output: z.object({ echoed: z.string() }),
      surfaces: { mcp: { toolName: 'echo', servers: ['external'] } },
      invoke: async (_deps, input) => ({ echoed: input.msg }),
    }),
    defineCapability({
      id: 'test.fail',
      title: 'Fail',
      description: 'Always returns an error result.',
      tier: 'act',
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'fail', servers: ['external'] } },
      invoke: async () => {
        throw new CapabilityToolError({ error: 'boom', code: 'DELIBERATE' });
      },
    }),
  ],
};

function buildApp() {
  const registry = composeRegistry([testDomain], { logger: noopLogger });
  const app = express();
  app.use(express.json());
  app.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
  return app;
}

describe('POST /api/capabilities/:id/invoke', () => {
  it('invokes a capability and returns its plain result', async () => {
    const res = await request(buildApp())
      .post('/api/capabilities/test.echo/invoke')
      .send({ msg: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echoed: 'hi' });
  });

  it('404s an unknown capability id', async () => {
    const res = await request(buildApp()).post('/api/capabilities/test.nope/invoke').send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_CAPABILITY');
  });

  it('400s input that fails the capability input schema', async () => {
    const res = await request(buildApp())
      .post('/api/capabilities/test.echo/invoke')
      .send({ msg: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeDefined();
  });

  it('surfaces a capability error payload verbatim as 400', async () => {
    const res = await request(buildApp()).post('/api/capabilities/test.fail/invoke').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'boom', code: 'DELIBERATE' });
  });

  // The three routers share the `/api/capabilities` prefix in production
  // (matrix at `/`, catalog at `/catalog`, invoke at `/:id/invoke`); prove the
  // mount order does not shadow invoke and that catalog still resolves.
  it('coexists with the matrix and catalog routers on the shared prefix', async () => {
    const registry = composeRegistry([testDomain], { logger: noopLogger });
    const app = express();
    app.use(express.json());
    app.use('/api/capabilities', capabilitiesMatrixRouter);
    app.use('/api/capabilities/catalog', createCapabilitiesCatalogRouter(registry));
    app.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));

    const invoke = await request(app).post('/api/capabilities/test.echo/invoke').send({ msg: 'x' });
    expect(invoke.status).toBe(200);
    expect(invoke.body).toEqual({ echoed: 'x' });

    const catalog = await request(app).get('/api/capabilities/catalog');
    expect(catalog.status).toBe(200);
    expect(catalog.body).toHaveProperty('catalogVersion');
  });
});
