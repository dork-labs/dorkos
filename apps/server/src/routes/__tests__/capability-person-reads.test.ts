/**
 * A person's own reads on a capability's REST path are not gated by the area
 * defaults set for agents (DOR-4978): the REST door mints the person proof for
 * an `observe` call, and the proof skips only the area permission. Every
 * signal that is not the person turns the proof off, and `/invoke`, agents and
 * `act` calls are gated exactly as before. The reads are audited, grouped.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { user, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { PERSON_APP_HEADER } from '@dorkos/shared/person-session';
import type { AuditEvent } from '@dorkos/shared/audit-schemas';

import {
  CapabilityToolError,
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
  type CapabilityDefinition,
  type CapabilityDeps,
} from '../../services/core/capabilities/index.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import { initAuth } from '../../services/core/auth/index.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import type { AgentIdentity } from '../../services/core/agent-identity/index.js';
import {
  createCapabilityAttributionObserver,
  personReadRecorder,
  PERSON_READ_MAX_WINDOWS,
  PERSON_READ_ACTION,
  PERSON_READ_REASON,
  PERSON_READ_WINDOW_MS,
} from '../../services/core/agent-identity/capability-attribution.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { todoViewDomain } from '../../services/todos/todo-http-capabilities.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createCapabilityHttpRoutes } from '../capability-http.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';

const target = swappableServer();

const AS_SCOUT: AgentIdentity = {
  agentPath: '/projects/scout',
  displayName: 'Scout',
  createdAt: new Date().toISOString(),
};

/** An `act` capability in the To-dos area, on its own REST path. */
const addInTodos = defineCapability({
  id: 'todos.demo_add',
  title: 'Add a demo to-do',
  description: 'An act in the To-dos area.',
  tier: 'act',
  area: 'todos',
  input: z.object({}),
  output: z.unknown(),
  surfaces: { http: { method: 'post', path: '/api/demo-todos' } },
  invoke: async () => ({ added: true }),
}) as CapabilityDefinition;

/** A read in the To-dos area whose handler always refuses. */
const brokenRead = defineCapability({
  id: 'todos.demo_broken',
  title: 'Open a broken demo',
  description: 'A read in the To-dos area that refuses.',
  tier: 'observe',
  area: 'todos',
  input: z.object({}),
  output: z.unknown(),
  surfaces: { http: { method: 'get', path: '/api/demo-broken' } },
  invoke: async () => {
    throw new CapabilityToolError({ error: 'Not found.', code: 'not_found' });
  },
}) as CapabilityDefinition;

const LIST = { todos: [], hiddenDoneCount: 0 };
const deps = {
  logger: noopLogger,
  todoViewDeps: { todos: { list: () => LIST, get: () => undefined } },
} as unknown as CapabilityDeps;

describe('a person reads an area agents are Blocked in (DOR-4978)', () => {
  let audited: AuditEvent[];
  let db: Db;
  let home: string;

  /** Make this install have an owner account: a real row in the auth store. */
  function addOwner(): void {
    db.insert(user)
      .values({
        id: 'user_owner',
        name: 'Owner',
        email: 'owner@reads.test',
        createdAt: new Date(1),
        updatedAt: new Date(1),
      })
      .run();
  }

  beforeEach(() => {
    db = createTestDb();
    home = mkdtempSync(join(tmpdir(), 'dorkos-person-reads-'));
    // Real config and a real auth store: login off and no owner, as on a fresh install.
    initConfigManager(home);
    initAuth(db, home);
    const log = new AuditLog(db);
    audited = [];
    log.observe((event) => audited.push(event));
    initAuditTrail({
      log,
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({
        preset: 'trusted',
        defaults: { areas: { todos: 'blocked' }, actions: {} },
      }),
      readAgentPermissions: async () => undefined,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPermissionGate();
    resetCapabilityTierGate();
    resetAuditTrail();
  });

  /** Serve the reads and the act demo on their REST paths and on `/invoke`. */
  function serve(before?: MiddlewareHandler<ApiEnv>) {
    const activity = { emit: vi.fn() } as unknown as ActivityService;
    const capabilities = [...todoViewDomain.capabilities, addInTodos, brokenRead];
    const registry = composeRegistry(
      [{ name: 'todos', capabilities }],
      deps,
      createCapabilityAttributionObserver(activity)
    );
    const routes = new Hono<ApiEnv>();
    routes.route('/', createCapabilityHttpRoutes({ registry: () => registry, capabilities }));
    routes.route('/api/capabilities', createCapabilitiesInvokeRoutes(registry));
    return target.mount(honoGroupListener({ path: '/', routes }, before ? { before } : {}));
  }

  /** A request the gate asked a credential of (Wi-Fi), with this caller, if any. */
  function gated(caller?: {
    credential: 'cookie' | 'api-key';
    sessionId?: string;
  }): MiddlewareHandler<ApiEnv> {
    return async (c, next) => {
      markIngress(c.env.incoming, 'wifi');
      if (caller) {
        c.set('user', {
          userId: 'owner',
          credential: caller.credential,
          sessionId: c.req.header('X-Test-Sign-In') ?? caller.sessionId ?? 's',
          route: 'wifi',
        });
      }
      await next();
    };
  }

  /** Stand in for the agent identity the chain resolved. */
  const asScout: MiddlewareHandler<ApiEnv> = async (c, next) => {
    c.set('agentIdentity', AS_SCOUT);
    await next();
  };

  /** The gate's `permission_blocked` refusal, as HTTP answers it. */
  const expectBlocked = (res: { status: number; body: { code?: string; detail?: string } }) => {
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.detail).toMatch(/block/i);
  };

  const personReads = () => audited.filter((event) => event.action === PERSON_READ_ACTION);

  it('lets the person read on the REST path, audited as the person’s rest-proof read', async () => {
    const res = await request(serve()).get('/api/todos');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(LIST);
    expect(personReads()).toEqual([
      expect.objectContaining({
        operation: 'access',
        outcome: 'ok',
        reason: PERSON_READ_REASON,
        target: expect.objectContaining({ type: 'capability', id: 'todos.view_list' }),
      }),
    ]);
    expect(personReads()[0]!.actor.kind).toBe('person');
  });

  it('lets a person signed in with a browser session read, where login asks for one', async () => {
    const res = await request(serve(gated({ credential: 'cookie' }))).get('/api/todos');
    expect(res.status).toBe(200);
  });

  it('refuses a caller that presented an agent header', async () => {
    expectBlocked(await request(serve()).get('/api/todos').set('X-DorkOS-Agent', 'not-a-token'));
  });

  it('refuses a caller holding an approval token', async () => {
    expectBlocked(await request(serve()).get('/api/todos').set('X-DorkOS-Approval', 'some-token'));
  });

  it('refuses a caller with an API key header', async () => {
    expectBlocked(await request(serve()).get('/api/todos').set('X-API-Key', 'a-key'));
  });

  it('refuses a per-user API key where login is on', async () => {
    expectBlocked(await request(serve(gated({ credential: 'api-key' }))).get('/api/todos'));
  });

  it('refuses any Authorization header', async () => {
    expectBlocked(await request(serve()).get('/api/todos').set('Authorization', 'Basic eDp5'));
  });

  it('refuses a Proxy-Authorization header', async () => {
    expectBlocked(
      await request(serve()).get('/api/todos').set('Proxy-Authorization', 'Basic eDp5')
    );
  });

  it('refuses a caller with no person session where login is on', async () => {
    expectBlocked(await request(serve(gated())).get('/api/todos'));
  });

  it('refuses a caller with no session at this computer once login is on and an owner exists', async () => {
    addOwner();
    initConfigManager(home).set('auth', { enabled: true });
    const res = await request(serve()).get('/api/todos');
    expect(res.status).not.toBe(200);
    expect(personReads()).toEqual([]);
  });

  it('hands the handler only the yes/no request answers: no group, address or id', async () => {
    const seen: unknown[] = [];
    const probe = defineCapability({
      id: 'todos.demo_probe',
      title: 'Probe',
      description: 'A read in the To-dos area that keeps its context.',
      tier: 'observe',
      area: 'todos',
      input: z.object({}),
      output: z.unknown(),
      surfaces: { http: { method: 'get', path: '/api/demo-probe' } },
      invoke: async (_deps, _input, context) => {
        seen.push(context);
        return {};
      },
    }) as CapabilityDefinition;
    const registry = composeRegistry([{ name: 'todos', capabilities: [probe] }], deps);
    const routes = createCapabilityHttpRoutes({ registry: () => registry, capabilities: [probe] });
    const listener = target.mount(
      honoGroupListener({ path: '/', routes }, { before: gated({ credential: 'cookie' }) })
    );
    await request(listener).get('/api/demo-probe').expect(200);
    const context = seen[0] as { request: object; personRead?: string };
    expect(context.personRead).toBe('rest-proof');
    expect(Object.keys(context.request).sort()).toEqual([
      'accountOwner',
      'atThisComputerWithoutProgramKey',
      'heldWifiOwner',
      'ownerProven',
    ]);
    expect(JSON.stringify(context)).not.toMatch(/sign-in:|address:|readGroup/);
  });

  it('still refuses an identified agent', async () => {
    expectBlocked(await request(serve(asScout)).get('/api/todos'));
  });

  it('still refuses the same read through /invoke', async () => {
    serve();
    const res = await request(target.server)
      .post('/api/capabilities/todos.view_list/invoke')
      .send({});
    expectBlocked(res);
    expect(personReads()).toEqual([]);
  });

  it('still refuses an act capability in the Blocked area', async () => {
    expectBlocked(await request(serve()).post('/api/demo-todos').send({}));
  });

  it('keeps an act call’s own refusal from the app with no session, not a password prompt', async () => {
    addOwner();
    const res = await request(serve()).post('/api/demo-todos').set(PERSON_APP_HEADER, '1').send({});
    expectBlocked(res);
  });

  describe('the audit rows, grouped (Security, t1j)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    });

    it('writes the first read in each 10-minute window, and one row per window', async () => {
      const listener = serve();
      await request(listener).get('/api/todos').expect(200);
      await request(target.server).get('/api/todos').expect(200);
      expect(personReads()).toHaveLength(1);
      vi.setSystemTime(Date.now() + PERSON_READ_WINDOW_MS);
      await request(target.server).get('/api/todos').expect(200);
      expect(personReads()).toHaveLength(2);
    });

    it('groups by sign-in and capability, not by person alone, nor by a header the caller picks', async () => {
      const listener = serve(gated({ credential: 'cookie' }));
      await request(listener).get('/api/todos').set('X-Test-Sign-In', 'phone').expect(200);
      await request(target.server).get('/api/todos').set('X-Test-Sign-In', 'laptop').expect(200);
      await request(target.server).get('/api/todos').set('X-Test-Sign-In', 'phone').expect(200);
      // A client id the caller chose opens no new window.
      await request(target.server)
        .get('/api/todos')
        .set('X-Test-Sign-In', 'phone')
        .set('X-Client-Id', 'another-window')
        .expect(200);
      await request(target.server).get('/api/todos/t1').set('X-Test-Sign-In', 'phone');
      expect(personReads().map((event) => event.target?.id)).toEqual([
        'todos.view_list',
        'todos.view_list',
        'todos.view_card',
      ]);
    });

    it('remembers a bounded number of windows, forgetting the oldest first', () => {
      const record = personReadRecorder();
      const read = todoViewDomain.capabilities[0]!;
      const context = { personRead: 'rest-proof' as const };
      for (let i = 0; i <= PERSON_READ_MAX_WINDOWS; i++) {
        record(read, context, true, `address:10.0.${Math.floor(i / 256)}.${i % 256}`);
      }
      expect(personReads()).toHaveLength(PERSON_READ_MAX_WINDOWS + 1);
      // The newest is still open; the oldest was forgotten, so it writes again.
      record(read, context, true, `address:10.0.3.232`);
      expect(personReads()).toHaveLength(PERSON_READ_MAX_WINDOWS + 1);
      record(read, context, true, 'address:10.0.0.0');
      expect(personReads()).toHaveLength(PERSON_READ_MAX_WINDOWS + 2);
    });

    it('never groups a refused read: each one is written', async () => {
      const listener = serve();
      await request(listener).get('/api/demo-broken');
      await request(target.server).get('/api/demo-broken');
      expect(personReads().map((event) => event.outcome)).toEqual(['failed', 'failed']);
    });
  });
});
