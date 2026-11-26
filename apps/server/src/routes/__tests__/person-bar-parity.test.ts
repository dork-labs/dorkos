/**
 * One person bar, three doors (DOR-4978, Security's parity rows): a hand route
 * that keeps `refusedNotAPerson` (the wrapper every such route runs, and for
 * every refusal also the real `POST /api/extensions/:id/approve`), a
 * capability's REST path behind `http.callerBar: 'person'`
 * (`POST /api/extensions/:id/dismiss-approval`) and
 * `POST /api/capabilities/{id}/invoke` answer every case with the same status,
 * code and sentence, because each runs `assessPerson` (`lib/http/person-bar.ts`)
 * with the same copy (`APPROVAL_BAR`). The mount runs it before the handler and before the
 * input is read; a caller it lets through is never given a person's authority,
 * and a program with a key is recorded as a program.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { noopLogger } from '@dorkos/shared/logger';
import { PROGRAM_ACTOR_LABEL } from '@dorkos/shared/activity-schemas';

import type { ApiEnv } from '../../http/api-chain.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { composeRegistry } from '../../services/core/capabilities/index.js';
import { extensionPersonDomain } from '../../services/extensions/http-capabilities/extension-person-capabilities.js';
import type { ExtensionManager } from '../../services/extensions/extension-manager.js';
import { createCapabilityHttpRoutes } from '../capability-http.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';
import { createExtensionsRoutes } from '../extensions.js';
import { refusedNotAPerson } from '../extensions-person-bar.js';
import { APPROVAL_BAR } from '../../services/extensions/http-capabilities/extension-door-words.js';

let home: string;

beforeAll(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-person-bar-parity-')));
  initConfigManager(home);
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

/** The installed copy `remove` deletes, under this home's `extensions/`. */
const folder = () => path.join(home, 'extensions', 'my-ext');
const manager = {
  get dorkHome() {
    return home;
  },
  get: vi.fn(() => ({
    id: 'my-ext',
    origin: 'user',
    path: folder(),
    manifest: { id: 'my-ext', name: 'My Extension', version: '1.0.0' },
  })),
  dismissApproval: vi.fn(() => ({ ok: true })),
  forgetRunApproval: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
};
const activity = { emit: vi.fn(async () => undefined) };
let user: RequestUser | undefined;

/**
 * The hand group, the mount and `/invoke`, in the app's order, with no chain in
 * front: the bar is what answers, as it does behind the real chain for a
 * request the chain lets through.
 */
function app(): Hono<ApiEnv> {
  const registry = composeRegistry([extensionPersonDomain], {
    logger: noopLogger,
    extensionPersonDeps: {
      manager: manager as unknown as ExtensionManager,
      broadcastReloaded: () => undefined,
      activity,
    },
  });
  const router = new Hono<ApiEnv>();
  router.use(async (c, next) => {
    if (user) c.set('user', user);
    // The chain's body reader, which `readJsonBody` reads from.
    c.set('body', await c.req.json().catch(() => undefined));
    await next();
  });
  router.route(
    '/',
    createCapabilityHttpRoutes({
      registry: () => registry,
      capabilities: extensionPersonDomain.capabilities,
    })
  );
  router.route('/api/capabilities', createCapabilitiesInvokeRoutes(registry));
  // A hand route as each one runs the bar: the wrapper, then its own work.
  router.post('/hand/:id/dismiss-approval', (c) => {
    const refused = refusedNotAPerson(c, APPROVAL_BAR);
    return refused ?? c.json({ ok: true });
  });
  router.route(
    '/api/extensions',
    createExtensionsRoutes({
      manager: manager as unknown as ExtensionManager,
      dorkHome: home,
      getCwd: () => null,
    })
  );
  return router;
}

/** One POST, as the app's listener hands it over (from this computer). */
async function post(
  router: Hono<ApiEnv>,
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const res = await router.request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    {
      incoming: {
        headers: { host: 'localhost', 'content-type': 'application/json', ...lower },
        socket: { remoteAddress: '127.0.0.1' },
        method: 'POST',
      },
    }
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** One write through each door: a hand route, a REST path, `/invoke`. */
const SHOWN = { path: '/x/my-ext', version: '1.0.0' };
const DOORS = [
  ['a hand route', '/hand/my-ext/dismiss-approval', SHOWN],
  ['the REST path', '/api/extensions/my-ext/dismiss-approval', SHOWN],
  ['/invoke', '/api/capabilities/extensions.dismiss_approval/invoke', { id: 'my-ext', ...SHOWN }],
] as const;

/** For a refusal, the real hand route with the same copy too (it adds its own checks after). */
const REFUSAL_DOORS = [
  ['the approve hand route', '/api/extensions/my-ext/approve', {}],
  ...DOORS,
] as const;

/** Every door's answer: status, code and sentence. */
async function answers(
  headers: Record<string, string> = {},
  doors: readonly (readonly [string, string, object])[] = DOORS
): Promise<{ status: number; code: unknown; detail: unknown }[]> {
  const server = app();
  const out = [];
  for (const [, url, body] of doors) {
    const res = await post(server, url, body, headers);
    out.push({ status: res.status, code: res.body.code, detail: res.body.detail });
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  configManager.set('auth', { enabled: false });
  user = undefined;
});

const SIGN_IN = 'Only a person signed in to DorkOS can change which extensions may run.';
const AGENT = 'Nothing changed. Only a person allows an extension to run, in Settings.';

describe('every refusal is the same on every door', () => {
  it.each([
    [
      'a page on a foreign origin',
      false,
      undefined,
      { Origin: 'https://evil.example' },
      'Open this from the DorkOS app.',
    ],
    ['login on, without the cookie', true, undefined, {}, SIGN_IN],
    [
      'a key-only caller with login on',
      true,
      { userId: 'owner', credential: 'api-key' },
      { Authorization: 'Bearer made-up-key' },
      SIGN_IN,
    ],
    ['an agent identity', false, undefined, { 'X-DorkOS-Agent': 'agent-token' }, AGENT],
    ['an approval token', false, undefined, { 'X-DorkOS-Approval': 'approval-token' }, AGENT],
  ] as const)('%s', async (_name, login, who, headers, detail) => {
    configManager.set('auth', { enabled: login });
    user = who as RequestUser | undefined;
    expect(await answers(headers, REFUSAL_DOORS)).toEqual(
      REFUSAL_DOORS.map(() => ({ status: 403, code: 'person_only', detail }))
    );
    expect(manager.dismissApproval).not.toHaveBeenCalled();
  });

  it('runs before the input is read: a bad id from another site is refused, not parsed', async () => {
    const server = app();
    for (const url of [
      '/api/extensions/Bad_ID/dismiss-approval',
      '/api/capabilities/extensions.dismiss_approval/invoke',
    ]) {
      const res = await post(server, url, { id: 'Bad_ID' }, { Origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(res.body.detail).toBe('Open this from the DorkOS app.');
    }
  });
});

describe('who it lets through, on every door', () => {
  it.each([
    ['no Origin, login off', false, undefined, {}],
    ['a key-only caller, login off', false, undefined, { Authorization: 'Bearer made-up-key' }],
    ['the owner with the cookie, login on', true, { userId: 'owner', credential: 'cookie' }, {}],
  ] as const)('%s', async (_name, login, who, headers) => {
    configManager.set('auth', { enabled: login });
    user = who as RequestUser | undefined;
    const got = await answers(headers);
    // `/invoke` answers 200; the REST path its declared 204.
    expect(got.map((answer) => answer.status)).toEqual([200, 204, 200]);
    expect(manager.dismissApproval).toHaveBeenCalledTimes(2);
  });

  it('records a key-only caller as a program, and the person as the hand route does', async () => {
    const server = app();
    // `remove` records who acted; each call removes a fresh copy.
    fs.mkdirSync(folder(), { recursive: true });
    await post(
      server,
      '/api/extensions/my-ext/remove',
      {},
      { Authorization: 'Bearer made-up-key' }
    );
    fs.mkdirSync(folder(), { recursive: true });
    await post(server, '/api/extensions/my-ext/remove', {});
    const actors = activity.emit.mock.calls.map((call) => {
      const event = (call as unknown as [{ actorType: string; actorLabel: string }])[0];
      return [event.actorType, event.actorLabel];
    });
    expect(actors).toEqual([
      ['system', PROGRAM_ACTOR_LABEL],
      ['user', 'You'],
    ]);
  });

  it('shows the doors to agents as closed: person-only in the catalog', () => {
    const registry = composeRegistry([extensionPersonDomain], {
      logger: noopLogger,
      extensionPersonDeps: {} as never,
    });
    for (const entry of registry.catalog().capabilities) {
      expect(entry.surfaces.http?.audience, entry.id).toBe('person');
    }
  });
});
