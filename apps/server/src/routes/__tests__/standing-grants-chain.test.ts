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
 * The cases below assert the bar specifically, by the code it answers with, so they
 * test the bar rather than whatever else happens to refuse the same call.
 *
 * ## Now that enforcement exists, the positive half carries as much weight
 *
 * A guard that refuses everybody is not a guard, it is an outage nobody noticed. So
 * this file also drives the whole honest flow — a signed-in person opens a
 * permission, the agent stops being asked — and then proves the permission cannot
 * outlive its scope: it ends when the window closes, when somebody revokes it, when
 * the master switch goes off, and when login goes off, and it never covers a
 * capability nobody granted.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  readStandingGrantSettings,
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

/**
 * A SECOND destructive capability, so "a permission for A does not cover B" is
 * asserted against a real second door rather than a made-up id the registry would
 * refuse anyway.
 */
const PURGE = defineCapability({
  id: 'demo.purge',
  title: 'Delete a package and its data',
  description: 'A second destructive capability, so a permission cannot be shown to cover both.',
  tier: 'destructive',
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_purge', servers: ['external'] } },
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
   * @param capabilityId - Which destructive door to knock on.
   * @returns BOTH halves the 202 hands back — the id a decider answers by, and the
   *   token the requester retries with. The token half is what makes the DOR-474
   *   loop reproducible end to end rather than asserted at the HTTP status.
   */
  async function askAsAgentForTicket(
    capabilityId: string = UNINSTALL.id
  ): Promise<{ approvalId: string; approvalToken: string }> {
    try {
      await registry.invoke(capabilityId, INPUT, { identity: IDENTITY });
    } catch (err) {
      if (err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required') {
        const { approvalId, approvalToken } = err.decision.payload;
        return { approvalId, approvalToken };
      }
      throw err;
    }
    throw new Error('the destructive capability was not gated');
  }

  /**
   * Step 2 of the chain, when only the approval id is needed.
   *
   * @param capabilityId - Which destructive door to knock on.
   * @returns The approval id the refusal handed back.
   */
  async function askAsAgent(capabilityId: string = UNINSTALL.id): Promise<string> {
    return (await askAsAgentForTicket(capabilityId)).approvalId;
  }

  /**
   * Retry the gated call with the token the 202 handed back — the last step of the
   * loop, and the only one that proves whether the "yes" actually landed.
   *
   * Asserting the grant's HTTP status alone would not: a route could answer 403 and
   * still have written the decision. This spends the token against the real gate.
   *
   * @param ticket - What {@link askAsAgentForTicket} returned.
   * @returns True when the destructive action ran.
   */
  async function retryWithToken(ticket: {
    approvalId: string;
    approvalToken: string;
  }): Promise<boolean> {
    try {
      await registry.invoke(UNINSTALL.id, INPUT, {
        identity: IDENTITY,
        approvalToken: ticket.approvalToken,
      });
      return true;
    } catch (err) {
      if (err instanceof CapabilityGateRefusal) return false;
      throw err;
    }
  }

  /**
   * Whether the gate still stops the next identified call.
   *
   * @param capabilityId - Which door to try. Defaults to the uninstall one.
   * @returns True when the call was parked for approval, false when it ran.
   */
  async function stillAsks(capabilityId: string = UNINSTALL.id): Promise<boolean> {
    try {
      await registry.invoke(capabilityId, INPUT, { identity: IDENTITY });
      return false;
    } catch (err) {
      return err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required';
    }
  }

  /**
   * Open a permission the honest way: the person turns the feature on, the agent
   * asks, the person answers with `standing: true`.
   *
   * @returns The permission id the route reported.
   */
  async function openPermissionAsPerson(): Promise<string> {
    setLoginEnabled(true);
    const config = await request(app)
      .patch('/api/config')
      .set('Cookie', cookies)
      .send({ approvals: { standingGrants: true, trustWindowMinutes: 480 } });
    expect(config.status).toBe(200);

    const approvalId = await askAsAgent();
    const grant = await request(app)
      .post(`/api/approvals/${approvalId}/grant`)
      .set('Cookie', cookies)
      .send({ standing: true });
    expect(grant.status).toBe(200);
    return grant.body.standingPermission.grantId as string;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-standing-chain-'));
    process.env.DORK_HOME = tmpDir;
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'chain-test.db'));
    runMigrations(db);
    const auth = initAuth(db, tmpDir);

    approvals = new ApprovalService(db, {
      describeCapability: (id) => registry?.get(id),
    });
    grants = new ApprovalGrantService(db);
    registry = composeRegistry([{ name: 'demo', capabilities: [UNINSTALL, PURGE] }], {} as never);
    // Wired exactly as boot wires it, so the lookup this file exercises is the
    // production one and not a stand-in that could disagree with it.
    initCapabilityTierGate({
      approvals,
      standingGrants: {
        enabled: () => readStandingGrantSettings().enabled,
        findLive: (agentPath, capabilityId) => grants.findLive(agentPath, capabilityId),
      },
    });
    initStandingGrantPosture(grants);

    // Mirrors `app.ts`: Better Auth before the JSON body parser, then the gate,
    // then the real routers. No client, no middleware of this test's own.
    const configRouter = (await import('../config.js')).default;
    app = express();
    app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
    app.use(express.json());
    app.use(sessionGate);
    app.use('/api/config', configRouter);
    app.use('/api/approvals', createApprovalsRouter(approvals, grants));

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

  afterEach(() => {
    vi.useRealTimers();
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
      // Also the login-off half of the DOR-474 bar. With login off nobody has a
      // cookie — not the person in the cockpit either — so a cookie bar that applied
      // here would make approvals unanswerable in the DEFAULT posture, which is a
      // worse bug than the one it was closing. This is the test that would catch it.
      const ticket = await askAsAgentForTicket();
      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send({});
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('granted');
      expect(await retryWithToken(ticket), 'the yes must actually land under local-trust').toBe(
        true
      );
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

    it('lets the signed-in person through, and the agent stops being asked', async () => {
      // The positive half, which is what keeps the guard from being a deny-all
      // nobody would notice was broken. Everything the person does here is the
      // thing the header-stripping caller above could not do.
      await openPermissionAsPerson();

      expect(configManager.getDot('approvals.standingGrants')).toBe(true);
      expect(grants.findLive(AGENT_PATH, UNINSTALL.id)).toBeDefined();
      expect(await stillAsks(), 'the whole point: the next call runs with no card').toBe(false);
    });

    it('refuses a per-user API key on a PLAIN one-time yes, the whole DOR-474 loop', async () => {
      // The loop, run end to end rather than described. Every step is something an
      // agent on this machine can do unaided: the key file under the dork home is
      // readable, and a server-spawned agent inherits the server's environment.
      //
      //   1. ask for the destructive capability WITH an identity — the 202 hands
      //      back both the approval id and the retry token;
      //   2. `POST /:id/grant` with ONLY the key: no agent header, no approval
      //      header, no `standing` flag, so every earlier bar is silent;
      //   3. retry with the token.
      //
      // No `standing: true` here, which is what separates this from the case above:
      // the standing branch had a cookie bar and this path had none, so the loop
      // needed nothing that DOR-501 closed.
      setLoginEnabled(true);
      const ticket = await askAsAgentForTicket();

      const grant = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send();

      expect(grant.status).toBe(403);
      expect(grant.body.code).toBe('operator_cookie_required');
      // The assertion that matters: the destructive action must not run. A refused
      // grant that still recorded the decision would pass the status check above.
      expect(await retryWithToken(ticket), 'the agent must not have approved itself').toBe(false);
    });

    it('refuses a per-user API key on a denial too — no, deciding is deciding', async () => {
      // Denying narrows nothing an agent may do, so this is not about safety. It is
      // about the endpoint meaning one thing: a decision under login-on comes from
      // the cockpit, whichever way it goes.
      setLoginEnabled(true);
      const approvalId = await askAsAgent();

      const denied = await request(app)
        .post(`/api/approvals/${approvalId}/deny`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send();

      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('operator_cookie_required');
    });

    it('lets the signed-in person answer a plain approval, cookie and all', async () => {
      // The positive half of the bar above. A guard that refused the cockpit too
      // would be an outage, and the whole feature would look like it worked.
      setLoginEnabled(true);
      const ticket = await askAsAgentForTicket();

      const grant = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .set('Cookie', cookies)
        .send();

      expect(grant.status).toBe(200);
      expect(grant.body.outcome).toBe('granted');
      expect(await retryWithToken(ticket), 'the person said yes, so the action runs').toBe(true);
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

  describe('a permission does not outlive its scope', () => {
    it('stops working when the window closes, with no sweep in between', async () => {
      await openPermissionAsPerson();
      expect(await stillAsks()).toBe(false);

      // 480 minutes on. Nothing runs a cleanup here on purpose: expiry is applied
      // on READ, so a stale row must be invisible the instant its window closes.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 481 * 60_000));

      expect(await stillAsks()).toBe(true);
    });

    it('stops working the moment a person ends it', async () => {
      const grantId = await openPermissionAsPerson();
      expect(await stillAsks()).toBe(false);

      const ended = await request(app)
        .delete(`/api/approvals/grants/${grantId}`)
        .set('Cookie', cookies);
      expect(ended.status).toBe(200);

      expect(await stillAsks()).toBe(true);
    });

    it('stops working when the master switch goes off', async () => {
      await openPermissionAsPerson();
      expect(await stillAsks()).toBe(false);

      const off = await request(app)
        .patch('/api/config')
        .set('Cookie', cookies)
        .send({ approvals: { standingGrants: false } });
      expect(off.status).toBe(200);

      // Twice over, and both matter: the posture seam ended the row, AND the gate
      // would refuse to read one even if a row had survived.
      expect(grants.list()).toEqual([]);
      expect(await stillAsks()).toBe(true);
    });

    it('stops working when Require login goes off', async () => {
      await openPermissionAsPerson();
      expect(await stillAsks()).toBe(false);

      const off = await request(app)
        .patch('/api/config')
        .set('Cookie', cookies)
        .send({ auth: { enabled: false } });
      expect(off.status).toBe(200);

      expect(grants.list()).toEqual([]);
      expect(await stillAsks()).toBe(true);
    });

    it('covers the one action it was granted for and nothing else', async () => {
      // No wildcard exists in the schema, and this is what that means in practice:
      // the second destructive door still asks, for the same agent, at the same
      // moment, under the same switch.
      await openPermissionAsPerson();

      expect(await stillAsks(UNINSTALL.id)).toBe(false);
      expect(await stillAsks(PURGE.id)).toBe(true);
    });

    it('never covers a caller that presents no identity', async () => {
      // A permission keys on agent path, so shedding a credential can get a caller
      // the gate and never past it. This is the mirror of the ceiling reasoning.
      await openPermissionAsPerson();

      let refused = false;
      try {
        await registry.invoke(UNINSTALL.id, INPUT);
      } catch (err) {
        refused =
          err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required';
      }
      expect(refused, 'an anonymous caller must still be asked about').toBe(true);
    });
  });
});
