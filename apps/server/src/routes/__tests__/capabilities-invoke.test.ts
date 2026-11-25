/**
 * Tests for `POST /api/capabilities/:id/invoke` (spec `capability-registry`,
 * task 2.4).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
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
import { ApprovalService, hashApprovalInput } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { AgentIdentity } from '../../services/core/agent-identity/index.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';
import {
  getAgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { resolveAgentIdentityFromHeaders } from '../../middleware/agent-identity.js';
import { RunStore } from '../../services/runs/run-store.js';
import { workGraphDomain } from '../../services/work-graph/work-graph-capabilities.js';
import { WorkLinkStore } from '../../services/work-graph/work-link-store.js';
import { createApprovalsRoutes } from '../approvals.js';
import { createCapabilitiesCatalogRoutes } from '../capabilities-catalog.js';
import capabilitiesMatrixRoutes from '../capabilities.js';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { MiddlewareHandler } from 'hono';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import { WIFI_DENY_REASON_REFUSAL } from '../session-answer-wifi.js';

/** What every approval yes from Wi-Fi hears (DOR-3648): it may only deny. */
const WIFI_APPROVAL_REFUSAL = 'Answer at your computer or over Remote Access.';

// The routes are served through the `/api` chain, whose host guard and session
// gate read the login setting: off, as on a fresh install.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

// The session gate admits every request here; the Wi-Fi block below presents
// the person the gate would have proved. Local requests were admitted anyway.
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

// The person the Wi-Fi block signs in as is this install's owner, so what it
// still may not do is pinned for the owner's own sign-in (DOR-3242).
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'owner' }),
  // The owner allowed this Wi-Fi sign-in to run agents, at the computer (DOR-4744).
  readAuthDb: await (async () => {
    const { allowedWifiDeviceDb } =
      await import('../../services/core/auth/__tests__/wifi-allowed-device.js');
    const db = allowedWifiDeviceDb('owner', 'wifi-sign-in');
    return () => db;
  })(),
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const testDomain: CapabilityDomain = {
  name: 'test',
  capabilities: [
    defineCapability({
      id: 'test.echo',
      title: 'Echo',
      description: 'Echo the message back.',
      tier: 'observe',
      area: null,
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
      area: null,
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'fail', servers: ['external'] } },
      invoke: async () => {
        throw new CapabilityToolError({ error: 'boom', code: 'DELIBERATE' });
      },
    }),
    defineCapability({
      id: 'test.crash',
      title: 'Crash',
      description: 'Always throws an unexpected error.',
      tier: 'observe',
      area: null,
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'crash', servers: ['external'] } },
      invoke: async () => {
        throw new Error('ENOENT: no such file, open /secret/path/config.json');
      },
    }),
  ],
};

function buildApp() {
  const registry = composeRegistry([testDomain], { logger: noopLogger });
  return honoGroupListener({
    path: '/api/capabilities',
    routes: createCapabilitiesInvokeRoutes(registry),
  });
}

/** Stand in for the identity the chain would have resolved, if any. */
function presenting(identity?: AgentIdentity): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (identity) c.set('agentIdentity', identity);
    await next();
  };
}

describe('POST /api/capabilities/:id/invoke', () => {
  it('invokes a capability and returns its plain result', async () => {
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/capabilities/test.echo/invoke')
      .send({ msg: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echoed: 'hi' });
  });

  it('404s an unknown capability id', async () => {
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/capabilities/test.nope/invoke')
      .send({});
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'unknown_capability' });
    // A fixed sentence: the id the caller sent is not echoed back.
    expect(res.body.detail).not.toContain('test.nope');
  });

  it("answers a stopped extension's tool with the same sentence the session gives (DOR-2685)", async () => {
    // An ext_ id is a tool whose extension is stopped or restarting, not a
    // typo: the caller is told so, in the words the in-session tool uses.
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/capabilities/ext_mail_app.send_message/invoke')
      .send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'temporarily_unavailable',
      detail: "That tool isn't available right now: its extension is stopped or restarting.",
    });
  });

  it('400s input that fails the capability input schema', async () => {
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/capabilities/test.echo/invoke')
      .send({ msg: 123 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(res.body.issues).toBeDefined();
  });

  it('answers a capability refusal as a problem with a fixed sentence, never its own words', async () => {
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/capabilities/test.fail/invoke')
      .send({});
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toEqual({
      type: 'urn:dorkos:problem:invalid_request',
      title: 'The request didn’t pass its checks.',
      status: 400,
      code: 'invalid_request',
      detail: 'This action refused that request. Check its input and try again.',
    });
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });

  it('answers an unexpected failure as a 500 problem that names nothing internal', async () => {
    const res = await request(fixtureTarget.mount(buildApp()))
      .post('/api/capabilities/test.crash/invoke')
      .send({});
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      code: 'internal_error',
      detail: 'DorkOS hit an error running that action. Try again.',
    });
    expect(JSON.stringify(res.body)).not.toContain('/secret/path');
  });

  // The three groups share the `/api/capabilities` prefix in production
  // (matrix at `/`, catalog at `/catalog`, invoke at `/:id/invoke`); prove the
  // mount order does not shadow invoke and that catalog still resolves.
  it('coexists with the matrix and catalog routes on the shared prefix', async () => {
    const registry = composeRegistry([testDomain], { logger: noopLogger });
    const app = honoGroupListener([
      { path: '/api/capabilities', routes: capabilitiesMatrixRoutes },
      { path: '/api/capabilities/catalog', routes: createCapabilitiesCatalogRoutes(registry) },
      { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
    ]);

    const invoke = await request(fixtureTarget.mount(app))
      .post('/api/capabilities/test.echo/invoke')
      .send({ msg: 'x' });
    expect(invoke.status).toBe(200);
    expect(invoke.body).toEqual({ echoed: 'x' });

    const catalog = await request(fixtureServer).get('/api/capabilities/catalog');
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
          area: null,
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
    return honoGroupListener(
      { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
      { before: presenting(identity) }
    );
  }

  const AGENT: AgentIdentity = {
    agentPath: '/projects/prober',
    displayName: 'Prober',
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    destroyed = [];
    const db = createTestDb();
    approvals = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  it('202s with an approval_required payload and runs nothing', async () => {
    const res = await request(fixtureTarget.mount(buildGatedApp(AGENT)))
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
    const asked = await request(fixtureTarget.mount(app))
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });
    approvals.grant(asked.body.approvalId);

    const retried = await request(fixtureServer)
      .post('/api/capabilities/gated.destroy/invoke')
      .set('X-DorkOS-Approval', asked.body.approvalToken)
      .send({ name: 'production' });

    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ destroyed: 'production' });
    expect(destroyed).toEqual(['production']);
  });

  it('refuses a granted token used for a different target', async () => {
    const app = buildGatedApp(AGENT);
    const asked = await request(fixtureTarget.mount(app))
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'staging' });
    approvals.grant(asked.body.approvalId);

    const redirected = await request(fixtureServer)
      .post('/api/capabilities/gated.destroy/invoke')
      .set('X-DorkOS-Approval', asked.body.approvalToken)
      .send({ name: 'production' });

    expect(redirected.status).toBe(202);
    expect(redirected.body.reason).toBe('wrong_action');
    expect(destroyed).toEqual([]);
  });

  it('403s an agent whose access was turned off, with no approval to chase', async () => {
    const res = await request(fixtureTarget.mount(buildGatedApp({ ...AGENT, inactive: 'revoked' })))
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({
      status: 403,
      code: 'forbidden',
      capabilityId: 'gated.destroy',
      approvable: false,
    });
    expect(res.body).not.toHaveProperty('reason');
    expect(destroyed).toEqual([]);
    expect(approvals.listPending()).toHaveLength(0);
  });

  it('gates a caller that presents NO identity, which is the bypass shape', async () => {
    // `env -u DORKOS_AGENT_TOKEN dorkos call …` and a bare curl both arrive here
    // with no identity, and sessionGate is a pass-through in the default local
    // posture. Requiring less capability must not buy more permission.
    const res = await request(fixtureTarget.mount(buildGatedApp()))
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('approval_required');
    expect(destroyed).toEqual([]);
    expect(approvals.listPending()[0].requestedBy).toBeUndefined();
  });

  it('lets an unidentified caller through once a person grants the approval', async () => {
    const app = buildGatedApp();
    const asked = await request(fixtureTarget.mount(app))
      .post('/api/capabilities/gated.destroy/invoke')
      .send({ name: 'production' });
    approvals.grant(asked.body.approvalId);

    const retried = await request(fixtureServer)
      .post('/api/capabilities/gated.destroy/invoke')
      .set('X-DorkOS-Approval', asked.body.approvalToken)
      .send({ name: 'production' });

    expect(retried.status).toBe(200);
    expect(destroyed).toEqual(['production']);
  });

  describe('the requester cannot decide its own request', () => {
    /**
     * Both REAL routers on one app, exactly as boot mounts them, with local login
     * OFF — the default posture, so the refusal cannot depend on accounts.
     */
    function buildFullApp(identity?: AgentIdentity) {
      const registry = composeRegistry([gateDomain()], { logger: noopLogger });
      return honoGroupListener(
        [
          { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
          {
            path: '/api/approvals',
            routes: createApprovalsRoutes(approvals, { isLoginEnabled: () => false }),
          },
        ],
        { before: presenting(identity) }
      );
    }

    it('breaks the reproduced three-step self-approval chain', async () => {
      // Step 1: ask. The 202 hands the caller BOTH the approval id and its token.
      const app = buildFullApp();
      const asked = await request(fixtureTarget.mount(app))
        .post('/api/capabilities/gated.destroy/invoke')
        .send({ name: 'production' });
      expect(asked.status).toBe(202);
      const { approvalId, approvalToken } = asked.body;

      // Step 2: grant it as the caller that asked. This used to answer 200 because
      // the check keyed on the PRESENCE of an agent identity, so omitting a header
      // was all it took.
      const selfGrant = await request(fixtureServer)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('X-DorkOS-Approval', approvalToken)
        .send();
      expect(selfGrant.status).toBe(403);
      expect(selfGrant.body.code).toBe('person_only');

      // Step 3: retry. Still waiting on a person, and nothing was destroyed.
      const retried = await request(fixtureServer)
        .post('/api/capabilities/gated.destroy/invoke')
        .set('X-DorkOS-Approval', approvalToken)
        .send({ name: 'production' });
      expect(retried.status).toBe(202);
      expect(retried.body.reason).toBe('awaiting_decision');
      expect(destroyed).toEqual([]);
      expect(approvals.listPending()).toHaveLength(1);
    });

    it('breaks it for an identified agent too, even without the token header', async () => {
      const app = buildFullApp(AGENT);
      const asked = await request(fixtureTarget.mount(app))
        .post('/api/capabilities/gated.destroy/invoke')
        .send({ name: 'production' });

      const selfGrant = await request(fixtureServer)
        .post(`/api/approvals/${asked.body.approvalId}/grant`)
        .send();
      expect(selfGrant.status).toBe(403);
      expect(selfGrant.body.code).toBe('person_only');
      expect(destroyed).toEqual([]);
    });
  });
});

describe('a Wi-Fi sign-in and capabilities (DOR-2969)', () => {
  let ran: string[];
  let approvals: ApprovalService;

  /** One capability per tier, each recording that it ran. */
  function tierDomain(): CapabilityDomain {
    return {
      name: 'tiers',
      capabilities: (['observe', 'act', 'destructive'] as const).map((tier) =>
        defineCapability({
          id: `tiers.${tier}`,
          title: tier,
          description: `A ${tier} capability.`,
          tier,
          area: null,
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          surfaces: { mcp: { toolName: `tiers_${tier}`, servers: ['external'] } },
          invoke: async () => {
            ran.push(tier);
            return { ok: true };
          },
        })
      ),
    };
  }

  /**
   * The invoke and approvals routes, reached over Wi-Fi by a signed-in person:
   * the owner unless `userId` names somebody else.
   */
  function wifiApp(userId = 'owner') {
    const registry = composeRegistry([tierDomain()], { logger: noopLogger });
    return honoGroupListener(
      [
        { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
        {
          path: '/api/approvals',
          routes: createApprovalsRoutes(approvals, { isLoginEnabled: () => false }),
        },
      ],
      {
        before: async (c, next) => {
          markIngress(c.env.incoming, 'wifi');
          c.set('user', { userId, credential: 'cookie', sessionId: 'wifi-sign-in', route: 'wifi' });
          await next();
        },
      }
    );
  }

  beforeEach(() => {
    ran = [];
    approvals = new ApprovalService(createTestDb(), {
      describeCapability: (id) => ({
        title: id,
        tier: id === 'tiers.act' ? 'act' : 'destructive',
      }),
    });
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  it('reads through an observe capability', async () => {
    const res = await request(fixtureTarget.mount(wifiApp())).post(
      '/api/capabilities/tiers.observe/invoke'
    );
    expect(res.status).toBe(200);
    expect(ran).toEqual(['observe']);
  });

  it.each(['act', 'destructive'])('refuses a %s capability before it runs', async (tier) => {
    const res = await request(fixtureTarget.mount(wifiApp())).post(
      `/api/capabilities/tiers.${tier}/invoke`
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'not_from_wifi', detail: 'Do this at this computer.' });
    expect(ran).toEqual([]);
  });

  it('only denies from Wi-Fi: every allow, once or always, is refused with where to answer (DOR-3648)', async () => {
    const ask = (capabilityId: string) =>
      approvals.request({ capabilityId, inputHash: hashApprovalInput({}), summary: 'x' });
    const destructive = ask('tiers.destructive');
    const act = ask('tiers.act');
    const server = fixtureTarget.mount(wifiApp());
    for (const [id, body] of [
      [destructive.approvalId, {}],
      [act.approvalId, { answer: 'always' }],
      [act.approvalId, {}],
    ] as const) {
      const refused = await request(server).post(`/api/approvals/${id}/grant`).send(body);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'not_from_wifi', detail: WIFI_APPROVAL_REFUSAL });
      expect(refused.body.heldActionId).toBeUndefined();
    }
    expect(approvals.answerScope(act.approvalId)?.state).toBe('pending');
    const denied = await request(server).post(`/api/approvals/${destructive.approvalId}/deny`);
    expect(denied.status).toBe(200);
  });

  it('refuses a Deny with a reason from anyone but the owner, and takes a bare Deny (DOR-3037)', async () => {
    const card = () =>
      approvals.request({
        capabilityId: 'tiers.act',
        inputHash: hashApprovalInput({}),
        summary: 'x',
      });
    const fromTeammate = card();
    const teammate = fixtureTarget.mount(wifiApp('teammate'));
    const typed = await request(teammate)
      .post(`/api/approvals/${fromTeammate.approvalId}/deny`)
      .send({ reason: 'do the other thing instead' });
    expect(typed.status).toBe(403);
    expect(typed.body).toMatchObject({ code: 'not_from_wifi', detail: WIFI_DENY_REASON_REFUSAL });
    const bare = await request(teammate).post(`/api/approvals/${fromTeammate.approvalId}/deny`);
    expect(bare.status).toBe(200);
    // The owner's own reason is their words (DOR-3242).
    const fromOwner = card();
    const owner = await request(fixtureTarget.mount(wifiApp()))
      .post(`/api/approvals/${fromOwner.approvalId}/deny`)
      .send({ reason: 'do the other thing instead' });
    expect(owner.status).toBe(200);
  });

  it('refuses even Allow once on an act card that could raise permissions (DOR-3037)', async () => {
    const raising = approvals.request({
      capabilityId: 'tiers.act',
      inputHash: hashApprovalInput({}),
      summary: 'Change a permission',
      raisesPermissions: true,
    });
    const server = fixtureTarget.mount(wifiApp());
    const once = await request(server).post(`/api/approvals/${raising.approvalId}/grant`);
    expect(once.status).toBe(403);
    expect(once.body).toMatchObject({ code: 'not_from_wifi', detail: WIFI_APPROVAL_REFUSAL });
    expect(approvals.answerScope(raising.approvalId)?.state).toBe('pending');
    const denied = await request(server).post(`/api/approvals/${raising.approvalId}/deny`);
    expect(denied.status).toBe(200);
  });
});

describe('work-graph.record-pr over HTTP (DOR-5264): the chat is the token’s', () => {
  const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
  const OTHER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
  let links: WorkLinkStore;
  let token: string;

  /** The real chain step: the token in `X-DorkOS-Agent`, resolved by the real service. */
  const resolving: MiddlewareHandler<ApiEnv> = async (c, next) => {
    const identity = await resolveAgentIdentityFromHeaders(
      Object.fromEntries(c.req.raw.headers.entries()),
      'test'
    );
    if (identity) c.set('agentIdentity', identity);
    await next();
  };

  beforeEach(async () => {
    const db = createTestDb();
    links = new WorkLinkStore({ db });
    const runs = new RunStore(db, { epoch: '01THISBOOT0000000000000000' });
    for (const chat of [CHAT, OTHER])
      runs.create({
        chatKey: chat,
        status: 'running',
        openedBy: 'runtime',
        origin: null,
        agentId: 'agent-ana',
      });
    initCapabilityTierGate({ approvals: new ApprovalService(db) });
    token = await initAgentIdentityService(db).mint({
      agentPath: '/agents/ana',
      displayName: 'Ana',
      chatId: CHAT,
    });
    const registry = composeRegistry([workGraphDomain], {
      logger: noopLogger,
      workGraphDeps: {
        store: () => links,
        agentIdForPath: (agentPath) => (agentPath === '/agents/ana' ? 'agent-ana' : undefined),
        resolveChat: (chatId) => links.resolveRekey(chatId),
        liveRun: (chatId) => {
          const run = runs.liveRunOf(chatId);
          return run ? { agentId: run.agentId } : undefined;
        },
        projectorBusy: () => false,
        chatAgentPath: async () => '/agents/ana',
        marksOf: () => ({}),
      },
    });
    fixtureTarget.mount(
      honoGroupListener(
        { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry) },
        { before: resolving }
      )
    );
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetAgentIdentityService();
  });

  const pr = 'https://github.com/dork-labs/dorkos/pull/4242';

  const invoke = () => request(fixtureServer).post('/api/capabilities/work-graph.record-pr/invoke');
  const written = () =>
    links.from({ kind: 'chat', id: CHAT }).concat(links.from({ kind: 'chat', id: OTHER }));

  it('records on the chat the token was minted for', async () => {
    const res = await invoke()
      .set('X-DorkOS-Agent', token)
      .send({ pr, tickets: ['DOR-5264'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, chat: CHAT, tickets: ['DOR-5264'] });
    expect(links.from({ kind: 'chat', id: OTHER })).toEqual([]);
  });

  it.each(['chat', 'chatId', 'sessionId'])(
    'refuses a differing chat id sent as `%s`, and writes nothing',
    async (field) => {
      const res = await invoke()
        .set('X-DorkOS-Agent', token)
        .send({ pr, [field]: OTHER });
      expect(res.status).toBe(400);
      expect(written()).toEqual([]);
    }
  );

  it('never falls back to another chat: a token whose chat is idle is refused while another runs', async () => {
    const idle = await getAgentIdentityService()!.mint({
      agentPath: '/agents/ana',
      displayName: 'Ana',
      chatId: '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b',
    });
    const res = await invoke().set('X-DorkOS-Agent', idle).send({ pr });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'forbidden' });
    expect(written()).toEqual([]);
  });

  it('refuses a caller with no token', async () => {
    const res = await invoke().send({ pr });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'forbidden' });
    expect(written()).toEqual([]);
  });
});
