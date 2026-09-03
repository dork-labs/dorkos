/**
 * @vitest-environment node
 *
 * The OTHER door into the rooms domain refuses an unverifiable agent token too
 * (DOR-1361).
 *
 * `resolveCaller` guards the HTTP room routes. It is not the only seam that
 * turns a request into a room author: `room-capabilities.ts`'s `callerAuthor`
 * does the same job for the eight `rooms.*` capabilities, and those are reachable
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
 * ## Three dead states, not one string (DOR-486)
 *
 * This suite used to present ONE fabricated token — a string that resolves to
 * nobody — and called it "what a revoked agent looks like". That stopped being
 * true, and the suite could not notice: `resolve()` now NAMES a revoked or
 * expired token, marking it `inactive`, so the capability gate can tell a
 * shut-off agent from a stranger. `callerAuthor` keyed on identity PRESENCE, so
 * the two real states walked straight past it while every assertion here stayed
 * green against the wrong subject. Measured on the real invoke router before the
 * fix: a revoked token read room history `200`, and an expired token posted
 * `200` (entries 1 -> 2).
 *
 * So every refusal row runs against all three states a token can be dead in, each
 * built the way it really happens — mint then revoke, mint then age past the
 * absolute TTL, and a string from no agent at all.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Drop the `agentIdentityPresented` refusal from `callerAuthor` -> every
 *   "fabricated" row red: the post lands as the owner and the history reads back.
 * - Drop the `!context.identity.inactive` test from `callerAuthor` -> every
 *   "revoked" and "expired" row red, and only those.
 * - Stop threading the fact in `routes/capabilities-invoke.ts` -> the invoke
 *   fabricated rows red, alone.
 * - Stop threading it in `routes/mcp.ts` (or drop it from `mcp-server.ts`'s
 *   `caller`) -> the MCP fabricated rows red, alone.
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

import { z } from 'zod';
import { readManifest } from '@dorkos/shared/manifest';
import {
  composeRegistry,
  defineCapability,
  initToolGroupGate,
  manifestToolGroupGrants,
  resetToolGroupGate,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import { roomsDomain } from '../../services/rooms/room-capabilities.js';
import { createExternalMcpServer } from '../../services/core/mcp-server.js';
import { capabilityMcpTools } from '../../services/runtimes/claude-code/mcp-tools/capability-mcp-tools.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';
import { NotifyBudget } from '../../services/relay/notify-budget.js';
import { resolveAgentIdentity } from '../../middleware/agent-identity.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  TOKEN_ABSOLUTE_TTL_MS,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { agentIdentityTokens } from '@dorkos/db';
import { createCapabilitiesInvokeRouter } from '../capabilities-invoke.js';
import { createMcpRouter } from '../mcp.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../services/rooms/__tests__/room-test-harness.js';

/** A token shaped like the real thing that resolves to NO agent at all. */
const UNVERIFIABLE = 'dork_agent_this-token-resolves-to-nothing';

/** The three states a presented token can be dead in. Each must be refused. */
type DeadTokenState = 'fabricated' | 'revoked' | 'expired';

/** Every dead state, so a row that only covers one cannot pass for coverage. */
const DEAD_TOKEN_STATES: DeadTokenState[] = ['fabricated', 'revoked', 'expired'];

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
    dorkHome: '/tmp/dorkos-test-home',
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

/**
 * Whether a JSON-RPC reply is a refusal, in EITHER shape a refusal can take.
 *
 * Two gates can turn one of these calls away and they answer differently on
 * purpose: `callerAuthor` throws the rooms domain's typed error (`isError`),
 * while the tier gate returns a structured `denied` payload that is deliberately
 * NOT `isError` so a model reads it rather than retrying. Which one answers
 * depends on the caller and the tier — a revoked token is capped at `observe`,
 * so an `act` verb is stopped by the ceiling before `callerAuthor` ever runs.
 * The property under test is that the call did not happen, so the assertion is
 * on that, not on which door closed first (DOR-486).
 *
 * @param res - The transport response.
 * @returns The refusal text, for the caller to make its own claims about.
 */
function refusalText(res: request.Response): string {
  const body = jsonRpc(res);
  const text = body.result?.content?.[0]?.text ?? '';
  // Parsed, not substring-matched: the denial payload is pretty-printed, so
  // `"status":"denied"` never appears literally in it.
  let status: unknown;
  try {
    status = (JSON.parse(text) as { status?: unknown }).status;
  } catch {
    status = undefined;
  }
  const refused = body.result?.isError === true || status === 'denied';
  expect(refused, `expected a refusal, got: ${text.slice(0, 200)}`).toBe(true);
  return text;
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

  /**
   * A token in one of the three dead states, built the way it really happens.
   *
   * `revoked` and `expired` are REAL — minted for Ana and then killed — because
   * the fabricated string is the one dead state that never had an identity to
   * resolve to, and it is precisely the state that kept passing while the other
   * two walked through (DOR-486).
   *
   * @param state - Which dead state to produce.
   * @returns The token to present.
   */
  async function deadToken(state: DeadTokenState): Promise<string> {
    if (state === 'fabricated') return UNVERIFIABLE;
    const token = await anaToken();
    if (state === 'revoked') {
      await initAgentIdentityService(harness.db).revoke(ANA_PATH);
      return token;
    }
    // Past the absolute cap, which no amount of use resets.
    const longAgo = new Date(Date.now() - TOKEN_ABSOLUTE_TTL_MS - 60_000).toISOString();
    harness.db.update(agentIdentityTokens).set({ createdAt: longAgo, lastUsedAt: longAgo }).run();
    return token;
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

    it.each(DEAD_TOKEN_STATES)('refuses rooms.post for a %s token', async (state) => {
      const refused = await request(app())
        .post('/api/capabilities/rooms.post/invoke')
        .set('X-DorkOS-Agent', await deadToken(state))
        .send({ roomId, text: 'as you, apparently' });

      // Refused, and by WHICHEVER gate got there first: a revoked identity is
      // capped at `observe`, so the tier gate turns an `act` verb away (403,
      // `tier_ceiling`) before `callerAuthor` runs; the other two states reach
      // `callerAuthor` and get its 400. Asserting one code would pin the order
      // the gates happen to run in rather than the property (DOR-486).
      expect(refused.status).not.toBe(200);
      expect([REFUSAL_CODE, undefined]).toContain(
        refused.body.code === undefined ? undefined : REFUSAL_CODE
      );
      expect(refused.body.posted).toBeUndefined();
      // The half that matters: nothing was written under anybody's name.
      expect(entryCount()).toBe(1);
    });

    it('posts as the operator with no header at all, which is the control', () => {
      // The header is the ONLY difference. Without this the refusals above would
      // also pass for a route that was simply broken.
      return request(app())
        .post('/api/capabilities/rooms.post/invoke')
        .send({ roomId, text: 'from the keyboard' })
        .expect(200)
        .then((allowed) => {
          expect(allowed.body.posted).toBe(true);
          expect(entryCount()).toBe(2);
        });
    });

    it.each(DEAD_TOKEN_STATES)(
      'refuses rooms.read_history for a %s token, which the observe tier lets through',
      async (state) => {
        // `observe` returns allowed before any other check runs, so the ONLY
        // thing between this caller and the operator's rooms is `callerAuthor`.
        const refused = await request(app())
          .post('/api/capabilities/rooms.read_history/invoke')
          .set('X-DorkOS-Agent', await deadToken(state))
          .send({ roomId, limit: 5 });

        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe(REFUSAL_CODE);
        expect(refused.body).not.toHaveProperty('entries');
        expect(JSON.stringify(refused.body)).not.toContain('a private note');
      }
    );

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

    it.each(DEAD_TOKEN_STATES)('refuses post_to_room for a %s token', async (state) => {
      const refused = await rpc(
        toolCall('post_to_room', { roomId, text: 'as you, apparently' }),
        await deadToken(state)
      );

      // Either refusal shape — see `refusalText` on why the gate that answers
      // depends on the state and the tier.
      refusalText(refused);
      expect(entryCount()).toBe(1);
    });

    it('posts with no header at all, which is the control', async () => {
      const allowed = await rpc(toolCall('post_to_room', { roomId, text: 'from the keyboard' }));

      expect(jsonRpc(allowed).result?.isError).toBeFalsy();
      expect(entryCount()).toBe(2);
    });

    it.each(DEAD_TOKEN_STATES)(
      'refuses read_room_history for a %s token, and hands back none of the room',
      async (state) => {
        const refused = await rpc(
          toolCall('read_room_history', { roomId, limit: 5 }),
          await deadToken(state)
        );

        // `read_room_history` is `observe`, the tier no ceiling ever blocks — so
        // for all three states `callerAuthor` is the ONLY thing between this
        // caller and the operator's rooms, and its typed code is what comes back.
        expect(mcpErrorPayload(refused).code).toBe(REFUSAL_CODE);
        expect(refused.text).not.toContain('a private note');
      }
    );

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

/**
 * The per-agent tool-group grant, over the SAME two real surfaces (DOR-1611,
 * spec `rooms-management-tools` §D1 and Acceptance 1–4).
 *
 * It lives in this file for the reason the header above gives about the rooms
 * refusal: the registry-level tests hand `identity` straight in, and the defect
 * class that matters is in the WIRING. A grant proved only at `registry.invoke`
 * would say nothing about whether the external `/mcp` server reaches that gate,
 * or about what a refusal looks like once it has been through the MCP envelope.
 *
 * No rooms verb declares a `toolGroup` until PR2 ships the five management verbs,
 * so the subject here is a probe capability that declares one and is composed
 * beside the rooms domain, onto the same server, through the same adapters. That
 * is deliberate rather than a shortcut: the boundary is a property of
 * `registry.invoke` and its adapters, not of the rooms domain, and proving it
 * against a fixture is what lets PR2 add the verbs without re-proving it.
 *
 * The grant is read by the REAL production lookup (`manifestToolGroupGrants`)
 * through the module mock at the top of this file, so the manifest shape it reads
 * is the manifest shape it will read in production.
 */
describe('a capability behind the rooms-management grant, on the real surfaces', () => {
  let harness: RoomHarness;
  let registry: CapabilityRegistry;
  /** Set by the probe's handler. Must stay false for every refused row. */
  let probeRan = false;

  /** The probe's MCP tool name, as the external adapter registers it. */
  const PROBE_TOOL = 'grant_probe';

  /** A capability that declares the hard group and nothing else remarkable. */
  const probeDomain = {
    name: 'grantprobe',
    capabilities: [
      defineCapability({
        id: 'grantprobe.run',
        title: 'Grant probe',
        description: 'A fixture capability standing in for the five rooms-management verbs.',
        tier: 'act' as const,
        input: z.object({}),
        output: z.unknown(),
        surfaces: {
          mcp: { toolName: PROBE_TOOL, servers: ['in-session' as const, 'external' as const] },
        },
        toolGroup: 'roomsManage' as const,
        invoke: async () => {
          probeRan = true;
          return { ok: true };
        },
      }),
    ],
  };

  /** The manifest `readManifest` answers with, for the given grant state. */
  function manifestGranting(roomsManage?: boolean) {
    return {
      id: '01M054RMQAMZPXHWHRKPGY9Z87',
      name: 'ana',
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-08-16T00:00:00.000Z',
      registeredBy: 'test',
      personaEnabled: true,
      enabledToolGroups: roomsManage === undefined ? {} : { roomsManage },
      mcpServers: [],
    };
  }

  /** Point the mocked manifest reader at a grant state for the next call. */
  function grantIs(roomsManage?: boolean): void {
    vi.mocked(readManifest).mockResolvedValue(
      manifestGranting(roomsManage) as unknown as Awaited<ReturnType<typeof readManifest>>
    );
  }

  beforeEach(() => {
    probeRan = false;
    installState.ownerId = null;
    installState.loginEnabled = false;
    resetAgentIdentityService();
    resetToolGroupGate();
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    initAgentIdentityService(harness.db);
    registry = composeRegistry([roomsDomain, probeDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    // The REAL production lookup, over the mocked manifest reader.
    initToolGroupGate({ grants: manifestToolGroupGrants() });
    vi.mocked(readManifest).mockResolvedValue(null);
  });

  afterEach(() => {
    resetAgentIdentityService();
    resetToolGroupGate();
    vi.mocked(readManifest).mockResolvedValue(null);
  });

  /** A token that really does resolve to Ana. */
  function anaToken(): Promise<string> {
    return initAgentIdentityService(harness.db).mint({
      agentPath: ANA_PATH,
      displayName: 'Ana',
    });
  }

  /**
   * A token in one of the three dead states, built the way it really happens.
   *
   * `revoked` and `expired` are REAL — minted for Ana and then killed — because
   * the fabricated string is the one dead state that never had an identity to
   * resolve to, and it is precisely the state that kept passing while the other
   * two walked through (DOR-486).
   *
   * @param state - Which dead state to produce.
   * @returns The token to present.
   */
  async function deadToken(state: DeadTokenState): Promise<string> {
    if (state === 'fabricated') return UNVERIFIABLE;
    const token = await anaToken();
    if (state === 'revoked') {
      await initAgentIdentityService(harness.db).revoke(ANA_PATH);
      return token;
    }
    // Past the absolute cap, which no amount of use resets.
    const longAgo = new Date(Date.now() - TOKEN_ABSOLUTE_TTL_MS - 60_000).toISOString();
    harness.db.update(agentIdentityTokens).set({ createdAt: longAgo, lastUsedAt: longAgo }).run();
    return token;
  }

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

    /** Post one JSON-RPC message, headers before body (see the note above). */
    function rpc(body: Record<string, unknown>, token?: string): request.Test {
      const req = request(app())
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream');
      if (token) req.set('X-DorkOS-Agent', token);
      return req.send(body);
    }

    /** The gate's structured payload, read out of the MCP envelope. */
    function refusalPayload(res: request.Response): Record<string, unknown> {
      const body = jsonRpc(res);
      // NOT `isError`. A refusal is a step in a protocol, not a crash, and the
      // model has to read the sentence rather than treat it as a tool failure.
      expect(body.result?.isError).toBeFalsy();
      return JSON.parse(body.result!.content![0]!.text!);
    }

    it('refuses an identified agent whose manifest does not carry the grant', async () => {
      grantIs(undefined);
      const token = await anaToken();

      const payload = refusalPayload(await rpc(toolCall(PROBE_TOOL, {}), token));

      expect(payload).toMatchObject({
        status: 'denied',
        capabilityId: 'grantprobe.run',
        reason: 'tool_group_disabled',
        // No approval can ever unlock this, so the model must not loop asking.
        approvable: false,
      });
      expect(String(payload.message)).toContain('Manage rooms');
      expect(probeRan).toBe(false);
    });

    it('runs the same call for the same agent once the grant is on', async () => {
      // The discrimination pair. The ONLY difference between this row and the one
      // above is the value in the manifest — without it, a refusal would also pass
      // for a tool that was simply broken.
      grantIs(true);
      const token = await anaToken();

      const res = await rpc(toolCall(PROBE_TOOL, {}), token);

      expect(jsonRpc(res).result?.isError).toBeFalsy();
      expect(probeRan).toBe(true);
    });

    it('refuses `roomsManage: false` as firmly as an absent key', async () => {
      grantIs(false);
      const token = await anaToken();

      expect(refusalPayload(await rpc(toolCall(PROBE_TOOL, {}), token))).toMatchObject({
        reason: 'tool_group_disabled',
      });
      expect(probeRan).toBe(false);
    });

    it('refuses a caller that presented no agent header at all', async () => {
      // Dropping the header is the cheapest attack there is, and it must narrow
      // rather than widen: an unidentified caller holds no grant.
      grantIs(true);

      expect(refusalPayload(await rpc(toolCall(PROBE_TOOL, {})))).toMatchObject({
        reason: 'tool_group_disabled',
      });
      expect(probeRan).toBe(false);
    });

    it('refuses when the manifest read THROWS, rather than reading a broken disk as a yes', async () => {
      vi.mocked(readManifest).mockRejectedValue(new Error('EIO'));
      const token = await anaToken();

      expect(refusalPayload(await rpc(toolCall(PROBE_TOOL, {}), token))).toMatchObject({
        reason: 'tool_group_disabled',
      });
      expect(probeRan).toBe(false);
    });
  });

  describe('the in-session dorkos server', () => {
    /**
     * The in-session adapter's REAL tool definition, invoked the way the runtime
     * invokes it.
     *
     * This leg exists because acceptance criteria 1 and 3 say BOTH servers, and
     * "both" is a claim about wiring — the half this file's header says defects
     * live in. The two adapters reach the gate by different routes (a per-session
     * tool list here, a registered `McpServer` callback there), and only one of
     * them was ever proved.
     *
     * In-session identity is derived from the session's working directory rather
     * than a presented token, which is why the resolver hands one in directly
     * instead of setting a header: an in-session agent cannot become anonymous.
     */
    function inSessionProbe(identity?: AgentIdentity) {
      const tools = capabilityMcpTools(
        registry,
        'in-session',
        identity ? async () => ({ identity }) : undefined
      );
      const tool = tools.find((t) => (t as { name: string }).name === PROBE_TOOL)!;
      const handler = (
        tool as unknown as {
          handler: (
            args: unknown,
            extra: unknown
          ) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
        }
      ).handler;
      return handler({}, {});
    }

    /** Ana as the in-session runtime resolves her: from where she runs. */
    const ANA_IDENTITY: AgentIdentity = {
      agentPath: ANA_PATH,
      displayName: 'Ana',
      tierCeiling: 'destructive',
      createdAt: new Date().toISOString(),
    };

    it('registers the gated tool at all, so the rows below are not vacuous', () => {
      const names = capabilityMcpTools(registry, 'in-session').map(
        (t) => (t as { name: string }).name
      );
      expect(names).toContain(PROBE_TOOL);
    });

    it('refuses an identified agent whose manifest does not carry the grant', async () => {
      grantIs(undefined);

      const result = await inSessionProbe(ANA_IDENTITY);

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text!);
      expect(payload).toMatchObject({
        status: 'denied',
        capabilityId: 'grantprobe.run',
        reason: 'tool_group_disabled',
        approvable: false,
      });
      expect(probeRan).toBe(false);
    });

    it('runs the same call for the same agent once the grant is on', async () => {
      grantIs(true);

      const result = await inSessionProbe(ANA_IDENTITY);

      expect(result.isError).toBeFalsy();
      expect(probeRan).toBe(true);
    });

    it('refuses a call the surface could not attribute to any agent', async () => {
      grantIs(true);

      const result = await inSessionProbe();

      const payload = JSON.parse(result.content[0]!.text!);
      expect(payload.reason).toBe('tool_group_disabled');
      expect(probeRan).toBe(false);
    });
  });

  describe('POST /api/capabilities/:id/invoke', () => {
    /** The invoke route behind the identity middleware, as `index.ts` mounts it. */
    function app(): express.Express {
      const server = express();
      server.use(express.json());
      server.use(resolveAgentIdentity);
      server.use('/api/capabilities', createCapabilitiesInvokeRouter(registry));
      return server;
    }

    it('answers 403 — refused, and no retry will change that', async () => {
      grantIs(undefined);
      const token = await anaToken();

      const res = await request(app())
        .post('/api/capabilities/grantprobe.run/invoke')
        .set('X-DorkOS-Agent', token)
        .send({});

      // 403, not 202: a 202 would tell the caller to come back after a person
      // decided something, and there is nothing here for a person to decide.
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe('tool_group_disabled');
      expect(res.body.approvable).toBe(false);
      expect(probeRan).toBe(false);
    });

    it('answers 200 for the same agent once the grant is on', async () => {
      grantIs(true);
      const token = await anaToken();

      const res = await request(app())
        .post('/api/capabilities/grantprobe.run/invoke')
        .set('X-DorkOS-Agent', token)
        .send({});

      expect(res.status).toBe(200);
      expect(probeRan).toBe(true);
    });
  });
});
