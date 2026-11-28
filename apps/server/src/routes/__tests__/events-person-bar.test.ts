/**
 * `GET /api/events` is a person's stream (DOR-4986, Security's ruling): the
 * SSE route and the socket both run the person bar (`assessPerson`, through
 * `admitEventsReader`) and answer every case alike, with the bar's own status,
 * code and sentence.
 *
 * Both doors are driven here with no chain in front, as the parity suite for
 * the bar does (`person-bar-parity.test.ts`): the identity a chain or an
 * upgrade's gate would have resolved is handed in, so the bar is what answers.
 * The real chain's refusals are pinned in `events-groups.contract.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import type { ApiEnv } from '../../http/api-chain.js';
import type { RequestFacts } from '../../http/request-facts.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { UpgradeAttempt } from '../../services/core/streams/upgrade-router.js';
import eventsRoutes from '../events.js';
import { globalEventsRoute } from '../events-socket.js';

let home: string;
let user: RequestUser | undefined;

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-events-person-bar-')));
  initConfigManager(home);
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  vi.restoreAllMocks();
  configManager.set('auth', { enabled: false });
  user = undefined;
});

/** One answer, from either door. */
interface Answer {
  status: number;
  detail?: string;
}

/** The SSE route, as the app's listener hands a request from this computer over. */
async function overSse(headers: Record<string, string>): Promise<Answer> {
  const router = new Hono<ApiEnv>();
  router.use(async (c, next) => {
    if (user) c.set('user', user);
    await next();
  });
  router.route('/api/events', eventsRoutes);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const res = await router.request(
    '/api/events',
    { headers },
    {
      incoming: {
        headers: { host: 'localhost', ...lower },
        socket: { remoteAddress: '127.0.0.1' },
        method: 'GET',
      },
    }
  );
  if (res.status !== 403) return { status: res.status };
  const body = (await res.json()) as { code: string; detail: string };
  expect(body.code).toBe('person_only');
  return { status: res.status, detail: body.detail };
}

/** The socket, as the upgrade router hands it the facts its gate resolved. */
async function overSocket(headers: Record<string, string>): Promise<Answer> {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const facts: RequestFacts = {
    headers: { host: 'localhost', ...lower },
    peerAddress: '127.0.0.1',
    forwardedAddress: '127.0.0.1',
    connectionEncrypted: false,
    method: 'GET',
    ingress: 'direct',
    user,
    agentIdentity: undefined,
  };
  const decision = await globalEventsRoute.authorize({
    url: new URL('http://localhost/api/events'),
    headers: facts.headers,
    locals: user ? { user } : {},
    facts,
  } as UpgradeAttempt);
  if (decision.ok) return { status: 200 };
  expect(decision.deliver).toBe('close-frame');
  return { status: decision.status, detail: decision.message };
}

const SIGN_IN = 'Only a person signed in to DorkOS can change what the app shows live.';
const AGENT = 'Only a person can open the app’s live updates. Agents use their own tools.';
const CROSS_SITE = 'Open this from the DorkOS app.';

describe('who GET /api/events refuses, alike on SSE and the socket', () => {
  it.each([
    ['an agent identity', false, undefined, { 'X-DorkOS-Agent': 'agent-token' }, AGENT],
    ['an approval token', false, undefined, { 'X-DorkOS-Approval': 'approval-token' }, AGENT],
    [
      'an agent identity on the owner’s cookie, login on',
      true,
      { userId: 'owner', credential: 'cookie' },
      { 'X-DorkOS-Agent': 'agent-token' },
      AGENT,
    ],
    ['a page on another site', false, undefined, { Origin: 'https://evil.example' }, CROSS_SITE],
    ['a mini app frame', false, undefined, { Origin: 'null' }, CROSS_SITE],
    [
      'a key-only caller with login on',
      true,
      { userId: 'owner', credential: 'api-key' },
      { Authorization: 'Bearer made-up-key' },
      SIGN_IN,
    ],
  ] as const)('%s', async (_name, login, who, headers, detail) => {
    configManager.set('auth', { enabled: login });
    user = who as RequestUser | undefined;
    const addClient = vi.spyOn(eventFanOut, 'addClient');
    expect(await overSse(headers)).toEqual({ status: 403, detail });
    expect(await overSocket(headers)).toEqual({ status: 403, detail });
    expect(addClient).not.toHaveBeenCalled();
  });
});

describe('who it lets through, on both', () => {
  it.each([
    ['the app, login off', false, undefined, {}],
    ['a key-only caller, login off', false, { userId: 'owner', credential: 'api-key' }, {}],
    ['the owner with the cookie, login on', true, { userId: 'owner', credential: 'cookie' }, {}],
  ] as const)('%s', async (_name, login, who, headers) => {
    configManager.set('auth', { enabled: login });
    user = who as RequestUser | undefined;
    // Admitted means registered: stop there, before a stream is held open.
    vi.spyOn(eventFanOut, 'addClient').mockReturnValue(() => {});
    expect(await overSocket(headers)).toEqual({ status: 200 });
    // The SSE route answers its 200 only once streaming; the bar has passed by then.
    expect((await overSse(headers)).status).not.toBe(403);
  });
});
