/**
 * The self-grant chain, reproduced as a test rather than described
 * (spec `agent-approval-settings` §3.0, Testing Strategy).
 *
 * This is the most important test in the feature, because the hole it covers was
 * found by RUNNING it, not by reading. The four steps, all on the default
 * `local-trust` posture, were:
 *
 * 1. `PATCH /api/config {"approvals":{"standingGrants":true}}` with the agent
 *    header omitted. `trustedCaller` is satisfied, so the operator-only check is
 *    skipped and the value is written.
 * 2. Invoke the destructive capability WITH an identity, so the approval records
 *    the caller's own agent path. The caller gets back an approval id.
 * 3. `POST /api/approvals/:id/grant {"standing":true}` with both headers
 *    stripped. Authority is `resolveDecisionAuthority` and the approval is
 *    identified by URL id, never by token, so dropping the token costs nothing.
 * 4. Every later identified call matches the permission and is auto-approved,
 *    silently, for the whole window.
 *
 * Each step is asserted refused here. The negative cases are what make this test
 * worth anything: a test that only asserted "a cookie works" would have passed
 * against the broken design, and so would one that only checked the UI.
 *
 * Nothing here goes through the client. The refusals are read straight off the
 * HTTP surface, because a guard that only exists in the cockpit is not a guard.
 *
 * Today the chain is closed twice over: the cookie bar refuses the callers above,
 * and `standing: true` is refused for EVERY caller while nothing enforces a
 * standing permission. The cases below assert the bar specifically, by the code it
 * answers with, so they keep testing the bar rather than the temporary refusal
 * once that refusal is replaced by the gate lookup.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import { getAuth, initAuth, sessionGate, toNodeHandler } from '../../services/core/auth/index.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import {
  ApprovalGrantService,
  ApprovalService,
  initStandingGrantPosture,
  resetStandingGrantPosture,
} from '../../services/core/approvals/index.js';
import {
  CapabilityGateRefusal,
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { createApprovalsRouter } from '../approvals.js';
import { env } from '../../env.js';

// Emails are assembled from parts so the source never contains a literal address.
const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** The agent doing the asking, and the path a permission would be keyed on. */
const AGENT_PATH = '/Users/dev/agents/prober';

/** The one destructive capability the chain reaches for. */
const UNINSTALL = defineCapability({
  id: 'demo.uninstall',
  title: 'Uninstall a package',
  description: 'A destructive capability standing in for marketplace.uninstall.',
  tier: 'destructive',
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_uninstall', servers: ['external'] } },
  invoke: async () => ({ ok: true }),
});

const INPUT = { name: 'sentry-monitor' };

describe('the self-grant chain, against the real routers', () => {
  let tmpDir: string;
  let db: Db;
  let app: express.Express;
  let approvals: ApprovalService;
  let grants: ApprovalGrantService;
  let registry: CapabilityRegistry;
  let cookies: string[];
  let apiKey: string;

  /** Flip the runtime login flag the gate and the guards read per request. */
  function setLoginEnabled(enabled: boolean): void {
    configManager.set('auth', { enabled });
  }

  /** Flip the master switch directly, bypassing the route that guards it. */
  function setStandingGrants(enabled: boolean): void {
    configManager.set('approvals', { standingGrants: enabled, trustWindowMinutes: 480 });
  }

  /** The identity the agent presents when it plays by the rules. */
  const IDENTITY = {
    agentPath: AGENT_PATH,
    displayName: 'Prober',
    tierCeiling: 'destructive' as const,
    createdAt: new Date().toISOString(),
  };

  /**
   * Step 2 of the chain: invoke the destructive capability WITH an identity, so
   * the approval records the caller's own agent path.
   *
   * Goes through `registry.invoke`, the same door every surface uses, which is
   * what proves the gate itself records the path rather than a test asserting it
   * into existence.
   *
   * @returns The approval id the refusal handed back.
   */
  async function askAsAgent(): Promise<string> {
    try {
      await registry.invoke(UNINSTALL.id, INPUT, { identity: IDENTITY });
    } catch (err) {
      if (err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required') {
        return err.decision.payload.approvalId;
      }
      throw err;
    }
    throw new Error('the destructive capability was not gated');
  }

  /** Whether the gate still stops the next identified call. */
  async function stillAsks(): Promise<boolean> {
    try {
      await registry.invoke(UNINSTALL.id, INPUT, { identity: IDENTITY });
      return false;
    } catch (err) {
      return err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required';
    }
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-standing-chain-'));
    process.env.DORK_HOME = tmpDir;
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'chain-test.db'));
    runMigrations(db);
    const auth = initAuth(db, tmpDir);

    approvals = new ApprovalService(db, {
      describeCapability: (id) =>
        id === UNINSTALL.id ? { title: UNINSTALL.title, tier: UNINSTALL.tier } : undefined,
    });
    grants = new ApprovalGrantService(db);
    registry = composeRegistry([{ name: 'demo', capabilities: [UNINSTALL] }], {} as never);
    initCapabilityTierGate({ approvals });
    initStandingGrantPosture(grants);

    // Mirrors `app.ts`: Better Auth before the JSON body parser, then the gate,
    // then the real routers. No client, no middleware of this test's own.
    const configRouter = (await import('../config.js')).default;
    app = express();
    app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
    app.use(express.json());
    app.use(sessionGate);
    app.use('/api/config', configRouter);
    app.use('/api/approvals', createApprovalsRouter(approvals, { grants }));

    const signUp = await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Owner' });
    expect(signUp.status).toBe(200);
    const signIn = await request(app)
      .post('/api/auth/sign-in/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(signIn.status).toBe(200);
    cookies = signIn.headers['set-cookie'] as unknown as string[];

    const ownerId = db.select().from(user).get()!.id;
    apiKey = (await auth.api.createApiKey({ body: { userId: ownerId, name: 'chain-key' } })).key;
  });

  beforeEach(() => {
    setLoginEnabled(false);
    setStandingGrants(false);
    grants.revokeAll();
  });

  afterAll(() => {
    resetCapabilityTierGate();
    resetStandingGrantPosture();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with login off — the default posture the chain was run on', () => {
    it('step 1: refuses the header-free config write that started it', async () => {
      const res = await request(app)
        .patch('/api/config')
        .send({ approvals: { standingGrants: true } });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('standing_grants_require_login');
      expect(configManager.getDot('approvals.standingGrants')).toBe(false);
    });

    it('step 3: refuses the header-free standing grant, even with the switch forced on', async () => {
      // Forced on directly in config, so this asserts the SECOND bar rather than
      // riding on step 1 having held. If only step 1 protected the chain, a
      // switch turned on any other way would reopen it.
      setStandingGrants(true);
      const approvalId = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .send({ standing: true });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('standing_grants_require_login');
      expect(grants.findLive(AGENT_PATH, UNINSTALL.id)).toBeUndefined();
    });

    it('step 4 never happens: the next identified call still asks', async () => {
      setStandingGrants(true);
      const approvalId = await askAsAgent();
      await request(app).post(`/api/approvals/${approvalId}/grant`).send({ standing: true });

      // No permission exists, so the very next call is gated exactly as before.
      expect(grants.list()).toEqual([]);
      expect(await stillAsks()).toBe(true);
    });

    it('a plain one-time grant still works, so the gate is not simply broken', async () => {
      const approvalId = await askAsAgent();
      const res = await request(app).post(`/api/approvals/${approvalId}/grant`).send({});
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('granted');
    });
  });

  describe('with login on', () => {
    it('refuses a valid per-user API key, which is not a person in the cockpit', async () => {
      // The residual `decision-authority.ts` names: a program holding a key and
      // shedding its agent header satisfies every check that came before this one.
      setLoginEnabled(true);
      setStandingGrants(true);
      const approvalId = await askAsAgent();

      const config = await request(app)
        .patch('/api/config')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ approvals: { trustWindowMinutes: 1440 } });
      expect(config.status).toBe(403);
      expect(config.body.code).toBe('operator_cookie_required');

      const grant = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ standing: true });
      expect(grant.status).toBe(403);
      expect(grant.body.code).toBe('operator_cookie_required');
      expect(grants.findLive(AGENT_PATH, UNINSTALL.id)).toBeUndefined();
    });

    it('refuses an agent that names itself, cookie or not', async () => {
      setLoginEnabled(true);
      setStandingGrants(true);
      const approvalId = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('Cookie', cookies)
        .set(AGENT_IDENTITY_HEADER, 'some-agent-token')
        .send({ standing: true });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      expect(grants.findLive(AGENT_PATH, UNINSTALL.id)).toBeUndefined();
    });

    it('lets the signed-in person past the bar, and no further yet', async () => {
      // The positive half, which is what keeps the guard from being a deny-all
      // that nobody would notice was broken. The person clears both bars; the
      // request then stops on the honest refusal that stands in for the
      // enforcement nobody has built.
      setLoginEnabled(true);

      const config = await request(app)
        .patch('/api/config')
        .set('Cookie', cookies)
        .send({ approvals: { standingGrants: true, trustWindowMinutes: 480 } });
      expect(config.status).toBe(200);
      expect(configManager.getDot('approvals.standingGrants')).toBe(true);

      const approvalId = await askAsAgent();
      const grant = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('Cookie', cookies)
        .send({ standing: true });

      expect(grant.status).toBe(409);
      expect(grant.body.code).toBe('STANDING_GRANTS_NOT_YET_ENFORCED');
      expect(grants.findLive(AGENT_PATH, UNINSTALL.id)).toBeUndefined();
    });

    it('ends every live permission when login is turned off', async () => {
      // The permission is seeded through the store directly, because no route
      // creates one yet. What is under test is the posture seam reached through
      // the REAL config route, not how the row got there.
      setLoginEnabled(true);
      grants.create({
        agentPath: AGENT_PATH,
        capabilityId: UNINSTALL.id,
        windowMinutes: 480,
        grantedBy: 'user_owner',
        posture: 'signed-in-operator',
      });
      expect(grants.list()).toHaveLength(1);

      const off = await request(app)
        .patch('/api/config')
        .set('Cookie', cookies)
        .send({ auth: { enabled: false } });
      expect(off.status).toBe(200);

      // Not dormant. A permission that survived would wake up under a posture
      // that can no longer justify it.
      expect(grants.list()).toEqual([]);
    });
  });
});
