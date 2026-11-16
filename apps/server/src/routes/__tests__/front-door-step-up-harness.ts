/** Real owner sign-ins and step-up, shared by front-door route tests. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Hono } from 'hono';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import request, { type Test } from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ApiEnv } from '../../http/api-chain.js';
import { createApiApp } from '../../http/api-chain.js';
import { frontDoorListener } from '../../http/front-door.js';
import { mountBetterAuth } from '../../http/better-auth.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { getAuth, initAuth } from '../../services/core/auth/index.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { markIngress, type RequestIngress } from '../../services/core/remote/ingress-mark.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { env } from '../../env.js';
import { createStepUpRoutes } from '../step-up.js';
import { createPersonSessionRoutes } from '../person-session.js';

const PASSWORD = 'made-up-correct-horse-battery';
const EMAIL = 'owner@northwind.example.test';
const HOST = `localhost:${env.DORKOS_PORT}`;
const ORIGIN = `http://${HOST}`;
const INGRESS = 'x-test-front-door-ingress';

/** The public test helpers, without exposing the database factory's inferred schema type. */
export interface FrontDoorStepUpHarness {
  call(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    url: string,
    ingress?: RequestIngress,
    otherSession?: boolean
  ): Test;
  confirm(heldId: string, ingress?: RequestIngress, otherSession?: boolean): Test;
  auth: typeof getAuth;
  db(): Db;
  signIn(ingress?: RequestIngress): Test;
  currentCookie(ingress?: RequestIngress): string;
  renew(ingress: RequestIngress, otherSession?: boolean): Promise<void>;
}

/** A real owner cookie on each route, with a second sign-in for hold ownership tests. */
export function frontDoorStepUpHarness(
  groups: () => { path: string; routes: Hono<ApiEnv> }[],
  options: { headers?: () => Record<string, string> } = {}
): FrontDoorStepUpHarness {
  const target = swappableServer();
  const cookies = new Map<string, string>();
  let home: string;
  let db: Db;

  function call(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    url: string,
    ingress: RequestIngress = 'direct',
    otherSession = false
  ) {
    const cookie = cookies.get(`${ingress}${otherSession ? '-other' : ''}`);
    const req = request(target.server)[method](url).set('Host', HOST).set('Origin', ORIGIN);
    if (options.headers) req.set(options.headers());
    if (cookie) req.set('Cookie', cookie);
    if (ingress !== 'direct') req.set(INGRESS, ingress);
    return req;
  }

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'front-door-step-up-'));
    initConfigManager(home);
    configManager.set('auth', { enabled: true });
    db = createDb(path.join(home, 'auth.db'));
    runMigrations(db);
    initAuth(db, home);
    const app = createApiApp({
      admission: new MainRequestAdmission(),
      beforeBodyParsing: (early) => mountBetterAuth(early, { auth: getAuth()!, maxAttempts: 1000 }),
    });
    for (const group of groups()) app.route(group.path, group.routes);
    app.route('/api/step-up', createStepUpRoutes());
    app.route('/api/person-session', createPersonSessionRoutes());
    const chain = frontDoorListener(app);
    const listener: RequestListener = (req, res) => {
      const via = req.headers[INGRESS];
      if (via === 'own-tunnel' || via === 'managed' || via === 'wifi') markIngress(req, via);
      chain(req, res);
    };
    target.mount(listener);
    const created = await call('post', '/api/auth/sign-up/email').send({
      email: EMAIL,
      password: PASSWORD,
      name: 'Northwind owner',
    });
    expect(created.status).toBe(200);
    for (const ingress of ['direct', 'own-tunnel', 'managed', 'wifi'] as const) {
      for (const suffix of ['', '-other']) {
        const signedIn = await call('post', '/api/auth/sign-in/email', ingress).send({
          email: EMAIL,
          password: PASSWORD,
        });
        expect(signedIn.status).toBe(200);
        cookies.set(
          `${ingress}${suffix}`,
          (signedIn.headers['set-cookie'] as unknown as string[])
            .map((value) => value.split(';')[0])
            .join('; ')
        );
      }
    }
  }, 60_000);

  afterAll(() => {
    resetHeldStepUpsForTests();
    db?.$client.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  return {
    call,
    confirm: (heldId: string, ingress: RequestIngress = 'direct', otherSession = false) =>
      call('post', `/api/step-up/${heldId}/password`, ingress, otherSession).send({
        password: PASSWORD,
      }),
    auth: getAuth,
    db: () => db,
    signIn: (ingress: RequestIngress = 'direct') =>
      call('post', '/api/auth/sign-in/email', ingress).send({ email: EMAIL, password: PASSWORD }),
    currentCookie: (ingress: RequestIngress = 'direct') => cookies.get(ingress)!,
    renew: async (ingress: RequestIngress, otherSession = false) => {
      const signedIn = await call('post', '/api/auth/sign-in/email', ingress).send({
        email: EMAIL,
        password: PASSWORD,
      });
      expect(signedIn.status).toBe(200);
      cookies.set(
        `${ingress}${otherSession ? '-other' : ''}`,
        (signedIn.headers['set-cookie'] as unknown as string[])
          .map((value) => value.split(';')[0])
          .join('; ')
      );
    },
  };
}
