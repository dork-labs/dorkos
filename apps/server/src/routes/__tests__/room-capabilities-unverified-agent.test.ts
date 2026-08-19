/**
 * @vitest-environment node
 *
 * The OTHER door into the rooms domain refuses an unverifiable agent token too
 * (DOR-1361).
 *
 * `resolveCaller` guards the HTTP room routes. It is not the only seam that
 * turns a request into a room author: `room-capabilities.ts`'s `callerAuthor`
 * does the same job for the four `rooms.*` capabilities, and those are reachable
 * over `POST /api/capabilities/:id/invoke` and over the external `/mcp` server.
 * Both of those surfaces read identity with `getRequestAgentIdentity`, which is
 * empty for a token that did not resolve — so a revoked agent arrived as
 * "nobody the surface could name", and with login off `callerAuthor` answers
 * that with the INSTALL OWNER. `post_to_room` wrote as the operator;
 * `read_room_history` is `observe`, the tier that allows before any other check,
 * so it read every room the operator is in, direct messages included.
 *
 * Driven through the REAL routers rather than through `registry.invoke`, because
 * the defect is in the WIRING: the registry-level tests in
 * `services/rooms/__tests__/room-capabilities.test.ts` were all green while this
 * was open, since they hand `identity` in directly and never present a header.
 *
 * The refusal reaches a caller as the rooms domain's own typed refusal —
 * `CapabilityToolError { code: 'AGENT_IDENTITY_UNVERIFIED' }` — which the invoke
 * route reports as 400 and MCP as an `isError` result. That is deliberately the
 * SAME shape every other room refusal takes on these surfaces (`ROOM_NOT_FOUND`
 * is a 400 here too); the code is what discriminates, not the status, and
 * inventing a second reporting shape for one refusal would be the divergence.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Drop the `agentIdentityPresented` refusal from `callerAuthor` -> every
 *   "refused" row red: the post lands as the owner and the history reads back.
 * - Stop threading the fact in `routes/capabilities-invoke.ts` -> the two invoke
 *   rows red, alone.
 * - Stop threading it in `routes/mcp.ts` (or drop it from `mcp-server.ts`'s
 *   `caller`) -> the two MCP rows red, alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

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

/**
 * The two install facts `callerAuthor` reads per call — the same stub shape
 * `services/rooms/__tests__/room-capabilities.test.ts` uses, for the same reason:
 * they live outside the rooms domain and a test moves between postures with them.
 *
 * Login stays OFF for every case here, because login-off is the posture where
 * the laundering happened: with login ON an unattributable caller was already
 * refused `UNIDENTIFIED_CALLER`.
 */
const installState: { ownerId: string | null; loginEnabled: boolean } = {
  ownerId: null,
  loginEnabled: false,
};

vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => (installState.ownerId ? { id: installState.ownerId } : null),
  verifyRequestAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/config-manager.js')>()),
  configManager: {
    get: (section: string) =>
      section === 'auth' ? { enabled: installState.loginEnabled } : undefined,
    set: () => {},
  },
}));

import {
  composeRegistry,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import { roomsDomain } from '../../services/rooms/room-capabilities.js';
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
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../services/rooms/__tests__/room-test-harness.js';

/** A token shaped like the real thing that resolves to nobody: a revoked agent. */
const UNVERIFIABLE = 'dork_agent_this-token-resolves-to-nothing';

/** The code every room seam now answers a token it cannot verify with. */
const REFUSAL_CODE = 'AGENT_IDENTITY_UNVERIFIED';

const ANA_PATH = '/agents/ana';

const agents = agentLookupFor({
  [ANA_PATH]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

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

/** JSON-RPC `tools/call`, in the shape the stateless transport accepts. */
function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1 };
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

/** The payload a capability refusal carries back through the MCP envelope. */
function mcpErrorPayload(res: request.Response): { code?: string; error?: string } {
  const body = jsonRpc(res);
  expect(body.result?.isError).toBe(true);
  return JSON.parse(body.result!.content![0]!.text!);
}

describe('an unverifiable agent token on the rooms capability surfaces', () => {
  let harness: RoomHarness;
  let registry: CapabilityRegistry;
  let roomId: string;
  let ownerAuthorId: string;

  beforeEach(() => {
    installState.ownerId = null;
    installState.loginEnabled = false;
    resetAgentIdentityService();
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    initAgentIdentityService(harness.db);
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    ownerAuthorId = harness.human;
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA_PATH] },
      ownerAuthorId
    ).id;
    // Something for a read to find, written by the operator — the content the
    // laundered caller used to be handed.
    harness.service.post(roomId, { authorId: ownerAuthorId, text: 'a private note' });
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /** A token that really does resolve to Ana. */
  function anaToken(): Promise<string> {
    return initAgentIdentityService(harness.db).mint({
      agentPath: ANA_PATH,
      displayName: 'Ana',
    });
  }

  /** How many entries the room holds — what a refused post must not change. */
  function entryCount(): number {
    return harness.service.readHistory(roomId, ownerAuthorId, { limit: 50 }).length;
  }

  describe('POST /api/capabilities/:id/invoke', () => {
    /** The invoke route behind the identity middleware, as `index.ts` mounts it. */
    function app(): express.Express {
      const server = express();
      server.use(express.json());
      server.use(resolveAgentIdentity);
      server.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
      return server;
    }

    it('refuses rooms.post, where the same call with no header posts as the operator', async () => {
      const refused = await request(app())
        .post('/api/capabilities/rooms.post/invoke')
        .set('X-DorkOS-Agent', UNVERIFIABLE)
        .send({ roomId, text: 'as you, apparently' });

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe(REFUSAL_CODE);
      // The half that matters: nothing was written under anybody's name.
      expect(entryCount()).toBe(1);

      // The header is the ONLY difference. Without this the refusal above would
      // also pass for a route that was simply broken.
      const allowed = await request(app())
        .post('/api/capabilities/rooms.post/invoke')
        .send({ roomId, text: 'from the keyboard' });
      expect(allowed.status).toBe(200);
      expect(allowed.body.posted).toBe(true);
      expect(entryCount()).toBe(2);
    });

    it('refuses rooms.read_history, which the observe tier lets through', async () => {
      // `observe` returns allowed before any other check runs, so the ONLY thing
      // between this caller and the operator's rooms was `callerAuthor`.
      const refused = await request(app())
        .post('/api/capabilities/rooms.read_history/invoke')
        .set('X-DorkOS-Agent', UNVERIFIABLE)
        .send({ roomId, limit: 5 });

      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe(REFUSAL_CODE);
      expect(refused.body).not.toHaveProperty('entries');
      expect(JSON.stringify(refused.body)).not.toContain('a private note');
    });

    it('still lets a token that resolves act as its own agent', async () => {
      const token = await anaToken();

      const res = await request(app())
        .post('/api/capabilities/rooms.post/invoke')
        .set('X-DorkOS-Agent', token)
        .send({ roomId, text: 'on it' });

      expect(res.status).toBe(200);
      const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
      expect(harness.store.getEntryById(roomId, res.body.entryId)?.authorId).toBe(anaAuthorId);
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
     * Post one JSON-RPC message with the headers the transport insists on.
     *
     * `token` is set BEFORE the body, because supertest dispatches on the first
     * `.send()` of a chain — a `.set()` written after it never reaches the wire,
     * which is exactly how this test first passed against the unfixed code.
     */
    function rpc(body: Record<string, unknown>, token?: string): request.Test {
      const req = request(app())
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream');
      if (token) req.set('X-DorkOS-Agent', token);
      return req.send(body);
    }

    it('refuses post_to_room, where the same call with no header posts', async () => {
      const refused = await rpc(
        toolCall('post_to_room', { roomId, text: 'as you, apparently' }),
        UNVERIFIABLE
      );

      expect(mcpErrorPayload(refused).code).toBe(REFUSAL_CODE);
      expect(entryCount()).toBe(1);

      const allowed = await rpc(toolCall('post_to_room', { roomId, text: 'from the keyboard' }));
      expect(jsonRpc(allowed).result?.isError).toBeFalsy();
      expect(entryCount()).toBe(2);
    });

    it('refuses read_room_history, and hands back none of the room', async () => {
      const refused = await rpc(toolCall('read_room_history', { roomId, limit: 5 }), UNVERIFIABLE);

      expect(mcpErrorPayload(refused).code).toBe(REFUSAL_CODE);
      expect(refused.text).not.toContain('a private note');
    });

    it('still lets a token that resolves act as its own agent', async () => {
      const token = await anaToken();

      const res = await rpc(toolCall('post_to_room', { roomId, text: 'on it' }), token);

      expect(jsonRpc(res).result?.isError).toBeFalsy();
      const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
      const posted = harness.service.readHistory(roomId, ownerAuthorId, { limit: 5 });
      expect(posted.find((entry) => entry.body.text === 'on it')?.authorId).toBe(anaAuthorId);
    });
  });
});
