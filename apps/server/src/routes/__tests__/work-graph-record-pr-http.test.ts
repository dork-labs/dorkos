/**
 * `work-graph.record-pr` through the real invoke route (DOR-5264): the token in
 * `X-DorkOS-Agent` is resolved by the real identity step, and the chat is the
 * one a live process holding that token runs. A chat named in the body is
 * refused, and so is a token whose chat is not mid-turn, while another runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../services/core/capabilities/index.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import { initAuth } from '../../services/core/auth/index.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import {
  getAgentIdentityService,
  holdTokenChat,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { resolveAgentIdentityFromHeaders } from '../../middleware/agent-identity.js';
import { RunStore } from '../../services/runs/run-store.js';
import { workGraphDomain } from '../../services/work-graph/work-graph-capabilities.js';
import { WorkLinkStore } from '../../services/work-graph/work-link-store.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

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
    // Real config and a real auth store: login off and no owner, as on a fresh install.
    const home = mkdtempSync(join(tmpdir(), 'dorkos-record-pr-http-'));
    initConfigManager(home);
    initAuth(db, home);
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
    });
    holdTokenChat(token, CHAT);
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
    });
    holdTokenChat(idle, '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b');
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
