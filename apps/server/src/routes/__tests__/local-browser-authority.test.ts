/** Browser controls must apply real caller facts before reaching the browser service. */
import type { RequestListener } from 'node:http';
import { createTestDb } from '@dorkos/test-utils/db';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: true } : undefined),
    onChange: () => () => {},
  },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'user_owner', name: 'Owner' }),
}));

import { createLocalBrowserRoutes } from '../local-browser.js';
import type { LocalBrowserService } from '../../services/session/local-browser/service.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

const spies = {
  forgetProfile: vi.fn(async () => undefined),
  deleteProfile: vi.fn(async () => undefined),
  capabilities: vi.fn(() => ({})),
  state: vi.fn(async () => ({})),
  open: vi.fn(async () => ({})),
  selectTab: vi.fn(async () => ({})),
  navigate: vi.fn(async () => ({})),
  pause: vi.fn(async () => ({})),
  resume: vi.fn(async () => ({})),
  disconnect: vi.fn(async () => ({})),
  signIn: vi.fn(async () => ({})),
  handBack: vi.fn(async () => ({})),
  stop: vi.fn(async () => ({})),
};
// Everything a person does that can move, close or open the browser goes through the handoff.
const service = {
  profileRemoval: {
    forget: spies.forgetProfile,
    forgetAll: spies.forgetProfile,
    delete: spies.deleteProfile,
  },
  capabilities: spies.capabilities,
  handover: {
    pause: spies.pause,
    state: spies.state,
    open: spies.open,
    selectTab: spies.selectTab,
    navigate: spies.navigate,
    disconnect: spies.disconnect,
    resume: spies.resume,
    signIn: spies.signIn,
    handBack: spies.handBack,
    stop: spies.stop,
  },
};
let user = { userId: 'user_owner', credential: 'cookie' as 'cookie' | 'api-key' };
let managed = false;
const listener = honoGroupListener(
  {
    path: '/api/local-browser',
    routes: createLocalBrowserRoutes(service as unknown as LocalBrowserService, {
      profiles: {
        get: vi.fn(() => ({
          id: '11111111-1111-4111-8111-111111111111',
          label: 'Example',
          createdAt: 'now',
          agentIds: [],
        })),
        list: vi.fn(() => []),
        create: vi.fn(),
        isBound: vi.fn(),
        bind: vi.fn(),
        unbind: vi.fn(),
        remove: vi.fn(),
      },
      agent: vi.fn(),
    }),
  },
  {
    before: async (c, next) => {
      c.set('user', user);
      await next();
    },
  }
);
const markedListener: RequestListener = (incoming, response) => {
  if (managed) markIngress(incoming, 'managed');
  listener(incoming, response);
};
const server = listeningServer(markedListener);
const endpoints = [
  ['post', '/profiles/default/forget-sign-ins', undefined, 'forgetProfile'],
  [
    'post',
    '/profiles/11111111-1111-4111-8111-111111111111/forget-sign-ins',
    undefined,
    'forgetProfile',
  ],
  ['delete', '/profiles/11111111-1111-4111-8111-111111111111', undefined, 'deleteProfile'],
  ['get', '/capabilities', undefined, 'capabilities'],
  ['get', '/state', undefined, 'state'],
  ['post', '/open', { mode: 'new-window' }, 'open'],
  ['post', '/tabs/tab-1/select', undefined, 'selectTab'],
  ['post', '/navigate', { url: 'https://example.test/' }, 'navigate'],
  ['post', '/pause', undefined, 'pause'],
  ['post', '/resume', undefined, 'resume'],
  ['post', '/disconnect', undefined, 'disconnect'],
  ['post', '/sign-in', { url: 'https://example.test/' }, 'signIn'],
  ['post', '/handoff/hand-back', { handoffId: 'h1' }, 'handBack'],
  ['post', '/handoff/stop', { handoffId: 'h1' }, 'stop'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  user = { userId: 'user_owner', credential: 'cookie' };
  managed = false;
});

describe.each(endpoints)('%s %s authority', (method, path, body, effect) => {
  it.each(['owner', 'managed', 'non-owner', 'api-key', 'agent'] as const)(
    '%s caller',
    async (caller) => {
      managed = caller === 'managed';
      if (caller === 'non-owner') user.userId = 'user_guest';
      if (caller === 'api-key') user.credential = 'api-key';
      const call = request(server)
        [method]('/api/local-browser' + path)
        .set('Host', 'localhost');
      if (caller === 'agent') call.set('X-DorkOS-Agent', '');
      if (body) call.send(body);
      const response = await call;
      if (caller === 'owner') {
        expect(response.status).toBe(200);
        expect(spies[effect]).toHaveBeenCalledOnce();
      } else {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe(caller === 'managed' ? 'local_only' : 'owner_only');
        for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
      }
    }
  );
});

describe.each([
  ['/profiles/default/forget-sign-ins', undefined],
  ['/profiles/11111111-1111-4111-8111-111111111111/forget-sign-ins', undefined],
  ['/open', { mode: 'new-window' }],
  ['/tabs/tab-1/select', undefined],
  ['/navigate', { url: 'https://example.test/' }],
  ['/resume', undefined],
  ['/disconnect', undefined],
  ['/sign-in', { url: 'https://example.test/' }],
  ['/handoff/hand-back', { handoffId: 'h1' }],
  ['/handoff/stop', { handoffId: 'h1' }],
] as const)('POST %s takes a person', (path, body) => {
  it('refuses an approval token, even from the owner', async () => {
    const call = request(server)
      .post('/api/local-browser' + path)
      .set('Host', 'localhost')
      .set('X-DorkOS-Approval', 'anything');
    if (body) call.send(body);
    const response = await call;
    expect(response.status).toBe(403);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });
});

it('refuses an approval token for profile deletion', async () => {
  const response = await request(server)
    .delete('/api/local-browser/profiles/11111111-1111-4111-8111-111111111111')
    .set('Host', 'localhost')
    .set('X-DorkOS-Approval', 'anything');
  expect(response.status).toBe(403);
  expect(spies.deleteProfile).not.toHaveBeenCalled();
});

it('refuses a one-site option instead of silently forgetting every site', async () => {
  const response = await request(server)
    .post('/api/local-browser/profiles/default/forget-sign-ins')
    .set('Host', 'localhost')
    .send({ site: 'example.test' });
  expect(response.status).toBe(400);
  expect(spies.forgetProfile).not.toHaveBeenCalled();
});

it('refuses a force-delete option before removing a profile', async () => {
  const response = await request(server)
    .delete('/api/local-browser/profiles/11111111-1111-4111-8111-111111111111')
    .set('Host', 'localhost')
    .send({ force: true });
  expect(response.status).toBe(400);
  expect(spies.deleteProfile).not.toHaveBeenCalled();
});

it.each(['forget', 'delete'] as const)(
  'records a person-only profile %s in Activity',
  async (operation) => {
    const db = createTestDb();
    const log = new AuditLog(db);
    initAuditTrail({
      log,
      accounts: new AccountIds({ db, installId: 'test', readOwnerAccount: () => null }),
    });
    try {
      const base = '/api/local-browser/profiles/11111111-1111-4111-8111-111111111111';
      const response =
        operation === 'forget'
          ? await request(server)
              .post(base + '/forget-sign-ins')
              .set('Host', 'localhost')
          : await request(server).delete(base).set('Host', 'localhost');
      expect(response.status).toBe(200);
      const action =
        operation === 'forget' ? 'local_browser.sign_ins.forget' : 'local_browser.profile.delete';
      expect(log.query({ action, limit: 10 }, { kind: 'owner' }).events).toMatchObject([
        {
          outcome: 'ok',
          source: { surface: 'app' },
          target: { type: 'browser-profile', id: '11111111-1111-4111-8111-111111111111' },
        },
      ]);
    } finally {
      resetAuditTrail();
    }
  }
);

// DOR-3207: `/pause` skips the person check on purpose, because a stop should be
// easy to press. That is safe only while it stays a stop: it may never end or
// answer a handoff, move the page or tab, open or close anything, or lift a pause.
it('POST /pause is stop-only: it reaches the stop and nothing else', async () => {
  const response = await request(server).post('/api/local-browser/pause').set('Host', 'localhost');
  expect(response.status).toBe(200);
  expect(spies.pause).toHaveBeenCalledOnce();
  for (const [name, spy] of Object.entries(spies))
    if (name !== 'pause') expect(spy, name).not.toHaveBeenCalled();
});

it('POST /pause ignores a body that names a handoff, a page or a tab', async () => {
  const response = await request(server)
    .post('/api/local-browser/pause')
    .set('Host', 'localhost')
    .send({ handoffId: 'h1', url: 'https://example.test/', tabId: 'tab-1', resume: true });
  expect(response.status).toBe(200);
  expect(spies.pause).toHaveBeenCalledWith(undefined);
  for (const [name, spy] of Object.entries(spies))
    if (name !== 'pause') expect(spy, name).not.toHaveBeenCalled();
});

it('scopes person controls to the chat named in the authenticated request query', async () => {
  const query = '?sessionId=atlas';
  const state = await request(server)
    .get('/api/local-browser/state' + query)
    .set('Host', 'localhost');
  expect(state.status).toBe(200);
  expect(spies.state).toHaveBeenCalledWith('atlas');
  for (const [path, body] of [
    ['/pause', {}],
    ['/resume', {}],
    ['/disconnect', {}],
    ['/navigate', { url: 'https://atlas.example/' }],
    ['/tabs/tab-atlas/select', {}],
  ] as const) {
    const response = await request(server)
      .post('/api/local-browser' + path + query)
      .set('Host', 'localhost')
      .send(body);
    expect(response.status).toBe(200);
  }
  expect(spies.pause).toHaveBeenCalledWith('atlas');
  expect(spies.resume).toHaveBeenCalledWith('atlas');
  expect(spies.disconnect).toHaveBeenCalledWith('atlas');
  expect(spies.navigate).toHaveBeenCalledWith('https://atlas.example/', 'atlas');
  expect(spies.selectTab).toHaveBeenCalledWith('tab-atlas', 'atlas');
});
