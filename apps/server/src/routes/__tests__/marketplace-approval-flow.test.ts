/**
 * End-to-end approval flow for an externally-initiated marketplace install
 * (spec `agent-trust` §3.3).
 *
 * This is the path that replaced `POST /api/marketplace/confirmations/:token`:
 * the agent asks, the operator sees the request in `GET /api/approvals/pending`
 * and answers it BY APPROVAL ID through `POST /api/approvals/:id/grant|deny`,
 * and only then does the agent's retry succeed. Deciding by id rather than by
 * token is the point — the agent holds the token, so a decide-by-token route
 * would let a requester approve itself.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalGrantService, ApprovalService } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { TokenConfirmationProvider } from '../../services/marketplace-mcp/confirmation-provider.js';
import { createInstallHandler } from '../../services/marketplace-mcp/tool-install.js';
import type { InstallerLike } from '../../services/marketplace/marketplace-installer.js';
import type { MarketplaceMcpDeps } from '../../services/marketplace-mcp/marketplace-mcp-tools.js';
import { createApprovalsRouter } from '../approvals.js';

/** An empty permission preview — this test is about the gate, not the effects. */
const EMPTY_PREVIEW = {
  fileChanges: [],
  extensions: [],
  hooks: [],
  unreadableHooks: [],
  npmDependencies: [],
  schedules: [],
  secrets: [],
  externalHosts: [],
  requires: [],
  conflicts: [],
};

/** Parse the JSON payload out of an MCP text-content result. */
function parsePayload<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe('marketplace install → cockpit approval → retry', () => {
  let approvals: ApprovalService;
  let grants: ApprovalGrantService;
  let installer: InstallerLike;
  let handler: ReturnType<typeof createInstallHandler>;
  let app: express.Express;

  beforeEach(() => {
    const db = createTestDb();
    approvals = new ApprovalService(db);
    grants = new ApprovalGrantService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});

    installer = {
      preview: vi.fn().mockResolvedValue({ preview: EMPTY_PREVIEW }),
      install: vi.fn().mockResolvedValue({
        packageName: 'sentry-monitor',
        version: '1.0.0',
        type: 'plugin',
        installPath: '/tmp/sentry-monitor',
        warnings: [],
      }),
    };
    handler = createInstallHandler({
      installer,
      confirmationProvider: new TokenConfirmationProvider(approvals),
    } as unknown as MarketplaceMcpDeps);

    app = express();
    app.use(express.json());
    // Local login off: the DEFAULT posture, and therefore the one this flow has to
    // work in. Who may decide is `resolveDecisionAuthority`; see its module TSDoc.
    app.use(
      '/api/approvals',
      createApprovalsRouter(approvals, grants, { isLoginEnabled: () => false })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs only after a person grants the approval by id', async () => {
    // 1. The agent asks. Nothing is installed yet.
    const first = await handler({ name: 'sentry-monitor', marketplace: 'community' });
    const { status, confirmationToken } = parsePayload<{
      status: string;
      confirmationToken: string;
    }>(first);
    expect(status).toBe('requires_confirmation');
    expect(installer.install).not.toHaveBeenCalled();

    // 2. The operator sees it on the card, with a summary they can act on.
    const pending = await request(app).get('/api/approvals/pending');
    expect(pending.status).toBe(200);
    expect(pending.body.approvals).toHaveLength(1);
    expect(pending.body.approvals[0]).toMatchObject({
      capabilityId: 'marketplace.install',
      // Caller-supplied values are quoted on the card so an injected one cannot
      // forge a second field (`approval-summary.ts`).
      summary: 'Install "sentry-monitor" from "community"',
    });
    // The token the agent holds is never echoed to the cockpit.
    expect(pending.text).not.toContain(confirmationToken);

    // 3. They allow it, by approval id.
    const granted = await request(app)
      .post(`/api/approvals/${pending.body.approvals[0].approvalId}/grant`)
      .send();
    expect(granted.status).toBe(200);
    expect(granted.body.outcome).toBe('granted');

    // 4. The agent retries with its token and the install runs.
    const second = await handler({
      name: 'sentry-monitor',
      marketplace: 'community',
      confirmationToken,
    });
    expect(parsePayload<{ status: string }>(second).status).toBe('installed');
    expect(installer.install).toHaveBeenCalledTimes(1);

    // 5. The approval is spent and off the card; a replay installs nothing more.
    const afterwards = await request(app).get('/api/approvals/pending');
    expect(afterwards.body.approvals).toEqual([]);
    const replay = await handler({
      name: 'sentry-monitor',
      marketplace: 'community',
      confirmationToken,
    });
    expect(parsePayload<{ status: string }>(replay).status).toBe('declined');
    expect(installer.install).toHaveBeenCalledTimes(1);
  });

  it('installs nothing when the person refuses', async () => {
    const first = await handler({ name: 'sentry-monitor', marketplace: 'community' });
    const { confirmationToken } = parsePayload<{ confirmationToken: string }>(first);

    const pending = await request(app).get('/api/approvals/pending');
    const denied = await request(app)
      .post(`/api/approvals/${pending.body.approvals[0].approvalId}/deny`)
      .send({ reason: 'looks sketchy' });
    expect(denied.status).toBe(200);

    const second = await handler({
      name: 'sentry-monitor',
      marketplace: 'community',
      confirmationToken,
    });
    expect(parsePayload<{ status: string; reason: string }>(second)).toMatchObject({
      status: 'declined',
      reason: 'looks sketchy',
    });
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('refuses to let the requesting agent grant its own approval', async () => {
    // Same app, but every request now carries a resolved agent identity — what
    // the `X-DorkOS-Agent` middleware attaches for an agent-originated call.
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((_req, res, next) => {
      res.locals.agentIdentity = {
        agentPath: '/Users/dev/agents/dorkbot',
        displayName: 'DorkBot',
        tierCeiling: 'destructive',
        createdAt: new Date().toISOString(),
      };
      next();
    });
    agentApp.use(
      '/api/approvals',
      createApprovalsRouter(approvals, grants, { isLoginEnabled: () => false })
    );

    const first = await handler({ name: 'sentry-monitor', marketplace: 'community' });
    const { confirmationToken } = parsePayload<{ confirmationToken: string }>(first);
    const pending = await request(agentApp).get('/api/approvals/pending');
    const approvalId = pending.body.approvals[0].approvalId;

    const selfGrant = await request(agentApp).post(`/api/approvals/${approvalId}/grant`).send();
    expect(selfGrant.status).toBe(403);
    expect(selfGrant.body.code).toBe('AGENT_CANNOT_DECIDE');

    const selfDeny = await request(agentApp).post(`/api/approvals/${approvalId}/deny`).send();
    expect(selfDeny.status).toBe(403);

    // Still pending, and the retry still cannot install.
    const second = await handler({
      name: 'sentry-monitor',
      marketplace: 'community',
      confirmationToken,
    });
    expect(parsePayload<{ status: string }>(second).status).toBe('requires_confirmation');
    expect(installer.install).not.toHaveBeenCalled();
  });
});
