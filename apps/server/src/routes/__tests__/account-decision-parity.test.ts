/**
 * One account-decision bar, three doors (DOR-4978, Security's parity row): a
 * hand route that keeps `resolveConnectorOperator`, a capability's REST path
 * and `POST /api/capabilities/{id}/invoke` answer every refusal with the same
 * status, code and sentence, because each runs `lib/http/account-decision-bar.ts`.
 * The mount runs it before the handler, and the connector store's 503 first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { noopLogger } from '@dorkos/shared/logger';
import { createDb, runMigrations } from '@dorkos/db';
import { PERSON_APP_HEADER, PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';

import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { getStaticLocalOrigins } from '../../lib/trusted-origins.js';
import type { AccountDecisionPolicy } from '../../lib/http/account-decision-bar.js';
import { initAuth } from '../../services/core/auth/index.js';
import { personSessionRequired } from '../../services/core/auth/gate-policy.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { composeRegistry } from '../../services/core/capabilities/index.js';
import { connectionOwnerDomain } from '../../services/connectors/resources/owner-capabilities.js';
import { createCapabilityHttpRoutes } from '../capability-http.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';
import {
  createConnectorResourcesRoutes,
  type ConnectorResourcesRouterDeps,
} from '../connector-resources.js';
import { connectorStoreUnavailable, migrationHealthGate } from '../connector-owner-boundary.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const target = swappableServer();
/** This server's own loopback origin: the chain lets it through, the bar's injected list does not. */
const CORS_ONLY_ORIGIN = getStaticLocalOrigins().find((o) => o.startsWith('http://127.0.0.1'))!;
let home: string;
let ownerId: string;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-account-decision-'));
  // Login off, with an owner: the person at this computer missing only their session.
  initConfigManager(home);
  const db = createDb(path.join(home, 'auth.db'));
  runMigrations(db);
  const auth = initAuth(db, home);
  const signUp = await auth.api.signUpEmail({
    body: { email: 'owner' + '@' + 'northwind.test', password: 'a-long-password-1', name: 'Owner' },
    asResponse: true,
  });
  expect(signUp.status).toBe(200);
  ownerId = ((await signUp.json()) as { user: { id: string } }).user.id;
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const lifecycle = {
  rename: vi.fn(() => ({ connectionId: 'connection-a', lifecycle: 'connected' })),
  remove: vi.fn(),
  pause: vi.fn(async () => ({ connectionId: 'connection-a', lifecycle: 'paused' })),
  resume: vi.fn(),
  disconnect: vi.fn(),
};
let migration: 'ok' | 'migration_failed' = 'ok';
const store = { migrationHealth: () => ({ status: migration }) } as never;
let user: RequestUser | undefined;

/** The hand group, the mount and `/invoke`, over one policy, in the app's order. */
function app(policy: Partial<AccountDecisionPolicy> = {}) {
  const deps = {
    resolveOwner: () => OWNER,
    loginEnabled: () => false,
    query: {},
    logos: { get: vi.fn() },
    authentication: {},
    lifecycle,
    actions: {},
    signIns: {},
    sessionAccess: {},
    ...policy,
  } as unknown as ConnectorResourcesRouterDeps & AccountDecisionPolicy;
  const registry = composeRegistry([connectionOwnerDomain], {
    logger: noopLogger,
    connectionOwnerDeps: { query: { disconnectImpact: vi.fn() }, lifecycle } as never,
  });
  const ports = {
    accountDecision: deps,
    prechecks: { 'connector-store': () => connectorStoreUnavailable(store) },
  };
  const gate = new Hono<ApiEnv>().use(migrationHealthGate(store));
  return target.mount(
    honoGroupListener(
      [
        {
          path: '/',
          routes: createCapabilityHttpRoutes({
            registry: () => registry,
            capabilities: connectionOwnerDomain.capabilities,
            ports,
          }),
        },
        { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry, ports) },
        { path: '/api/connectors', routes: gate },
        { path: '/api/connectors', routes: createConnectorResourcesRoutes(deps) },
      ],
      {
        before: async (c, next) => {
          if (user) c.set('user', user);
          await next();
        },
      }
    )
  );
}

/** One write through each door: a hand route, a REST path, `/invoke`. */
const DOORS = [
  ['the hand route', 'post', '/api/connectors/connections/connection-a/pause', {}],
  ['the REST path', 'patch', '/api/connectors/connections/connection-a', { label: 'Work' }],
  [
    '/invoke',
    'post',
    '/api/capabilities/connectors.rename_connection/invoke',
    { connectionId: 'connection-a', label: 'Work' },
  ],
] as const;

/** Every door's answer: status, code and sentence. */
async function answers(
  server: ReturnType<typeof app>,
  headers: Record<string, string> = {}
): Promise<{ status: number; code: unknown; detail: unknown }[]> {
  const out = [];
  for (const [, method, url, body] of DOORS) {
    const res = await request(server)[method](url).set(headers).send(body);
    out.push({ status: res.status, code: res.body.code, detail: res.body.detail });
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  migration = 'ok';
  user = undefined;
});

describe('every refusal is the same on every door', () => {
  it.each([
    [
      'a page on a foreign origin',
      { trustedOrigins: () => [] },
      { Origin: CORS_ONLY_ORIGIN },
      403,
      'origin_not_allowed',
      'Open this account action from the DorkOS app.',
    ],
    [
      'an agent',
      {},
      { 'X-DorkOS-Agent': 'agent-a' },
      403,
      'person_only',
      'Programs and agents can’t make account decisions.',
    ],
    [
      'an approval token',
      {},
      { 'X-DorkOS-Approval': 'token-a' },
      403,
      'person_only',
      'Programs and agents can’t make account decisions.',
    ],
    [
      'any Authorization header',
      {},
      { Authorization: 'Bearer machine' },
      403,
      'person_only',
      'Programs and agents can’t make account decisions.',
    ],
    [
      'login on, with no session',
      { loginEnabled: () => true },
      {},
      403,
      'person_only',
      'Sign in to the DorkOS app to make this decision.',
    ],
    [
      'an owner nobody can work out',
      { resolveOwner: () => undefined },
      {},
      401,
      'unauthenticated',
      'DorkOS couldn’t confirm who owns this account.',
    ],
  ] as const)('%s', async (_name, policy, headers, status, code, detail) => {
    const got = await answers(app(policy), headers);
    expect(got).toEqual(DOORS.map(() => ({ status, code, detail })));
    expect(lifecycle.rename).not.toHaveBeenCalled();
    expect(lifecycle.pause).not.toHaveBeenCalled();
  });

  it('a signed-in account that does not own this install', async () => {
    user = { userId: 'member', credential: 'cookie' } as RequestUser;
    const server = app({
      loginEnabled: () => true,
      isAccountOwner: (who) => who?.userId === 'owner',
    });
    const detail =
      'Only the owner of this DorkOS can manage the connections on its DorkOS account.';
    expect(await answers(server)).toEqual(
      DOORS.map(() => ({ status: 403, code: 'owner_only', detail }))
    );
    expect(lifecycle.rename).not.toHaveBeenCalled();
  });

  it('asks the person at this computer for the step-up on every door', async () => {
    // The real policy: with an owner and login off, a change needs the person's session.
    const server = app({ loginEnabled: personSessionRequired });
    const got = await answers(server, { [PERSON_APP_HEADER]: '1' });
    expect(got.map((answer) => [answer.status, answer.code])).toEqual(
      DOORS.map(() => [401, PERSON_SESSION_REQUIRED_CODE])
    );
    expect(lifecycle.rename).not.toHaveBeenCalled();
  });

  it('answers the connector store’s 503 first, before the bar', async () => {
    migration = 'migration_failed';
    const got = await answers(app(), { 'X-DorkOS-Agent': 'agent-a' });
    const detail = 'Connected apps didn’t start. Restart DorkOS, then try again.';
    expect(got).toEqual(
      DOORS.map(() => ({ status: 503, code: 'temporarily_unavailable', detail }))
    );
  });

  it('lets the owner through to the handler with the server’s owner', async () => {
    user = { userId: ownerId, credential: 'cookie' } as RequestUser;
    const got = await answers(app({ loginEnabled: personSessionRequired }));
    expect(got.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(lifecycle.rename).toHaveBeenCalledTimes(2);
    expect(lifecycle.rename).toHaveBeenCalledWith(OWNER, 'connection-a', 'Work');
  });
});
