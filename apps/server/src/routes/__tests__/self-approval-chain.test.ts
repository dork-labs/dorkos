/**
 * The self-approval chain an agent could run with the API key it legitimately
 * holds, reproduced end to end at the route seam (DOR-474).
 *
 * The chain, all of it against the real routers with `Require login` ON:
 *
 * 1. The agent calls a destructive capability with its identity. The gate parks it
 *    and hands back an approval id AND its retry token.
 * 2. The agent calls `POST /api/approvals/:id/grant` with
 *    `Authorization: Bearer <its API key>`, omitting `X-DorkOS-Agent` and
 *    `X-DorkOS-Approval`. `sessionGate` resolves a real user from the key, so
 *    `resolveDecisionAuthority` cleared all three of its refusals and answered
 *    `signed-in-operator`. The thing that asked for the approval granted it.
 * 3. It retries with the token and the destructive action runs.
 *
 * Neither header check could ever have stopped step 2, because both read headers
 * the caller chooses to send. The credential check could not either: it asked
 * whether a credential was present, never what KIND. And the key is in the agent's
 * hands legitimately — `packages/cli/src/lib/api-client.ts` reads it from
 * `DORKOS_API_KEY` or `<dork home>/api-key`, and without it a Codex or OpenCode
 * agent cannot reach the operator surface at all when login is on.
 *
 * ## Why the harness is this heavy
 *
 * Nothing here is stubbed on the path under test. Better Auth issues a real
 * session and a real per-user API key, the real `sessionGate` verifies them, and
 * the real approvals router answers. A test that handed the router a `res.locals.user`
 * of its own would be asserting its own fixture — the seam this exploit uses is
 * exactly the one between `sessionGate` and the route, and that seam has to be
 * crossed for the reproduction to mean anything.
 *
 * Every refusal case asserts the SUBJECT — the approval is still pending — and not
 * merely that some error came back. A guard that answered 403 after granting would
 * pass the status check and fail this one.
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
  hashApprovalInput,
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

/** The agent doing the asking, and the one holding the key. */
const AGENT_PATH = '/Users/dev/agents/prober';

/** The destructive capability the agent wants run without a person seeing it. */
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

describe('an agent holding the API key cannot approve its own work', () => {
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

  /** The identity the agent presents when it asks for the destructive action. */
  const IDENTITY = {
    agentPath: AGENT_PATH,
    displayName: 'Prober',
    tierCeiling: 'destructive' as const,
    createdAt: new Date().toISOString(),
  };

  /**
   * Step 1: ask as the agent, through the same `registry.invoke` every surface
   * uses, and read the id and token out of the refusal the way the CLI does.
   *
   * @returns The approval id and the retry token the 202 handed back.
   */
  async function askAsAgent(): Promise<{ approvalId: string; approvalToken: string }> {
    try {
      await registry.invoke(UNINSTALL.id, INPUT, { identity: IDENTITY });
    } catch (err) {
      if (err instanceof CapabilityGateRefusal && err.decision.outcome === 'approval_required') {
        const payload = err.decision.payload as { approvalId: string; approvalToken: string };
        return { approvalId: payload.approvalId, approvalToken: payload.approvalToken };
      }
      throw err;
    }
    throw new Error('the destructive capability was not gated');
  }

  /** Whether this approval is still waiting on a person. */
  function stillPending(approvalId: string): boolean {
    return approvals.listPending().some((row) => row.approvalId === approvalId);
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-self-approval-'));
    process.env.DORK_HOME = tmpDir;
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'self-approval.db'));
    runMigrations(db);
    const auth = initAuth(db, tmpDir);

    approvals = new ApprovalService(db, { describeCapability: (id) => registry?.get(id) });
    grants = new ApprovalGrantService(db);
    registry = composeRegistry([{ name: 'demo', capabilities: [UNINSTALL] }], {} as never);
    initCapabilityTierGate({ approvals });

    // Mirrors `app.ts`: Better Auth before the JSON body parser, then the real
    // gate, then the real router. No middleware of this test's own, and no
    // `isLoginEnabled` override — the route reads the live config, as it does in
    // production.
    app = express();
    app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
    app.use(express.json());
    app.use(sessionGate);
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
    // The very key the person is told to leave in `~/.dork/api-key` so their
    // agents inherit it (`docs/guides/cli-usage.mdx`). That is the point: this is
    // not a stolen credential.
    apiKey = (await auth.api.createApiKey({ body: { userId: ownerId, name: 'agent-key' } })).key;
  });

  beforeEach(() => {
    setLoginEnabled(false);
  });

  afterAll(() => {
    resetCapabilityTierGate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with Require login on', () => {
    it('refuses the bearer-key grant that omits both headers, and leaves the approval pending', async () => {
      setLoginEnabled(true);
      const { approvalId, approvalToken } = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_cookie_required');
      // The subject, not the status: nobody answered this, so it is still waiting.
      expect(stillPending(approvalId), 'the approval must still be waiting on a person').toBe(true);
      // Step 3 of the chain, which is what the agent was actually after: the retry
      // token it is holding still buys it nothing.
      expect(
        approvals.consume(approvalToken, {
          capabilityId: UNINSTALL.id,
          inputHash: hashApprovalInput(INPUT),
        }).outcome
      ).toBe('pending');
    });

    it('refuses the bearer-key DENY too, so an agent cannot bury the card', async () => {
      setLoginEnabled(true);
      const { approvalId } = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/deny`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ reason: 'nothing to see here' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_cookie_required');
      expect(stillPending(approvalId), 'a denial nobody made must not stick').toBe(true);
    });

    it('tells the caller where the answer has to happen, not which header was missing', async () => {
      setLoginEnabled(true);
      const { approvalId } = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('Authorization', `Bearer ${apiKey}`)
        .send({});

      // An agent relays this to a person, so it has to read as an instruction.
      // Naming the header would read as a hint about how to get around the bar.
      expect(res.body.error).toContain('inside DorkOS');
      expect(res.body.error.toLowerCase()).not.toContain('header');
      expect(res.body.error.toLowerCase()).not.toContain('x-dorkos');
    });

    it('still refuses the key when the agent also presents its identity', async () => {
      // The honest agent, which is refused earlier and told the more useful thing.
      setLoginEnabled(true);
      const { approvalId } = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('Authorization', `Bearer ${apiKey}`)
        .set(AGENT_IDENTITY_HEADER, 'agent-token')
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      expect(stillPending(approvalId)).toBe(true);
    });

    it('lets the person in the cockpit answer, so this is a guard and not an outage', async () => {
      setLoginEnabled(true);
      const { approvalId } = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set('Cookie', cookies)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('granted');
      expect(stillPending(approvalId)).toBe(false);
    });
  });

  describe('with Require login off — the default posture, deliberately unchanged', () => {
    it('still lets a credential-free caller answer', async () => {
      // Not an oversight. With login off there is no cookie for ANYONE, so this
      // bar has nothing to check and does not pretend to; a credential-free caller
      // with shell access is indistinguishable from the cockpit. Turning on
      // Require login is what closes it (`decision-authority.ts`).
      const { approvalId } = await askAsAgent();

      const res = await request(app).post(`/api/approvals/${approvalId}/grant`).send({});

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('granted');
      expect(stillPending(approvalId)).toBe(false);
    });

    it('still refuses an agent that names itself', async () => {
      const { approvalId } = await askAsAgent();

      const res = await request(app)
        .post(`/api/approvals/${approvalId}/grant`)
        .set(AGENT_IDENTITY_HEADER, 'agent-token')
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AGENT_CANNOT_DECIDE');
      expect(stillPending(approvalId)).toBe(true);
    });
  });
});
