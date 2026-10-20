/**
 * @vitest-environment node
 *
 * The sign-up hook must see the request a sign-up came from, through the real
 * `/api/auth/*` mount. The only answer that differs by caller in F0 is the
 * session relay's (`closed`), so a relay-marked sign-up is the proof: refused
 * when the mount carries the request's class to the hook, allowed if the hook
 * ever fell back to `in-process`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { honoListener, swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';

const role = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
// The setup code is written beside the test's own data, never a real one.
const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../../lib/dork-home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/dork-home.js')>()),
  resolveDorkHome: () => home.dir,
}));

const { createAuth } = await import('../index.js');
const { initConfigManager } = await import('../../config-manager.js');
const { mountBetterAuth } = await import('../../../../http/better-auth.js');
const { markIngress } = await import('../../remote/ingress-mark.js');
const { withRegistrationCaller } = await import('../registration-policy.js');
const { resetSetupCodeForTests } = await import('../setup-code.js');
const { env } = await import('../../../../env.js');
type ApiEnv = import('../../../../http/api-chain.js').ApiEnv;
type IngressKind = import('../../remote/ingress-mark.js').IngressKind;

const target = swappableServer();
const DOMAIN = 'dork.test';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** The marked listener the next request should appear to arrive through. */
let viaIngress: IngressKind | null = null;

describe('the sign-up hook, through the /api/auth mount', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-registration-'));
    home.dir = tmpDir;
    initConfigManager(tmpDir);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  beforeEach(() => {
    // A fresh, owner-less database per case, so each case is the first sign-up.
    db = createDb(path.join(tmpDir, `auth-${Math.random().toString(36).slice(2)}.db`));
    runMigrations(db);
    const app = new Hono<ApiEnv>();
    app.use(async (c, next) => {
      if (viaIngress) markIngress(c.env.incoming, viaIngress);
      await next();
    });
    mountBetterAuth(app, { auth: createAuth(db, tmpDir) });
    target.mount(honoListener(app));
    viaIngress = null;
    role.value = 'computer';
    resetSetupCodeForTests();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function signUp(local: string) {
    return request(target.server)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({
        email: `${local}@${DOMAIN}`,
        password: 'correct-horse-battery-staple',
        name: 'Owner',
      });
  }

  // Purpose: today's behavior holds for this computer: the first sign-up
  // creates the owner.
  it('lets this computer create the owner', async () => {
    const res = await signUp('local');
    expect(res.status).toBe(200);
    expect(db.select().from(user).get()?.role).toBe('owner');
  });

  // Purpose: an owner-less sign-up from another device needs the setup code
  // this computer prints (F5, DOR-2968), and creates nothing without it.
  it('refuses another device without the setup code, and creates no account', async () => {
    viaIngress = 'own-tunnel';
    const res = await signUp('tunnel');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SETUP_CODE_REQUIRED');
    expect(db.select().from(user).all()).toHaveLength(0);
  });

  it('lets another device create the owner with the printed setup code', async () => {
    viaIngress = 'own-tunnel';
    await signUp('tunnel');
    const code = fs.readFileSync(path.join(tmpDir, 'setup-code'), 'utf8').trim();

    const res = await signUp('tunnel').set('X-DorkOS-Setup-Code', code);
    expect(res.status).toBe(200);
    expect(db.select().from(user).all()).toHaveLength(1);
  });

  it('refuses a wrong setup code', async () => {
    viaIngress = 'own-tunnel';
    const res = await signUp('tunnel').set('X-DorkOS-Setup-Code', '00000-00000');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SETUP_CODE_INVALID');
    expect(db.select().from(user).all()).toHaveLength(0);
  });

  // Purpose: the proof the hook sees the request. A relayed caller is never a
  // person, so its sign-up is closed; were the scope lost, the hook would read
  // `in-process` and allow it.
  it('refuses a sign-up from the session relay', async () => {
    viaIngress = 'relay';
    const res = await signUp('relay');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REGISTRATION_CLOSED');
    expect(db.select().from(user).all()).toHaveLength(0);
  });

  // Purpose: the role rule. On a hub the owner comes from provisioning, so
  // every sign-up request is refused, even one that looks local. (The hook
  // reads the role itself, so this proves the role rule, not the scope.)
  it('refuses every sign-up on a hub', async () => {
    role.value = 'hub';
    const res = await signUp('hub');
    expect(res.status).toBe(403);
    // Not REGISTRATION_CLOSED: the client reads that as "an owner exists",
    // and a pooled hub has no owner.
    expect(res.body.code).toBe('REGISTRATION_PROVISIONED');
    expect(db.select().from(user).all()).toHaveLength(0);
  });

  // Purpose: a direct `auth.api` call is not a network request and reads as
  // code in this process; were the scope ever defaulted to something else,
  // this would change. On a hub only provisioning may create the owner, which
  // is the seam A2 (DOR-2934) uses.
  it('treats a direct call as in-process, and lets only provisioning create a hub owner', async () => {
    const auth = createAuth(db, tmpDir);
    const body = (local: string) => ({
      body: {
        email: `${local}@${DOMAIN}`,
        password: 'correct-horse-battery-staple',
        name: 'Owner',
      },
    });

    role.value = 'hub';
    await expect(auth.api.signUpEmail(body('direct-hub'))).rejects.toThrow();
    expect(db.select().from(user).all()).toHaveLength(0);
    await withRegistrationCaller('provisioning', () => auth.api.signUpEmail(body('provisioned')));
    expect(db.select().from(user).get()?.role).toBe('owner');

    role.value = 'computer';
    const fresh = createDb(path.join(tmpDir, `auth-direct-${Date.now()}.db`));
    runMigrations(fresh);
    await createAuth(fresh, tmpDir).api.signUpEmail(body('direct-computer'));
    expect(fresh.select().from(user).get()?.role).toBe('owner');
  });

  // Purpose: once an owner exists, registration is closed, as before.
  it('refuses a second account', async () => {
    expect((await signUp('first')).status).toBe(200);
    const res = await signUp('second');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REGISTRATION_CLOSED');
    expect(db.select().from(user).all()).toHaveLength(1);
  });
});
