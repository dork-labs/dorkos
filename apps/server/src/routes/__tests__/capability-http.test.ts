/**
 * The generic capability mount (ADR 261123-170830): every capability with an
 * `http` surface is served at its own path, through the same dispatcher as
 * `POST /api/capabilities/:id/invoke`.
 *
 * @vitest-environment node
 */
import { MOUNTED_CAPABILITY_IDS } from './mounted-capability-ids.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { writeManifest } from '@dorkos/shared/manifest';
import type { HttpSurface } from '@dorkos/shared/capabilities';
import { AgentRegistry } from '@dorkos/mesh';

import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityDefinition,
  type CapabilityDomain,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { AgentIdentity } from '../../services/core/agent-identity/index.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { AgentPauseService } from '../../services/mesh/pause/agent-pause.js';
import { agentPauseDomain } from '../../services/mesh/pause/pause-capabilities.js';
import { mcpDomain } from '../../services/mesh/mcp-capabilities.js';
import { AgentMcpServerService } from '../../services/mesh/agent-mcp-server-service.js';
import { composeCapabilityRegistryForDocs } from '../../services/core/self-description/dorkos-registry.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import {
  HAND_SERVED_CAPABILITIES,
  NOT_ON_THIS_COMPUTER,
  SKIPPABLE_MIDDLEWARE,
  assertNoCapabilityRouteCollisions,
  compareRouteSpecificity,
  createCapabilityHttpRoutes,
  mountedCapabilities,
} from '../capability-http.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';

// The routes are served through the `/api` chain, whose host guard and session
// gate read the login setting: off, as on a fresh install.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const target = swappableServer();

/** Stand in for the identity the chain would have resolved, if any. */
function presenting(identity?: AgentIdentity): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (identity) c.set('agentIdentity', identity);
    await next();
  };
}

/** The mount over one registry, as `http/hono-api.ts` mounts it. */
function mount(
  registry: CapabilityRegistry | undefined,
  capabilities: readonly CapabilityDefinition[],
  before?: MiddlewareHandler<ApiEnv>
) {
  return target.mount(
    honoGroupListener(
      { path: '/', routes: createCapabilityHttpRoutes({ registry: () => registry, capabilities }) },
      before ? { before } : {}
    )
  );
}

const SCOUT = { id: '01SCOUTAGENTULID0000000000', home: '/projects/scout' } as const;
const AS_SCOUT: AgentIdentity = {
  agentPath: SCOUT.home,
  displayName: 'Scout',
  createdAt: new Date().toISOString(),
};

describe('the mount', () => {
  it('serves exactly the declared surfaces no hand route still serves', () => {
    expect(mountedCapabilities().map((capability) => capability.id)).toEqual(
      MOUNTED_CAPABILITY_IDS
    );
  });

  it('keeps the hand-served list to capabilities that still declare a path', () => {
    const declared = new Set<string>(
      composeCapabilityRegistryForDocs()
        .capabilities.filter((capability) => capability.surfaces.http)
        .map((capability) => capability.id)
    );
    for (const id of Object.keys(HAND_SERVED_CAPABILITIES)) expect(declared.has(id)).toBe(true);
  });

  // A ratchet: this list may only shrink. When a capability moves onto the
  // mount, delete its hand route and its entry, and take it out of this list
  // too. Never add one.
  it('pins the hand-served list, which may only shrink', () => {
    expect(Object.keys(HAND_SERVED_CAPABILITIES).sort()).toEqual([
      'capabilities.list',
      'rooms.reseat',
      'rooms.reseat_options',
    ]);
  });

  it('answers 404 on a declared path whose capability did not start on this server', async () => {
    const registry = composeRegistry([], { logger: noopLogger });
    const res = await request(mount(registry, agentPauseDomain.capabilities)).get(
      '/api/agents/pauses'
    );
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'unknown_capability', detail: NOT_ON_THIS_COMPUTER });
    expect(NOT_ON_THIS_COMPUTER).toBe("This isn't available on this computer.");
  });

  it('answers 503 while boot has not handed the registry over', async () => {
    const res = await request(mount(undefined, agentPauseDomain.capabilities)).get(
      '/api/agents/pauses'
    );
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('temporarily_unavailable');
  });

  it('refuses two surfaces on one path, whatever their parameters are called', () => {
    const one = demo('demo.one', { method: 'get', path: '/api/demo/{a}' });
    const two = demo('demo.two', { method: 'get', path: '/api/demo/{b}/' });
    expect(() =>
      createCapabilityHttpRoutes({ registry: () => undefined, capabilities: [one, two] })
    ).toThrow(/"demo.one" and "demo.two" both declare GET \/api\/demo\/:/);
  });

  it('refuses an app where a hand route claims a capability’s path', () => {
    const capability = demo('demo.one', { method: 'post', path: '/api/demo/{id}/go' });
    const app = new Hono();
    // Middleware registered before the mount runs first, as for every route.
    app.use('/api/demo/*', async (_c, next) => next());
    app.route(
      '/',
      createCapabilityHttpRoutes({ registry: () => undefined, capabilities: [capability] })
    );
    app.get('/api/demo/:id/go', (c) => c.text('a GET is another route'));
    expect(() => assertNoCapabilityRouteCollisions(app, [capability])).not.toThrow();
    app.post('/api/demo/:thing/go', (c) => c.text('hand'));
    expect(() => assertNoCapabilityRouteCollisions(app, [capability])).toThrow(
      /POST \/api\/demo\/:\/go \(demo.one\)/
    );
  });
});

describe('mount order', () => {
  const running = () => demo('demo.running', { method: 'get', path: '/api/sessions/running' });
  /** An app with the mount over `capabilities`, plus whatever `hand` registers before and after. */
  function app(
    capabilities: CapabilityDefinition[],
    hand: { before?: (app: Hono) => void; after?: (app: Hono) => void }
  ): Hono {
    const built = new Hono();
    hand.before?.(built);
    built.route('/', createCapabilityHttpRoutes({ registry: () => undefined, capabilities }));
    hand.after?.(built);
    return built;
  }

  it('refuses a hand route registered earlier that would answer a capability’s requests', () => {
    const shadowed = app([running()], {
      before: (hand) => hand.get('/api/sessions/:id', (c) => c.text('hand')),
    });
    expect(() => assertNoCapabilityRouteCollisions(shadowed, [running()])).toThrow(
      /GET \/api\/sessions\/running \(demo.running\) is shadowed by GET \/api\/sessions\/:id/
    );
    const first = app([running()], {
      after: (hand) => hand.get('/api/sessions/:id', (c) => c.text('hand')),
    });
    expect(() => assertNoCapabilityRouteCollisions(first, [running()])).not.toThrow();
  });

  it('refuses a capability that would take requests a more specific hand route is meant for', () => {
    const any = demo('demo.any', { method: 'get', path: '/api/demo/{agentId}' });
    const built = app([any], {
      after: (hand) => hand.get('/api/demo/current', (c) => c.text('hand')),
    });
    expect(() => assertNoCapabilityRouteCollisions(built, [any])).toThrow(
      /\(demo.any\) shadows GET \/api\/demo\/current/
    );
  });

  it('refuses hand middleware after the mount on a capability path, which would never run', () => {
    const built = app([running()], {
      after: (hand) => hand.use('/api/sessions/*', async (_c, next) => next()),
    });
    expect(() => assertNoCapabilityRouteCollisions(built, [running()])).toThrow(
      /\(demo.running\) skips middleware ALL \/api\/sessions\/\*/
    );
  });

  it('lets a capability skip the hand middleware listed with a reason, and no other', () => {
    const real = demo('audit.running_chats', { method: 'get', path: '/api/sessions/running' });
    const guarded = app([real], {
      after: (hand) => hand.use('/api/sessions/:id/*', async (_c, next) => next()),
    });
    expect(
      SKIPPABLE_MIDDLEWARE['GET /api/sessions/running skips ALL /api/sessions/:id/*']
    ).toBeTruthy();
    expect(() => assertNoCapabilityRouteCollisions(guarded, [real])).not.toThrow();
    const other = app([real], {
      after: (hand) => hand.use('/api/sessions/*', async (_c, next) => next()),
    });
    expect(() => assertNoCapabilityRouteCollisions(other, [real])).toThrow(/skips middleware/);
  });

  it('never counts the mount’s own routes against each other', () => {
    const fixed = demo('demo.fixed', { method: 'get', path: '/api/demo/fixed' });
    const any = demo('demo.any', { method: 'get', path: '/api/demo/{id}' });
    const built = app([any, fixed], {});
    expect(() => assertNoCapabilityRouteCollisions(built, [any, fixed])).not.toThrow();
    // A hand route on a capability's own path is still a claim.
    const claimed = app([any, fixed], {
      after: (hand) => hand.get('/api/demo/fixed', (c) => c.text('hand')),
    });
    expect(() => assertNoCapabilityRouteCollisions(claimed, [any, fixed])).toThrow(
      /\(demo.fixed\) is claimed by GET \/api\/demo\/fixed/
    );
    // One registered before the mount is a hand route too, never the mount's
    // own, so it cannot slip past the shadow check for its neighbours.
    const early = app([any, fixed], {
      before: (hand) => hand.get('/api/demo/fixed', (c) => c.text('hand')),
    });
    expect(() => assertNoCapabilityRouteCollisions(early, [any, fixed])).toThrow(
      /\(demo.any\) is shadowed by GET \/api\/demo\/fixed/
    );
  });

  it('reads a regex splat param (`:path{.+}`) as spanning segments', () => {
    const spanned = app([running()], {
      before: (hand) => hand.get('/api/:rest{.+}', (c) => c.text('hand')),
    });
    expect(() => assertNoCapabilityRouteCollisions(spanned, [running()])).toThrow(
      /is shadowed by GET \/api\/:rest\{\.\+\}/
    );
    const oneSegment = app([running()], {
      before: (hand) => hand.get('/api/:id{[0-9]+}', (c) => c.text('hand')),
    });
    expect(() => assertNoCapabilityRouteCollisions(oneSegment, [running()])).not.toThrow();
  });

  it('registers its own routes static before param, whatever order they were declared in', () => {
    const routes = createCapabilityHttpRoutes({
      registry: () => undefined,
      capabilities: [
        demo('demo.any', { method: 'get', path: '/api/demo/{agentId}' }),
        // No http surface: never routed, never compared.
        defineCapability({
          ...demo('demo.none', { method: 'get', path: '/unused' }),
          surfaces: {},
        }) as CapabilityDefinition,
        demo('demo.rest', { method: 'get', path: '/api/demo/{agentId}/items' }),
        demo('demo.fixed', { method: 'get', path: '/api/demo/fixed' }),
      ],
    });
    expect(routes.routes.map((route) => route.path)).toEqual([
      '/api/demo/fixed',
      '/api/demo/:agentId/items',
      '/api/demo/:agentId',
    ]);
    expect(compareRouteSpecificity('/api/demo/fixed', '/api/demo/:id')).toBeLessThan(0);
    expect(compareRouteSpecificity('/api/demo/:id', '/api/demo/*')).toBeLessThan(0);
    expect(compareRouteSpecificity('/api/demo/:a', '/api/demo/:b')).toBe(0);
  });
});

describe('a person-only capability (audience: person)', () => {
  const ran = vi.fn();
  afterEach(() => ran.mockClear());
  const personOnly = (tier: 'observe' | 'act' = 'act'): CapabilityDefinition =>
    defineCapability({
      ...demo(
        'demo.mine',
        { method: 'post', path: '/api/demo/{agentId}', audience: 'person' },
        tier
      ),
      invoke: async (_deps: unknown, input: unknown) => {
        ran();
        return { got: input };
      },
    }) as CapabilityDefinition;
  /** Serve the capability over a registry of it, through the mount and the invoke endpoint. */
  function serve(before?: MiddlewareHandler<ApiEnv>, tier: 'observe' | 'act' = 'act') {
    const capability = personOnly(tier);
    const registry = composeRegistry([{ name: 'demo', capabilities: [capability] }], {
      logger: noopLogger,
    });
    const routes = new Hono<ApiEnv>();
    routes.route(
      '/',
      createCapabilityHttpRoutes({ registry: () => registry, capabilities: [capability] })
    );
    routes.route('/api/capabilities', createCapabilitiesInvokeRoutes(registry));
    return target.mount(honoGroupListener({ path: '/', routes }, before ? { before } : {}));
  }

  it('refuses an agent with 403 person_only before the handler runs, on both doors', async () => {
    const listener = serve(presenting(AS_SCOUT));
    const rest = await request(listener).post('/api/demo/a1').send({});
    expect(rest.status).toBe(403);
    expect(rest.body).toMatchObject({ code: 'person_only' });
    const viaInvoke = await request(target.server)
      .post('/api/capabilities/demo.mine/invoke')
      .send({ agentId: 'a1' });
    expect(viaInvoke.status).toBe(403);
    expect(viaInvoke.body).toMatchObject({ code: 'person_only' });
    expect(ran).not.toHaveBeenCalled();
  });

  it('refuses a caller that sent an agent token this machine could not resolve', async () => {
    const res = await request(serve())
      .post('/api/demo/a1')
      .set('X-DorkOS-Agent', 'not-a-real-token')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
  });

  it('refuses a caller holding an approval token, as the decide endpoint does', async () => {
    const res = await request(serve())
      .post('/api/demo/a1')
      .set('X-DorkOS-Approval', 'some-token')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(ran).not.toHaveBeenCalled();
  });

  it('refuses an Authorization bearer that sent no agent header: a program, not a person', async () => {
    const res = await request(serve())
      .post('/api/demo/a1')
      .set('Authorization', 'Bearer a-key')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(ran).not.toHaveBeenCalled();
  });

  describe('where a person must prove a session (a credential-gated request)', () => {
    /** Mark the request as one the gate asked for a credential, with this caller. */
    function gated(user?: { credential: 'cookie' | 'api-key' }): MiddlewareHandler<ApiEnv> {
      return async (c, next) => {
        markIngress(c.env.incoming, 'wifi');
        if (user) {
          c.set('user', {
            userId: 'owner',
            credential: user.credential,
            sessionId: 'sess-1',
            route: 'wifi',
          });
        }
        await next();
      };
    }

    it('refuses a caller with no person session', async () => {
      const res = await request(serve(gated(), 'observe')).post('/api/demo/a1').send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
    });

    it('refuses a per-user API key', async () => {
      const res = await request(serve(gated({ credential: 'api-key' }), 'observe'))
        .post('/api/demo/a1')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
      expect(ran).not.toHaveBeenCalled();
    });

    it('runs for a person signed in with a browser session', async () => {
      const res = await request(serve(gated({ credential: 'cookie' }), 'observe'))
        .post('/api/demo/a1')
        .send({});
      expect(res.status).toBe(200);
      expect(ran).toHaveBeenCalledOnce();
    });
  });

  it('runs for a person', async () => {
    const res = await request(serve()).post('/api/demo/a1').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ got: { agentId: 'a1' } });
    expect(ran).toHaveBeenCalledOnce();
  });

  it('may not declare an MCP surface, so no MCP server lists it', () => {
    const capability = defineCapability({
      ...personOnly(),
      surfaces: {
        http: { method: 'post', path: '/api/demo/{agentId}', audience: 'person' },
        mcp: { toolName: 'demo_mine', servers: ['external'] },
      },
    }) as CapabilityDefinition;
    expect(() =>
      composeRegistry([{ name: 'demo', capabilities: [capability] }], { logger: noopLogger })
    ).toThrow(/"demo.mine" is for a person only \(http.audience\)/);
  });
});

/** A capability that echoes the input it was handed. */
function demo(
  id: `${string}.${string}`,
  http: HttpSurface,
  tier: 'observe' | 'act' | 'destructive' = 'observe'
): CapabilityDefinition {
  return defineCapability({
    id,
    title: id,
    description: `The ${id} demo.`,
    tier,
    area: null,
    input: z.object({
      agentId: z.string(),
      limit: z.coerce.number().optional(),
      note: z.string().optional(),
    }),
    output: z.unknown(),
    surfaces: { http },
    invoke: async (_deps, input) => ({ got: input }),
  }) as CapabilityDefinition;
}

describe('turning a request into input', () => {
  /** Serve some demo capabilities over a registry of them. */
  function serve(capabilities: CapabilityDefinition[], before?: MiddlewareHandler<ApiEnv>) {
    const registry = composeRegistry([{ name: 'demo', capabilities }], { logger: noopLogger });
    return mount(registry, capabilities, before);
  }

  it('reads a GET’s fields from the query, and its path fills the field it names', async () => {
    const listener = serve([
      demo('demo.read', {
        method: 'get',
        path: '/api/demo/{id}',
        params: { id: 'agentId' },
      }),
    ]);
    const res = await request(listener).get('/api/demo/a%201?limit=3&agentId=ignored');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ got: { agentId: 'a 1', limit: 3 } });
  });

  it('reads a POST’s body, plus the query fields it names, and answers its success code', async () => {
    const listener = serve([
      demo(
        'demo.write',
        { method: 'post', path: '/api/demo/{agentId}', query: ['limit'], success: 201 },
        'act'
      ),
    ]);
    const res = await request(listener)
      .post('/api/demo/a1?limit=7&note=from-query')
      .send({ note: 'from-body', agentId: 'not-the-path' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ got: { agentId: 'a1', limit: 7, note: 'from-body' } });
  });

  it('answers 204 with no body when the surface says so', async () => {
    const listener = serve([
      demo('demo.gone', { method: 'delete', path: '/api/demo/{agentId}', success: 204 }, 'act'),
    ]);
    const res = await request(listener).delete('/api/demo/a1');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('refuses a body that is not an object with the invoke endpoint’s 400', async () => {
    const listener = serve([demo('demo.write', { method: 'put', path: '/api/demo/{agentId}' })]);
    const res = await request(listener).put('/api/demo/a1').send([1, 2]);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('invalid_request');
  });

  describe('the gate, as on the invoke endpoint', () => {
    let approvals: ApprovalService;
    beforeEach(() => {
      approvals = new ApprovalService(createTestDb());
      vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
      initCapabilityTierGate({ approvals });
    });
    afterEach(() => {
      resetCapabilityTierGate();
      vi.restoreAllMocks();
    });

    it('202s an agent’s destructive call, and runs it on the retry once allowed', async () => {
      const capability = demo(
        'demo.destroy',
        { method: 'delete', path: '/api/demo/{agentId}' },
        'destructive'
      );
      const listener = serve([capability], presenting(AS_SCOUT));
      const asked = await request(listener).delete('/api/demo/a1');
      expect(asked.status).toBe(202);
      expect(asked.body.status).toBe('approval_required');
      expect(asked.body.retry.field).toBe('x-dorkos-approval');

      approvals.grant(asked.body.approvalId);
      const retried = await request(target.server)
        .delete('/api/demo/a1')
        .set('X-DorkOS-Approval', asked.body.approvalToken);
      expect(retried.status).toBe(200);
      expect(retried.body).toEqual({ got: { agentId: 'a1' } });
    });

    it('refuses an act capability from a Wi-Fi sign-in before it runs', async () => {
      const listener = serve(
        [demo('demo.act', { method: 'post', path: '/api/demo/{agentId}' }, 'act')],
        async (c, next) => {
          markIngress(c.env.incoming, 'wifi');
          c.set('user', {
            userId: 'owner',
            credential: 'cookie',
            sessionId: 'wifi-sign-in',
            route: 'wifi',
          });
          await next();
        }
      );
      const res = await request(listener).post('/api/demo/a1').send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_from_wifi');
    });
  });
});

describe('agent pause, served by the mount', () => {
  let db: Db;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: SCOUT.id,
        name: 'scout',
        runtime: 'claude-code',
        projectPath: SCOUT.home,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    registry = composeRegistry([agentPauseDomain], {
      logger: noopLogger,
      agentPauseDeps: { pauses: new AgentPauseService({ db }) },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetAuditTrail();
    vi.restoreAllMocks();
  });

  it('pauses, lists and resumes as the person at the app', async () => {
    const listener = mount(registry, agentPauseDomain.capabilities);
    await request(listener)
      .post(`/api/agents/${SCOUT.id}/pause`)
      .send({ reason: 'stop' })
      .expect(200);
    const listed = await request(target.server).get('/api/agents/pauses').expect(200);
    expect(listed.body.pauses).toEqual([
      expect.objectContaining({ agentId: SCOUT.id, reason: 'stop' }),
    ]);
    const resumed = await request(target.server).post(`/api/agents/${SCOUT.id}/resume`).expect(200);
    expect(resumed.body).toMatchObject({ paused: false, changed: true });
  });

  it('answers 404 for an agent that does not exist', async () => {
    const res = await request(mount(registry, agentPauseDomain.capabilities))
      .post('/api/agents/nobody/pause')
      .expect(404);
    expect(res.body.code).toBe('agent_not_found');
  });

  it('answers 403 when the paused agent tries to resume itself', async () => {
    await request(mount(registry, agentPauseDomain.capabilities))
      .post(`/api/agents/${SCOUT.id}/pause`)
      .expect(200);
    const res = await request(
      mount(registry, agentPauseDomain.capabilities, presenting(AS_SCOUT))
    ).post(`/api/agents/${SCOUT.id}/resume`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'forbidden',
      detail: 'An agent can’t lift its own pause. A person has to.',
    });
  });
});

describe('agent pause from a Wi-Fi sign-in, through both doors', () => {
  let registry: CapabilityRegistry;
  let pauses: AgentPauseService;

  beforeEach(() => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: SCOUT.id,
        name: 'scout',
        runtime: 'claude-code',
        projectPath: SCOUT.home,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    pauses = new AgentPauseService({ db });
    registry = composeRegistry([agentPauseDomain], {
      logger: noopLogger,
      agentPauseDeps: { pauses },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetAuditTrail();
    vi.restoreAllMocks();
  });

  /** The mount and the invoke endpoint, reached by the owner signed in over Wi-Fi. */
  function overWifi() {
    return target.mount(
      honoGroupListener(
        [
          {
            path: '/',
            routes: createCapabilityHttpRoutes({
              registry: () => registry,
              capabilities: agentPauseDomain.capabilities,
            }),
          },
          { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
        ],
        {
          before: async (c, next) => {
            markIngress(c.env.incoming, 'wifi');
            c.set('user', {
              userId: 'owner',
              credential: 'cookie',
              sessionId: 'wifi-sign-in',
              route: 'wifi',
            });
            await next();
          },
        }
      )
    );
  }

  it('pauses at its REST path, and refuses the resume', async () => {
    const listener = overWifi();
    await request(listener).post(`/api/agents/${SCOUT.id}/pause`).send({}).expect(200);
    expect(pauses.isPaused(SCOUT.id)).toBeDefined();
    const resume = await request(target.server).post(`/api/agents/${SCOUT.id}/resume`).send({});
    expect(resume.status).toBe(403);
    expect(resume.body.code).toBe('not_from_wifi');
    expect(pauses.isPaused(SCOUT.id)).toBeDefined();
  });

  it('pauses through the invoke endpoint, and refuses the resume', async () => {
    const listener = overWifi();
    await request(listener)
      .post('/api/capabilities/agent.pause/invoke')
      .send({ agentId: SCOUT.id })
      .expect(200);
    expect(pauses.isPaused(SCOUT.id)).toBeDefined();
    const resume = await request(target.server)
      .post('/api/capabilities/agent.resume/invoke')
      .send({ agentId: SCOUT.id });
    expect(resume.status).toBe(403);
    expect(resume.body.code).toBe('not_from_wifi');
    expect(pauses.isPaused(SCOUT.id)).toBeDefined();
  });
});

describe('an agent’s MCP servers, served by the mount', () => {
  const AGENT_ID = '01HV7KJZZZ0000000000000000';
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cap-http-'));
    await writeManifest(projectPath, {
      workspace: { mode: 'home' },
      id: AGENT_ID,
      name: 'test-agent',
      description: 'A test agent',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-08-03T00:00:00.000Z',
      registeredBy: 'test-suite',
      personaEnabled: true,
      isSystem: false,
      mcpServers: [
        {
          name: 'fs',
          enabled: true,
          connection: { transport: 'stdio', command: 'my-server', args: [], env: {} },
          addedAt: '2026-08-03T00:00:00.000Z',
          addedBy: 'operator',
        },
      ],
    });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  /** The mcp domain over an agent living in the temp folder. */
  function mcpRegistry(): CapabilityRegistry {
    const service = new AgentMcpServerService({
      agents: { get: (id) => (id === AGENT_ID ? { projectPath } : undefined) },
      logger: { warn: () => {} },
    });
    return composeRegistry([mcpDomain] as CapabilityDomain[], {
      logger: noopLogger,
      mcpDeps: { service, agents: new AgentRegistry(createTestDb()) },
    });
  }

  it('lists them at GET /api/agents/:agentId/mcp-servers', async () => {
    const registry = mcpRegistry();
    const res = await request(mount(registry, registry.capabilities)).get(
      `/api/agents/${AGENT_ID}/mcp-servers`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ name: 'fs', enabled: true })]);
  });

  it('answers 404 for an agent nobody registered', async () => {
    const registry = mcpRegistry();
    const res = await request(mount(registry, registry.capabilities)).get(
      '/api/agents/nobody/mcp-servers'
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('agent_not_found');
  });
});
