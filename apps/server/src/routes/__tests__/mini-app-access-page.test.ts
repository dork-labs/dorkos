/**
 * The page outside the app where a person lets a mini app read an app
 * (DOR-3547, Security's out-of-app page conditions). Driven through the real
 * `/api` chain, with a fake view and made-up data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { ExtensionConnectionError } from '@dorkos/extension-api/server';
import { initConfigManager } from '../../services/core/config-manager.js';
import { createMiniAppAccessPageRoutes } from '../mini-app-access-page.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { MiniAppDecisionTokens } from '../../services/connectors/extensions/mini-app-decision-tokens.js';
import type {
  MiniAppAccess,
  MiniAppAccessRequest,
} from '../../services/connectors/extensions/mini-app-access.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const ORIGIN = 'http://localhost:4242';
const PAGE = '/api/connectors/mini-app-access/page?extension=flow-owner&service=linear';
const DECISION = '/api/connectors/mini-app-access/decision';
const NAVIGATE = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const SAME_PAGE = { 'sec-fetch-site': 'same-origin', origin: ORIGIN };

const REQUEST: MiniAppAccessRequest = {
  waiting: {
    extensionId: 'flow-owner',
    extensionName: 'Flow <b>',
    service: 'linear',
    operations: ['LINEAR_LIST_LINEAR_PROJECTS'],
    reason: 'new',
  },
  author: 'Dork Labs',
  source: 'dork-labs/marketplace',
  filesDigest: 'sha256:files-1',
  accounts: [{ connectionId: 'linear-work', label: 'Work Linear' }],
};

const target = swappableServer();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-mini-app-page-'));
beforeAll(() => {
  initConfigManager(configDir);
});
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('the mini app access page', () => {
  const access = { describe: vi.fn(), approve: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    access.describe.mockReturnValue(REQUEST);
    access.approve.mockReturnValue({ approvalId: 'a', granted: ['X'], notRead: [], missing: [] });
    target.mount(
      honoGroupListener({
        path: '/api/connectors',
        routes: createMiniAppAccessPageRoutes({
          access: () => access as unknown as MiniAppAccess,
          tokens: new MiniAppDecisionTokens(),
          resolveOwner: () => OWNER,
          loginEnabled: () => false,
          trustedOrigins: () => [ORIGIN],
        }),
      })
    );
  });

  /** Load the page as a browser would, and return its token and cookie. */
  async function openPage() {
    const res = await request(target.server).get(PAGE).set(NAVIGATE);
    expect(res.status).toBe(200);
    const token = /data-token="([^"]+)"/u.exec(res.text)?.[1];
    const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.[0]?.split(
      ';'
    )[0];
    return { res, token: token!, cookie: cookie! };
  }

  function decide(body: object, headers: Record<string, string>) {
    return request(target.server).post(DECISION).set(headers).send(body);
  }

  it('answers only a real page load, never a fetch or a frame', async () => {
    for (const headers of [
      {},
      { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' },
    ]) {
      const res = await request(target.server).get(PAGE).set(headers);
      expect(res.status).toBe(403);
      expect(res.text).not.toContain('data-token');
    }
    expect(access.describe).not.toHaveBeenCalled();
  });

  it('refuses an agent even on a page load', async () => {
    const res = await request(target.server)
      .get(PAGE)
      .set({ ...NAVIGATE, 'x-dorkos-agent': 'agent-a' });
    expect(res.status).toBe(403);
    expect(access.describe).not.toHaveBeenCalled();
  });

  it('renders what waits, escaped, with a token in the body and locked-down headers', async () => {
    const { res, token, cookie } = await openPage();
    expect(res.text).toContain('Let Flow &lt;b&gt; read Linear?');
    expect(res.text).toContain('Made by Dork Labs. From dork-labs/marketplace.');
    expect(res.text).toContain('LINEAR_LIST_LINEAR_PROJECTS');
    expect(res.text).toContain('Work Linear');
    expect(res.text).toContain('<script src="page.js"></script>');
    expect(res.text).not.toMatch(/<script>|\son[a-z]+=/u);
    expect(token).toMatch(/^[\w-]{40,}$/u);
    expect(PAGE).not.toContain(token);
    expect(cookie).toMatch(/^dorkos_mini_app_access=/u);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/iu);
    expect(setCookie).toMatch(/SameSite=Strict/iu);
    expect(setCookie).toContain('Path=/api/connectors/mini-app-access');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('names DorkOS, shows one account as text, and offers a choice only for two or more', async () => {
    const one = await request(target.server).get(PAGE).set(NAVIGATE);
    expect(one.text).toContain('<p class="brand">DorkOS</p>');
    expect(one.text).toContain('<title>Allow access · DorkOS</title>');
    expect(one.text).toContain('data-account="linear-work"');
    expect(one.text).not.toContain('type="radio"');
    access.describe.mockReturnValue({
      ...REQUEST,
      accounts: [...REQUEST.accounts, { connectionId: 'linear-home', label: 'Home Linear' }],
    });
    const two = await request(target.server).get(PAGE).set(NAVIGATE);
    expect(two.text.match(/type="radio"/gu)).toHaveLength(2);
  });

  it('says nothing waits, with no token, when nothing does', async () => {
    access.describe.mockReturnValue(undefined);
    const res = await request(target.server).get(PAGE).set(NAVIGATE);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Nothing is waiting here');
    expect(res.text).not.toContain('data-token');
  });

  it('serves its script and styles as static files', async () => {
    const js = await request(target.server).get('/api/connectors/mini-app-access/page.js');
    expect(js.headers['content-type']).toMatch(/^text\/javascript/u);
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.text).toContain("document.visibilityState === 'visible'");
    const css = await request(target.server).get('/api/connectors/mini-app-access/page.css');
    expect(css.headers['content-type']).toMatch(/^text\/css/u);
  });

  it('approves on the page itself, with the files the page showed', async () => {
    const { token, cookie } = await openPage();
    const res = await decide(
      { token, decision: 'approve', connectionId: 'linear-work' },
      { ...SAME_PAGE, cookie }
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved' });
    expect(access.approve).toHaveBeenCalledWith({
      extensionId: 'flow-owner',
      service: 'linear',
      connectionId: 'linear-work',
      filesDigest: 'sha256:files-1',
      approvedBy: 'local',
    });
  });

  it('a token works once', async () => {
    const { token, cookie } = await openPage();
    const body = { token, decision: 'approve', connectionId: 'linear-work' };
    expect((await decide(body, { ...SAME_PAGE, cookie })).status).toBe(200);
    const again = await decide(body, { ...SAME_PAGE, cookie });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('MINI_APP_ACCESS_STALE');
    expect(access.approve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no token', { decision: 'approve', connectionId: 'linear-work' }, {}],
    [
      'a made-up token',
      { token: 'x'.repeat(43), decision: 'approve', connectionId: 'linear-work' },
      {},
    ],
  ])('refuses %s', async (_case, body, extra) => {
    const { cookie } = await openPage();
    const res = await decide(body, { ...SAME_PAGE, cookie, ...extra });
    expect([400, 403]).toContain(res.status);
    expect(access.approve).not.toHaveBeenCalled();
  });

  it.each([
    ['without the page cookie', (cookie: string) => ({ ...SAME_PAGE, cookie: cookie + 'x' })],
    [
      'from another site',
      (cookie: string) => ({ cookie, 'sec-fetch-site': 'cross-site', origin: ORIGIN }),
    ],
    ['with no Sec-Fetch-Site', (cookie: string) => ({ cookie, origin: ORIGIN })],
    ['with no Origin', (cookie: string) => ({ cookie, 'sec-fetch-site': 'same-origin' })],
    ['from an agent', (cookie: string) => ({ ...SAME_PAGE, cookie, 'x-dorkos-agent': 'agent-a' })],
    ['from a program', (cookie: string) => ({ ...SAME_PAGE, cookie, authorization: 'Bearer k' })],
  ])('refuses a decision %s, and gives no grant', async (_case, headersFor) => {
    const { token, cookie } = await openPage();
    const res = await decide(
      { token, decision: 'approve', connectionId: 'linear-work' },
      headersFor(cookie)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(access.approve).not.toHaveBeenCalled();
  });

  it('refuses a decision once the mini app changed since the page opened', async () => {
    const { token, cookie } = await openPage();
    access.approve.mockImplementation(() => {
      throw new ExtensionConnectionError(
        'EXTENSION_CONNECTION_NOT_ALLOWED',
        'This mini app changed since the page opened. Open it again.'
      );
    });
    const res = await decide(
      { token, decision: 'approve', connectionId: 'linear-work' },
      { ...SAME_PAGE, cookie }
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed since the page opened/u);
  });

  it('Not now changes nothing', async () => {
    const { token, cookie } = await openPage();
    const res = await decide({ token, decision: 'deny' }, { ...SAME_PAGE, cookie });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('denied');
    expect(access.approve).not.toHaveBeenCalled();
  });
});
