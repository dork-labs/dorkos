/** Browser controls must apply real caller facts before reaching the browser service. */
import type { RequestListener } from 'node:http';
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
  capabilities: spies.capabilities,
  pause: spies.pause,
  handover: {
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
    routes: createLocalBrowserRoutes(service as unknown as LocalBrowserService),
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
