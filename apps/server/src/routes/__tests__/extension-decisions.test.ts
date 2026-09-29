/**
 * The decision routes (spec `flow-multiproject` §7.3, §7.6, §7.8, §7.10):
 * the bell's core UI endpoints, the extension-scoped ones its pages use, the
 * per-project settings only a person writes, and `ctx.requirePerson` in front
 * of an extension's own route through the real `/api/ext/:id/*` middleware.
 *
 * Every person-bar case here carries the residual the bar documents: with
 * Require login off, a local caller that does not name itself an agent passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const state = vi.hoisted(() => ({ authEnabled: false }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth'
        ? { enabled: state.authEnabled }
        : { enabled: [], disabled: [], approvedToRun: [] },
    set: () => {},
  },
}));
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');

/** Two projects under `/repos`; the name holds a dot to prove it round-trips. */
vi.mock('../../services/projects/project-registry.js', () => {
  const projects: Record<string, { root: string; name: string }> = {
    '/repos/dorkos': { root: '/repos/dorkos', name: 'dorkos' },
    '/repos/my.app': { root: '/repos/my.app', name: 'my.app' },
  };
  const find = (dir: string) =>
    Object.values(projects).find((p) => dir === p.root || dir.startsWith(`${p.root}/`)) ?? null;
  return {
    projectRegistry: {
      resolveWithin: async (dir: string) => (dir.startsWith('/etc') ? 'outside' : find(dir)),
      listForExtension: async () =>
        Object.values(projects).map((p) => ({ ...p, originRepo: null, lastSeenAt: '' })),
      get: (root: string) =>
        projects[root] ? { ...projects[root], originRepo: null, lastSeenAt: '' } : undefined,
      report: async (dir: string) => find(dir),
      onChange: () => () => {},
    },
  };
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import express, { Router } from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createExtensionDecisionsRouter } from '../extension-decisions.js';
import { createExtensionsRouter } from '../extensions.js';
import { createExtensionRoutesMiddleware } from '../../middleware/extension-routes.js';
import { createDataProviderContext } from '../../services/extensions/extension-server-api-factory.js';
import {
  createInboxFixture,
  shipDecision,
  type InboxFixture,
} from '../../services/extensions/inbox/__tests__/inbox-fixture.js';

const target = swappableServer();
const server = target.server;
const TRUSTED_ORIGIN = 'http://localhost:7777';

afterAll(() => vi.unstubAllEnvs());

let fx: InboxFixture;
let dorkHome: string;
let emitted: Array<{ summary: string }>;
let signedInUser: { userId: string; credential: 'cookie' } | undefined;
let extRouter: Router;

beforeEach(() => {
  state.authEnabled = false;
  signedInUser = undefined;
  emitted = [];
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-decisions-routes-'));
  fx = createInboxFixture({ dorkHome });
  fx.inbox.markRunning('flow', 'Flow');
  fx.inbox.markRunning('other', 'Other');

  const manager = {
    get: (id: string) =>
      id === 'flow' || id === 'other'
        ? { id, manifest: { id, name: id === 'flow' ? 'Flow' : 'Other', version: '1.0.0' } }
        : undefined,
    getServerRouter: (id: string) => (id === 'flow' ? extRouter : null),
    listPublic: () => [],
  };

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (signedInUser) res.locals.user = signedInUser;
    next();
  });
  app.locals.activityService = {
    emit: vi.fn(async (event: { summary: string }) => {
      emitted.push(event);
    }),
  };
  app.use('/api/extension-decisions', createExtensionDecisionsRouter());
  app.use(
    '/api/extensions',
    createExtensionsRouter(manager as never, dorkHome, () => null)
  );
  app.use('/api/ext/:id', createExtensionRoutesMiddleware(manager as never));
  target.mount(app);
});

afterEach(() => {
  fx.inbox.stop();
  fx.close();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

async function raised(extensionId = 'flow', overrides: Record<string, unknown> = {}) {
  await fx.inbox.raise(
    extensionId,
    extensionId === 'flow' ? 'Flow' : 'Other',
    shipDecision({
      link: undefined,
      ...overrides,
    })
  );
  return fx.inbox.listOpen(extensionId)[0].id;
}

describe('GET /api/extension-decisions', () => {
  it('lists open decisions of running extensions, filtered by extension', async () => {
    await raised('flow');
    await raised('other');
    const all = await request(server).get('/api/extension-decisions');
    expect(all.status).toBe(200);
    expect(all.body.decisions).toHaveLength(2);
    expect(all.body.offers).toEqual([]);
    const one = await request(server).get('/api/extension-decisions?extensionId=flow');
    expect(one.body.decisions.map((d: { extensionName: string }) => d.extensionName)).toEqual([
      'Flow',
    ]);
  });
});

describe('POST /api/extension-decisions/:id/action', () => {
  it('refuses an agent that names itself, and nothing is answered', async () => {
    const handler = vi.fn().mockReturnValue({ resolve: 'approved' });
    fx.inbox.setHandler('flow', handler);
    const id = await raised();
    const res = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ action: 'approve' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only a person can answer this.');
    expect(handler).not.toHaveBeenCalled();
    expect(fx.inbox.listOpen()).toHaveLength(1);
  });

  it('refuses a request from another site', async () => {
    fx.inbox.setHandler('flow', () => ({ resolve: 'approved' }));
    const id = await raised();
    const res = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .set('origin', 'https://evil.example')
      .send({ action: 'approve' });
    expect(res.status).toBe(403);
  });

  it('with Require login on, needs the person’s cookie', async () => {
    state.authEnabled = true;
    fx.inbox.setHandler('flow', () => ({ resolve: 'approved' }));
    const id = await raised();
    const refused = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .set('origin', TRUSTED_ORIGIN)
      .send({ action: 'approve' });
    expect(refused.status).toBeGreaterThanOrEqual(401);
    signedInUser = { userId: 'u1', credential: 'cookie' };
    const ok = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .set('origin', TRUSTED_ORIGIN)
      .send({ action: 'approve' });
    expect(ok.status).toBe(200);
  });

  it('answers as the person, then already_resolved on a second click', async () => {
    fx.inbox.setHandler('flow', () => ({
      resolve: 'approved',
      offer: { text: 'Next time?', offerId: 'o' },
    }));
    const id = await raised();
    const first = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .set('origin', TRUSTED_ORIGIN)
      .send({ action: 'approve' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resolved: true, offer: { text: 'Next time?' } });
    const second = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .send({ action: 'approve' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_resolved');
    expect(fx.history()).toHaveLength(1);
  });

  it('says the extension is not running', async () => {
    const id = await raised();
    const res = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .send({ action: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'not_running', error: "Flow isn't running right now." });
  });

  it('refuses a note over 2000 characters and an unknown id', async () => {
    fx.inbox.setHandler('flow', () => ({ resolve: 'rejected' }));
    const id = await raised();
    const long = await request(server)
      .post(`/api/extension-decisions/${id}/action`)
      .send({ action: 'reject', note: 'n'.repeat(2001) });
    expect(long.status).toBe(400);
    const unknown = await request(server)
      .post('/api/extension-decisions/01J00000000000000000000000/action')
      .send({ action: 'approve' });
    expect(unknown.status).toBe(404);
  });
});

describe('POST /api/extension-decisions/:id/offer', () => {
  it('applies the offer once, records it in Activity, then answers offer_gone', async () => {
    fx.inbox.setHandler('flow', (event) =>
      event.action === 'offer'
        ? { resolve: 'approved', message: 'Done.' }
        : {
            resolve: 'approved',
            offer: {
              text: 'Next time, ship on its own?',
              offerId: 'o',
              settingsPatch: { project: '/repos/dorkos', patch: { autonomy: 'tell-me-after' } },
            },
          }
    );
    const id = await raised();
    await request(server).post(`/api/extension-decisions/${id}/action`).send({ action: 'approve' });
    // Returned with the answer only, never listed for another device.
    const listed = await request(server).get('/api/extension-decisions');
    expect(listed.body.offers).toEqual([]);

    const yes = await request(server)
      .post(`/api/extension-decisions/${id}/offer`)
      .send({ accept: true });
    expect(yes.status).toBe(200);
    expect(yes.body).toEqual({ message: 'Done.' });
    expect(emitted.map((e) => e.summary)).toEqual(['Flow settings for dorkos changed']);
    const again = await request(server)
      .post(`/api/extension-decisions/${id}/offer`)
      .send({ accept: true });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('offer_gone');
  });

  it('refuses an agent', async () => {
    const res = await request(server)
      .post('/api/extension-decisions/01J00000000000000000000000/offer')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ accept: true });
    expect(res.status).toBe(403);
  });
});

describe('the extension-scoped routes (api.listDecisions, api.answerDecision)', () => {
  it('lists only that extension’s decisions', async () => {
    await raised('flow');
    await raised('other');
    const res = await request(server).get('/api/extensions/flow/decisions');
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].extensionId).toBe('flow');
  });

  it('answers 404 for another extension’s decision, and attributes its own to the extension', async () => {
    fx.inbox.setHandler('flow', () => ({
      resolve: 'approved',
      offer: { text: 'Next?', offerId: 'o' },
    }));
    fx.inbox.setHandler('other', () => ({ resolve: 'approved' }));
    const flowId = await raised('flow');
    const cross = await request(server)
      .post(`/api/extensions/other/decisions/${flowId}/action`)
      .send({ action: 'approve' });
    expect(cross.status).toBe(404);

    const own = await request(server)
      .post(`/api/extensions/flow/decisions/${flowId}/action`)
      .send({ action: 'approve' });
    expect(own.status).toBe(200);
    expect(own.body.offer).toBeNull();
    expect(fx.history()[0].body).toBe('Ship it · answered in Flow');
  });

  it('refuses an agent', async () => {
    const flowId = await raised('flow');
    const res = await request(server)
      .post(`/api/extensions/flow/decisions/${flowId}/action`)
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ action: 'approve' });
    expect(res.status).toBe(403);
  });
});

describe('per-project settings only a person writes', () => {
  it('refuses an agent and writes nothing', async () => {
    const res = await request(server)
      .put('/api/extensions/flow/project-settings')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ project: '/repos/dorkos', value: { autonomy: 'just-do-it' } });
    expect(res.status).toBe(403);
    const read = await request(server).get(
      '/api/extensions/flow/project-settings?project=/repos/dorkos'
    );
    expect(read.body.value).toBeNull();
  });

  it('lands a person’s write, fires the server half’s onChange, and round-trips a root with a dot', async () => {
    const { ctx, releaseListeners } = createDataProviderContext({
      extensionId: 'flow',
      extensionDir: '/fake',
      dorkHome,
      extensionName: 'Flow',
    });
    const changed = vi.fn();
    ctx.projectSettings.onChange(changed);
    // The server half has no way to write: the type has no setter.
    expect('set' in ctx.projectSettings).toBe(false);

    const res = await request(server)
      .put('/api/extensions/flow/project-settings')
      .send({ project: '/repos/my.app/src', value: { autonomy: 'ask-me-first' } });
    expect(res.status).toBe(204);
    expect(changed).toHaveBeenCalledWith('/repos/my.app');
    expect(await ctx.projectSettings.get('/repos/my.app')).toEqual({ autonomy: 'ask-me-first' });
    const read = await request(server).get(
      '/api/extensions/flow/project-settings?project=/repos/my.app'
    );
    expect(read.body).toMatchObject({
      value: { autonomy: 'ask-me-first' },
      updatedBy: 'extension-page',
    });
    expect(emitted.map((e) => e.summary)).toEqual(['Flow settings for my.app changed']);
    releaseListeners();
  });

  it('refuses a value over 16 KiB', async () => {
    const res = await request(server)
      .put('/api/extensions/flow/project-settings')
      .send({ project: '/repos/dorkos', value: { blob: 'x'.repeat(17 * 1024) } });
    expect(res.status).toBe(413);
  });
});

describe('ctx.requirePerson through /api/ext/:id/*', () => {
  beforeEach(() => {
    const { ctx } = createDataProviderContext({
      extensionId: 'flow',
      extensionDir: '/fake',
      dorkHome,
      extensionName: 'Flow',
    });
    extRouter = Router();
    extRouter.put('/settings', ctx.requirePerson, (_req, res) => res.json({ ok: true }));
    extRouter.get('/open', (_req, res) => res.json({ ok: true }));
  });

  it('refuses an agent with the extension-named copy', async () => {
    const res = await request(server)
      .put('/api/ext/flow/settings')
      .set('x-dorkos-agent', 'a')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "Only a person can change Flow's settings.",
      code: 'extension_person_required',
    });
  });

  it('refuses a cross-site request and admits a same-origin one', async () => {
    const cross = await request(server)
      .put('/api/ext/flow/settings')
      .set('origin', 'https://evil.example')
      .send({});
    expect(cross.status).toBe(403);
    const same = await request(server)
      .put('/api/ext/flow/settings')
      .set('origin', TRUSTED_ORIGIN)
      .send({});
    expect(same.status).toBe(200);
  });

  it('with Require login on, needs the session cookie', async () => {
    state.authEnabled = true;
    const refused = await request(server)
      .put('/api/ext/flow/settings')
      .set('origin', TRUSTED_ORIGIN)
      .send({});
    expect(refused.status).toBeGreaterThanOrEqual(401);
    signedInUser = { userId: 'u1', credential: 'cookie' };
    const ok = await request(server)
      .put('/api/ext/flow/settings')
      .set('origin', TRUSTED_ORIGIN)
      .send({});
    expect(ok.status).toBe(200);
  });

  it('leaves a route without it open (the seam is opt-in)', async () => {
    const res = await request(server).get('/api/ext/flow/open').set('x-dorkos-agent', 'a');
    expect(res.status).toBe(200);
  });
});
