/**
 * Tests for `POST /api/capabilities/:id/invoke` (spec `capability-registry`,
 * task 2.4).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';

import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  CapabilityToolError,
  type CapabilityDomain,
} from '../../services/core/capabilities/index.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { AgentIdentity } from '../../services/core/agent-identity/index.js';
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

/**
 * The HTTP half of the tier gate (spec `agent-trust` §3.2). A destructive
 * capability reached by an identified agent must not run until a person approves,
 * and the retry rides the `X-DorkOS-Approval` header — never the body, which IS
 * the input the approval is bound to.
 */
describe('POST /api/capabilities/:id/invoke — tier enforcement', () => {
  let destroyed: string[];
  let approvals: ApprovalService;

  /** A destructive capability that records what it destroyed, so a bypass shows. */
  function gateDomain(): CapabilityDomain {
    return {
      name: 'gated',
      capabilities: [
        defineCapability({
          id: 'gated.destroy',
          title: 'Destroy the thing',
          description: 'Deletes the named thing. Cannot be undone.',
          tier: 'destructive',
          input: z.object({ name: z.string() }),
          output: z.object({ destroyed: z.string() }),
          surfaces: { mcp: { toolName: 'gated_destroy', servers: ['external'] } },
          invoke: async (_deps, input) => {
            destroyed.push(input.name);
            return { destroyed: input.name };
          },
        }),
      ],
    };
  }

  /** An app that presents the given identity, as the real middleware would. */
  function buildGatedApp(identity?: AgentIdentity) {
    const registry = composeRegistry([gateDomain()], { logger: noopLogger });
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (identity) res.locals.agentIdentity = identity;
      next();
    });
    app.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
    return app;
  }

  const AGENT: AgentIdentity = {
    agentPath: '/projects/prober',
    displayName: 'Prober',
    tierCeiling: 'destructive',
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    destroyed = [];
    approvals = new ApprovalService(createTestDb());
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  it('202s with an approval_required payload and runs nothing', async () => {
    const res = await request(buildGatedApp(AGENT))
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('approval_required');
    expect(res.body.approvalToken).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.retry.field).toBe('x-dorkos-approval');
    expect(destroyed).toEqual([]);
    expect(approvals.listPending()).toHaveLength(1);
  });

  it('runs the capability after a person grants it, on a retry with the header', async () => {
    const app = buildGatedApp(AGENT);
    const asked = await request(app)
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });
    approvals.grant(asked.body.approvalId);

    const retried = await request(app)
      .post('/api/capabilities/gated.destroy/invoke')
      .set('X-DorkOS-Approval', asked.body.approvalToken)
      .send({ name: 'production' });

    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ destroyed: 'production' });
    expect(destroyed).toEqual(['production']);
  });

  it('refuses a granted token used for a different target', async () => {
    const app = buildGatedApp(AGENT);
    const asked = await request(app)
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'staging' });
    approvals.grant(asked.body.approvalId);

    const redirected = await request(app)
      .post('/api/capabilities/gated.destroy/invoke')
      .set('X-DorkOS-Approval', asked.body.approvalToken)
      .send({ name: 'production' });

    expect(redirected.status).toBe(202);
    expect(redirected.body.reason).toBe('wrong_action');
    expect(destroyed).toEqual([]);
  });

  it('403s an agent whose ceiling forbids the tier, with no approval to chase', async () => {
    const res = await request(buildGatedApp({ ...AGENT, tierCeiling: 'act' }))
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });

    expect(res.status).toBe(403);
    expect(res.body.status).toBe('denied');
    expect(res.body.approvable).toBe(false);
    expect(destroyed).toEqual([]);
    expect(approvals.listPending()).toHaveLength(0);
  });

  it('gates a caller that presents NO identity, which is the bypass shape', async () => {
    // `env -u DORKOS_AGENT_TOKEN dorkos call …` and a bare curl both arrive here
    // with no identity, and sessionGate is a pass-through in the default local
    // posture. Requiring less capability must not buy more permission.
    const res = await request(buildGatedApp())
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('approval_required');
    expect(destroyed).toEqual([]);
    expect(approvals.listPending()[0].requestedBy).toBeUndefined();
  });

  it('lets an unidentified caller through once a person grants the approval', async () => {
    const app = buildGatedApp();
    const asked = await request(app)
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });
    approvals.grant(asked.body.approvalId);

    const retried = await request(app)
      .post('/api/capabilities/gated.destroy/invoke')
      .set('X-DorkOS-Approval', asked.body.approvalToken)
      .send({ name: 'production' });

    expect(retried.status).toBe(200);
    expect(destroyed).toEqual(['production']);
  });
});
