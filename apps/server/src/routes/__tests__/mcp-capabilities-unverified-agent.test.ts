/**
 * @vitest-environment node
 *
 * A revoked agent cannot get itself recorded as the operator on a managed MCP
 * server (DOR-1361).
 *
 * `resolveAddedBy` was the third copy of the same mistake: it read
 * `context.identity?.agentPath ?? 'operator'`, and an unverifiable token leaves
 * that empty — so `mcp_add_server` and `mcp_import_server` stamped `addedBy:
 * 'operator'` into the agent's manifest for an act no person performed. That
 * field is durable and it is what a person reads when deciding whether to trust
 * an entry that runs a command in an agent's environment.
 *
 * **Both verbs are `destructive`, so the shape of the test is the shape of the
 * attack.** The tier gate asks a person before either runs, and the anonymous
 * ceiling is `destructive` — so a caller with a junk token is NOT denied, it gets
 * a card, and on a grant it retries and reaches the handler. That retry is where
 * the refusal has to land, and it is why every case here goes through the whole
 * ask-grant-retry round trip rather than calling the verb directly.
 *
 * Driven through the real routers, for the reason the rooms pair is: the defect
 * is wiring, and a registry-level test hands `identity` in and never presents a
 * header.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Restore `?? 'operator'` without the guard -> both refusal rows red, and the
 *   recorded `addedBy` is `operator` for a call no person made.
 * - Guard on `!context.identity` alone -> the header-free rows red: the operator
 *   can no longer add a server at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

vi.mock('../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));

vi.mock('../../lib/version.js', () => ({
  SERVER_VERSION: 'test',
  IS_DEV_BUILD: false,
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logError: vi.fn(() => ({})),
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));

import {
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { mcpDomain } from '../../services/mesh/mcp-capabilities.js';
import type { McpCapabilityDeps } from '../../services/mesh/mcp-capability-deps.js';
import { createExternalMcpServer } from '../../services/core/mcp-server.js';
import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';
import { NotifyBudget } from '../../services/relay/notify-budget.js';
import { resolveAgentIdentity } from '../../middleware/agent-identity.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { createCapabilitiesInvokeRouter } from '../capabilities-invoke.js';
import { createMcpRouter } from '../mcp.js';

/** A token shaped like the real thing that resolves to nobody: a revoked agent. */
const UNVERIFIABLE = 'dork_agent_this-token-resolves-to-nothing';

/** The code every seam that names a caller now answers an unverifiable token with. */
const REFUSAL_CODE = 'AGENT_IDENTITY_UNVERIFIED';

const ANA_PATH = '/agents/ana';
const AGENT_ID = 'agent-ana';

/** What `mcp_add_server` was asked to add. */
const SERVER = {
  agentId: AGENT_ID,
  name: 'weather',
  connection: { transport: 'http' as const, url: 'https://weather.example/mcp' },
};

/** Every `addedBy` the fake service was handed, in call order. */
let recordedAddedBy: string[];

/** A stand-in service that records the principal instead of writing a manifest. */
function fakeMcpDeps(): McpCapabilityDeps {
  return {
    service: {
      add: async ({ addedBy, name }: { addedBy: string; name: string }) => {
        recordedAddedBy.push(addedBy);
        return [{ name, addedBy }];
      },
    } as unknown as McpCapabilityDeps['service'],
    agents: {} as unknown as McpCapabilityDeps['agents'],
  };
}

/** Minimal deps for the external MCP server — the shape `mcp-integration` uses. */
function minimalMcpDeps(): McpToolDeps {
  return {
    notifyBudget: new NotifyBudget(),
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
  };
}

/** Read one JSON-RPC message back, whichever way the transport chose to send it. */
function jsonRpc(res: request.Response): {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
} {
  const contentType = (res.headers['content-type'] as string) ?? '';
  if (contentType.includes('text/event-stream')) {
    const line = res.text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line!.slice(6));
  }
  return res.body;
}

/** The payload an MCP tool result carries, refusal or not. */
function mcpPayload(res: request.Response): Record<string, unknown> {
  const body = jsonRpc(res);
  return JSON.parse(body.result!.content![0]!.text!);
}

describe('an unverifiable agent token on the mcp.* capability surfaces', () => {
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    recordedAddedBy = [];
    resetAgentIdentityService();
    db = createTestDb();
    initAgentIdentityService(db);
    approvals = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
    registry = composeRegistry([mcpDomain], { logger: noopLogger, mcpDeps: fakeMcpDeps() });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetAgentIdentityService();
    vi.restoreAllMocks();
  });

  /** A token that really does resolve to Ana. */
  function anaToken(): Promise<string> {
    return initAgentIdentityService(db).mint({ agentPath: ANA_PATH, displayName: 'Ana' });
  }

  describe('POST /api/capabilities/mcp.add/invoke', () => {
    /** The invoke route behind the identity middleware, as `index.ts` mounts it. */
    function app(): express.Express {
      const server = express();
      server.use(express.json());
      server.use(resolveAgentIdentity);
      server.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
      return server;
    }

    /**
     * Ask, have a person grant, and retry with the token — the whole round trip a
     * destructive capability takes before its handler ever runs.
     *
     * @param token - The `X-DorkOS-Agent` value to present, if any.
     */
    async function askGrantRetry(token?: string): Promise<request.Response> {
      const ask = request(app()).post('/api/capabilities/mcp.add/invoke');
      if (token) ask.set('X-DorkOS-Agent', token);
      const asked = await ask.send(SERVER);
      expect(asked.status, 'a destructive verb must ask a person first').toBe(202);
      expect(recordedAddedBy, 'nothing may be written before the grant').toEqual([]);
      approvals.grant(asked.body.approvalId);

      const retry = request(app())
        .post('/api/capabilities/mcp.add/invoke')
        .set('X-DorkOS-Approval', asked.body.approvalToken);
      if (token) retry.set('X-DorkOS-Agent', token);
      return retry.send(SERVER);
    }

    it('refuses the granted retry, and records no principal at all', async () => {
      const res = await askGrantRetry(UNVERIFIABLE);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(REFUSAL_CODE);
      // The half that matters: the manifest field was never written, and above
      // all it does not say `operator` for a call no person made.
      expect(recordedAddedBy).toEqual([]);
    });

    it('still records the operator when no header is presented', async () => {
      // The negative control, and the posture the whole product runs in: the
      // person adding a server from the cockpit presents no agent header at all.
      const res = await askGrantRetry();

      expect(res.status).toBe(200);
      expect(recordedAddedBy).toEqual(['operator']);
    });

    it('still records the agent when its token DOES resolve', async () => {
      const res = await askGrantRetry(await anaToken());

      expect(res.status).toBe(200);
      expect(recordedAddedBy).toEqual([ANA_PATH]);
    });
  });

  describe('the external /mcp server', () => {
    /** The real MCP router over the real external server, as `index.ts` wires it. */
    function app(): express.Express {
      const server = express();
      server.use(express.json());
      server.use(resolveAgentIdentity);
      server.use(
        '/mcp',
        createMcpRouter((caller) =>
          createExternalMcpServer(
            minimalMcpDeps(),
            undefined,
            registry,
            caller.identity,
            caller.userId,
            caller.agentIdentityPresented
          )
        )
      );
      return server;
    }

    /**
     * Post one `tools/call`. The token is set BEFORE the body, because supertest
     * dispatches on the first `.send()` of a chain.
     */
    function rpc(args: Record<string, unknown>, token?: string): request.Test {
      const req = request(app())
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream');
      if (token) req.set('X-DorkOS-Agent', token);
      return req.send({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'mcp_add_server', arguments: args },
        id: 1,
      });
    }

    /**
     * The same round trip over MCP. The approval token rides as an ARGUMENT here,
     * not a header — a model has no way to set one (`retryChannel:
     * 'mcp-argument'`).
     *
     * @param token - The `X-DorkOS-Agent` value to present, if any.
     */
    async function askGrantRetry(token?: string): Promise<request.Response> {
      const asked = await rpc(SERVER, token);
      const payload = mcpPayload(asked) as {
        status?: string;
        approvalId?: string;
        approvalToken?: string;
      };
      expect(payload.status, 'a destructive verb must ask a person first').toBe(
        'approval_required'
      );
      expect(recordedAddedBy).toEqual([]);
      approvals.grant(payload.approvalId!);

      return rpc({ ...SERVER, approvalToken: payload.approvalToken }, token);
    }

    it('refuses the granted retry, and records no principal at all', async () => {
      const res = await askGrantRetry(UNVERIFIABLE);

      expect(jsonRpc(res).result?.isError).toBe(true);
      expect(mcpPayload(res).code).toBe(REFUSAL_CODE);
      expect(recordedAddedBy).toEqual([]);
    });

    it('still records the operator when no header is presented', async () => {
      const res = await askGrantRetry();

      expect(jsonRpc(res).result?.isError).toBeFalsy();
      expect(recordedAddedBy).toEqual(['operator']);
    });

    it('still records the agent when its token DOES resolve', async () => {
      const res = await askGrantRetry(await anaToken());

      expect(jsonRpc(res).result?.isError).toBeFalsy();
      expect(recordedAddedBy).toEqual([ANA_PATH]);
    });
  });
});
