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
import request, { type Response } from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

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
import {
  composeRegistry,
  defineCapability,
  initPermissionGate,
  resetPermissionGate,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import { roomsDomain } from '../../services/rooms/room-capabilities.js';
import { createCapabilityMcpClient } from '../../services/runtimes/claude-code/mcp-tools/__tests__/capability-mcp-client.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import {
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../services/rooms/__tests__/room-test-harness.js';
import {
  ANA_PATH,
  agents,
  anaTokenIn,
  DEAD_TOKEN_STATES,
  deadTokenIn,
  invokeApp,
  jsonRpc,
  mcpApp,
  mcpErrorPayload,
  mcpRpc,
  PROBLEM_CODE,
  REFUSAL_CODE,
  refusalText,
  toolCall,
  type DeadTokenState,
} from './room-capabilities-unverified-agent.fixtures.js';

const fixtureTarget = swappableServer();

describe('an unverifiable agent token on the rooms capability surfaces', () => {
  let harness: RoomHarness;
  let registry: CapabilityRegistry;
  let roomId: string;
  let ownerAuthorId: string;

  beforeEach(async () => {
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
    // That post wakes Ana (she answers everything), and her turn's claim moves
    // her read cursor past it. Wait for that turn: until it runs, Ana has not
    // read the note, so her own post below is held as stale (`posted: false`,
    // no entryId) rather than written, and the rows that post as Ana flaked
    // on which got there first.
    await harness.service.triggersIdle();
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /** A token that really does resolve to Ana, and one dead in `state` (see `deadTokenIn`). */
  const anaToken = () => anaTokenIn(harness);
  const deadToken = (state: DeadTokenState) => deadTokenIn(harness, state);

  /** How many entries the room holds — what a refused post must not change. */
  function entryCount(): number {
    return harness.service.readHistory(roomId, ownerAuthorId, { limit: 50 }).length;
  }

  describe('POST /api/capabilities/:id/invoke', () => {
    /** The invoke route behind the `/api` chain, which resolves the agent identity. */
    const app = () => invokeApp(registry);

    it.each(DEAD_TOKEN_STATES)('refuses rooms.post for a %s token', async (state) => {
      const refused = await request(fixtureTarget.mount(app()))
        .post('/api/capabilities/rooms.post/invoke')
        .set('X-DorkOS-Agent', await deadToken(state))
        .send({ roomId, text: 'as you, apparently' });

      // Refused, and by WHICHEVER gate got there first: a revoked identity is
      // capped at `observe`, so the tier gate turns an `act` verb away (403,
      // `forbidden`) before `callerAuthor` runs; the other two states reach
      // `callerAuthor` and get its 401. Asserting one code would pin the order
      // the gates happen to run in rather than the property (DOR-486).
      expect(refused.status).not.toBe(200);
      // Either this seam's own code, or the tier gate's `forbidden` because it
      // answered first. Asserting the value itself rather than
      // a ternary over it — the ternary was a tautology that could not fail.
      expect(['agent_identity_unverified', 'forbidden']).toContain(refused.body.code);
      expect(refused.body.posted).toBeUndefined();
      // The half that matters: nothing was written under anybody's name.
      expect(entryCount()).toBe(1);
    });

    it('posts as the operator with no header at all, which is the control', () => {
      // The header is the ONLY difference. Without this the refusals above would
      // also pass for a route that was simply broken.
      return request(fixtureTarget.mount(app()))
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
        const refused = await request(fixtureTarget.mount(app()))
          .post('/api/capabilities/rooms.read_history/invoke')
          .set('X-DorkOS-Agent', await deadToken(state))
          .send({ roomId, limit: 5 });

        expect(refused.status).toBe(401);
        expect(refused.body.code).toBe(PROBLEM_CODE);
        expect(refused.body).not.toHaveProperty('entries');
        expect(JSON.stringify(refused.body)).not.toContain('a private note');
      }
    );

    it('still lets a token that resolves act as its own agent', async () => {
      const token = await anaToken();

      const res = await request(fixtureTarget.mount(app()))
        .post('/api/capabilities/rooms.post/invoke')
        .set('X-DorkOS-Agent', token)
        .send({ roomId, text: 'on it' });

      expect(res.status).toBe(200);
      // Posted, not held: a held post is a 200 too, with no entry to find.
      expect(res.body.posted).toBe(true);
      const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
      expect(harness.store.getEntryById(roomId, res.body.entryId)?.authorId).toBe(anaAuthorId);
    });
  });

  describe('the external /mcp server', () => {
    /** One JSON-RPC message to the real external `/mcp` server (see `mcpRpc`). */
    const rpc = (body: Record<string, unknown>, token?: string) =>
      mcpRpc(fixtureTarget.mount(mcpApp(registry)), body, token);

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
      // Posted, not held: a held post is not an error either.
      expect(JSON.parse(jsonRpc(res).result!.content![0]!.text!)).toMatchObject({ posted: true });
      const anaAuthorId = harness.authors.resolveAgent(ANA_PATH, 'Ana').id;
      const posted = harness.service.readHistory(roomId, ownerAuthorId, { limit: 5 });
      expect(posted.find((entry) => entry.body.text === 'on it')?.authorId).toBe(anaAuthorId);
    });
  });
});

/**
 * The Rooms permission, over the SAME real surfaces (spec `agent-permissions`
 * D6; the boundary the retired DOR-1611 grant used to draw).
 *
 * It lives in this file for the reason the header above gives about the rooms
 * refusal: the registry-level tests hand `identity` straight in, and the defect
 * class that matters is in the WIRING. A permission proved only at
 * `registry.invoke` would say nothing about whether the external `/mcp` server
 * reaches that gate, or about what a refusal looks like once it has been through
 * the MCP envelope.
 *
 * The subject is a probe capability in the Rooms area, composed beside the rooms
 * domain onto the same server, through the same adapters: the boundary is a
 * property of `registry.invoke` and its adapters, not of the rooms domain.
 *
 * The install's config has Rooms set to Blocked by a person (Full power lifts
 * it), and the agent's own setting comes from a reader this file moves.
 */
describe('a capability in the Rooms permission area, on the real surfaces', () => {
  let harness: RoomHarness;
  let registry: CapabilityRegistry;
  /** Set by the probe's handler. Must stay false for every refused row. */
  let probeRan = false;
  /** The install's preset, moved per test. */
  let preset: 'full' | null = null;
  /** What the agent's manifest says about Rooms, or a read that throws. */
  let agentRooms: 'allowed' | 'blocked' | undefined | Error = undefined;

  /** The probe's MCP tool name, as the external adapter registers it. */
  const PROBE_TOOL = 'grant_probe';

  /** A capability in the Rooms area and nothing else remarkable. */
  const probeDomain = {
    name: 'grantprobe',
    capabilities: [
      defineCapability({
        id: 'grantprobe.run',
        title: 'Grant probe',
        description: 'A fixture capability standing in for the rooms-management verbs.',
        tier: 'act' as const,
        area: 'rooms' as const,
        input: z.object({}),
        output: z.unknown(),
        surfaces: {
          mcp: { toolName: PROBE_TOOL, servers: ['in-session' as const, 'external' as const] },
        },
        invoke: async () => {
          probeRan = true;
          return { ok: true };
        },
      }),
    ],
  };

  /** Point the agent's Rooms setting at a state for the next call. */
  function grantIs(state?: boolean): void {
    agentRooms = state === undefined ? undefined : state ? 'allowed' : 'blocked';
  }

  beforeEach(() => {
    probeRan = false;
    installState.ownerId = null;
    installState.loginEnabled = false;
    resetAgentIdentityService();
    preset = null;
    agentRooms = undefined;
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    initAgentIdentityService(harness.db);
    registry = composeRegistry([roomsDomain, probeDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    initPermissionGate({
      readConfig: () => ({
        preset,
        defaults: {
          areas: preset === 'full' ? {} : ({ rooms: 'blocked' } as Record<string, 'blocked'>),
          actions: {},
        },
      }),
      readAgentPermissions: async () => {
        if (agentRooms instanceof Error) throw agentRooms;
        return agentRooms ? { areas: { rooms: agentRooms } } : undefined;
      },
    });
  });

  afterEach(() => {
    resetAgentIdentityService();
    resetPermissionGate();
  });

  /** A token that really does resolve to Ana. */
  const anaToken = () => anaTokenIn(harness);

  describe('the external /mcp server', () => {
    /** One JSON-RPC message to the real external `/mcp` server (see `mcpRpc`). */
    const rpc = (body: Record<string, unknown>, token?: string) =>
      mcpRpc(fixtureTarget.mount(mcpApp(registry)), body, token);

    /** The gate's structured payload, read out of the MCP envelope. */
    function refusalPayload(res: Response): Record<string, unknown> {
      const body = jsonRpc(res);
      // NOT `isError`. A refusal is a step in a protocol, not a crash, and the
      // model has to read the sentence rather than treat it as a tool failure.
      expect(body.result?.isError).toBeFalsy();
      return JSON.parse(body.result!.content![0]!.text!);
    }

    it('refuses an identified agent that inherits Rooms Blocked', async () => {
      grantIs(undefined);
      const token = await anaToken();

      const payload = refusalPayload(await rpc(toolCall(PROBE_TOOL, {}), token));

      expect(payload).toMatchObject({
        status: 'denied',
        capabilityId: 'grantprobe.run',
        reason: 'permission_blocked',
        // A person could say yes, but only if the agent asks on purpose: the
        // direct call raises no card and names the request tool instead.
        approvable: true,
      });
      expect(String(payload.message)).toContain('Rooms is blocked');
      expect(String(payload.message)).toContain('request_permission');
      expect(probeRan).toBe(false);
    });

    it('runs the same call for the same agent once its Rooms is Allowed', async () => {
      // The discrimination pair. The ONLY difference between this row and the one
      // above is the value in the manifest — without it, a refusal would also pass
      // for a tool that was simply broken.
      grantIs(true);
      const token = await anaToken();

      const res = await rpc(toolCall(PROBE_TOOL, {}), token);

      expect(jsonRpc(res).result?.isError).toBeFalsy();
      expect(probeRan).toBe(true);
    });

    it('refuses an agent set to Blocked even when the defaults allow Rooms', async () => {
      grantIs(false);
      preset = 'full';
      const token = await anaToken();

      expect(refusalPayload(await rpc(toolCall(PROBE_TOOL, {}), token))).toMatchObject({
        reason: 'permission_blocked',
      });
      expect(probeRan).toBe(false);
    });

    it('gives a caller that presented no agent header the defaults, never the agent layer', async () => {
      // Dropping the header must never reach an agent's own Allowed (spec D11):
      // an unidentified caller resolves against the install's defaults only,
      // which are Blocked here.
      grantIs(true);

      expect(refusalPayload(await rpc(toolCall(PROBE_TOOL, {})))).toMatchObject({
        reason: 'permission_blocked',
      });
      expect(probeRan).toBe(false);
    });

    it('refuses when the manifest read THROWS, rather than reading a broken disk as a yes', async () => {
      agentRooms = new Error('EIO');
      preset = 'full';
      const token = await anaToken();

      expect(refusalPayload(await rpc(toolCall(PROBE_TOOL, {}), token))).toMatchObject({
        reason: 'permission_blocked',
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
    async function inSessionProbe(identity?: AgentIdentity) {
      const { tools } = await createCapabilityMcpClient(
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
      createdAt: new Date().toISOString(),
    };

    it('registers the gated tool at all, so the rows below are not vacuous', async () => {
      const names = (await createCapabilityMcpClient(registry, 'in-session')).tools.map(
        (t) => (t as { name: string }).name
      );
      expect(names).toContain(PROBE_TOOL);
    });

    it('refuses an identified agent that inherits Rooms Blocked', async () => {
      grantIs(undefined);

      const result = await inSessionProbe(ANA_IDENTITY);

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text!);
      expect(payload).toMatchObject({
        status: 'denied',
        capabilityId: 'grantprobe.run',
        reason: 'permission_blocked',
        approvable: true,
      });
      expect(probeRan).toBe(false);
    });

    it('runs the same call for the same agent once its Rooms is Allowed', async () => {
      grantIs(true);

      const result = await inSessionProbe(ANA_IDENTITY);

      expect(result.isError).toBeFalsy();
      expect(probeRan).toBe(true);
    });

    it('refuses a call the surface could not attribute to any agent', async () => {
      grantIs(true);

      const result = await inSessionProbe();

      const payload = JSON.parse(result.content[0]!.text!);
      expect(payload.reason).toBe('permission_blocked');
      expect(probeRan).toBe(false);
    });
  });

  describe('POST /api/capabilities/:id/invoke', () => {
    /** The invoke route behind the `/api` chain, which resolves the agent identity. */
    const app = () => invokeApp(registry);

    it('answers 403 — refused, with no card minted', async () => {
      grantIs(undefined);
      const token = await anaToken();

      const res = await request(fixtureTarget.mount(app()))
        .post('/api/capabilities/grantprobe.run/invoke')
        .set('X-DorkOS-Agent', token)
        .send({});

      // 403, not 202: a direct call raises no card, so there is nothing to come
      // back for. The agent may ask on purpose, with the request tool.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.approvable).toBe(true);
      expect(probeRan).toBe(false);
    });

    it('answers 200 for the same agent once its Rooms is Allowed', async () => {
      grantIs(true);
      const token = await anaToken();

      const res = await request(fixtureTarget.mount(app()))
        .post('/api/capabilities/grantprobe.run/invoke')
        .set('X-DorkOS-Agent', token)
        .send({});

      expect(res.status).toBe(200);
      expect(probeRan).toBe(true);
    });
  });
});
