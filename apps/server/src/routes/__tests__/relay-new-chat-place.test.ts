/**
 * @vitest-environment node
 *
 * Where a new chat started over relay opens (`POST /api/relay/messages`,
 * DOR-5209). A message from anyone but the person to an id nothing holds starts
 * a chat, so it opens where `POST /api/sessions/:id/messages` would open one
 * that names no folder: a verified agent's in its own home, run as itself, and
 * a place that route refuses is refused with the same answer. The server
 * carries the place in the sealed limits, so no caller can name or forge it.
 *
 * The launch service and the runtime registry run for real on a throwaway
 * database; only the bus and Mesh's list of homes are fakes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import { CARRIED_TURN_LIMITS_FIELD, isSealedTurnLimits, type RelayCore } from '@dorkos/relay';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { initBoundary } from '../../lib/boundary.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../services/core/agent-identity/__tests__/agent-home-fixture.js';
import { setSessionAgentSources } from '../../services/core/agent-identity/session-agent.js';
import { PROTECTED_DEFAULT_FOLDER_MESSAGE } from '../../services/session/launch/launch-caller.js';
import { CHAT_UNCHECKED_MESSAGE } from '../relay-chat-place.js';
import { createRelayRoutes } from '../relay.js';
import { relayWebhookBodyRule } from '../relay-webhooks.js';
import { mountSessionSendMessage } from '../session-send-message.js';
import { createMockRelayCore, target, useLoginOffConfig } from './relay/relay.fixtures.js';
import { registerClaudeCodeFacts } from '../../startup/register-claude-code-facts.js';

// The boot's own registration, so the protected-folder rule can read the account folders.
registerClaudeCodeFacts();
useLoginOffConfig();

const SOL_SUBJECT = 'relay.agent.claude-code.sol-id';
const ORI_SUBJECT = 'relay.agent.claude-code.ori-id';
/** Ids no runtime holds. */
const FRESH_CHAT = '00000000-0000-4000-8000-0000000052a1';
const FRESH_CHAT_TWO = '00000000-0000-4000-8000-0000000052a2';
/** A chat Sol runs. */
const SOL_CHAT = '00000000-0000-4000-8000-0000000052a3';
/** Test-only: the request comes from an agent whose token verified. */
const AGENT_HEADER = 'x-test-agent-path';
/** Test-only: that agent's token no longer counts, so DorkOS cannot name the caller. */
const INACTIVE_HEADER = 'x-test-agent-inactive';
/** The sender a local program names. */
const OUTSIDE_SENDER = 'relay.external.my-script';

let scratch: string;
let sol: string;
let ori: string;
let stray: string;
let db: Db;
let relayCore: RelayCore;
let runtime: FakeAgentRuntime;
/** Whether a second runtime's own store fails every lookup, as a stopped sidecar's does. */
let discoveryDown: boolean;

const mesh = {
  listWithPaths: () => [
    { id: 'sol-id', name: 'sol', projectPath: sol },
    { id: 'ori-id', name: 'ori', projectPath: ori },
  ],
  getProjectPath: (id: string) => ({ 'sol-id': sol, 'ori-id': ori })[id],
};

/** The Relay routes and the sessions message route on one `/api` chain. */
function mount(): void {
  const sessions = new Hono<ApiEnv>();
  mountSessionSendMessage(sessions, { meshCore: mesh as never });
  target.mount(
    honoGroupListener(
      [
        {
          path: '/api/relay',
          routes: createRelayRoutes({
            relayCore,
            isRoomSession: () => false,
            agentSubjectOf: (agentPath) =>
              agentPath === sol ? SOL_SUBJECT : agentPath === ori ? ORI_SUBJECT : undefined,
            chatMesh: () => mesh as never,
            agentSessions: () => ({ get: () => undefined, set: () => undefined }),
          }),
        },
        { path: '/api/sessions', routes: sessions },
      ],
      {
        bodyRules: [relayWebhookBodyRule],
        before: async (c, next) => {
          const agent = c.req.header(AGENT_HEADER);
          if (agent)
            c.set('agentIdentity', {
              agentPath: agent,
              displayName: 'Agent',
              createdAt: '',
              ...(c.req.header(INACTIVE_HEADER) ? { inactive: 'revoked' as const } : {}),
            });
          await next();
        },
      }
    )
  );
}

/** Send over relay to a chat's address. */
function send(
  sessionId: string,
  headers: Record<string, string> = {},
  payload: Record<string, unknown> = { content: 'hello' },
  from = 'relay.human.console'
) {
  return request(target.server)
    .post('/api/relay/messages')
    .set(headers)
    .send({ subject: `relay.agent.claude-code.${sessionId}`, payload, from });
}

/** Start a chat through the sessions route, naming no folder. */
function start(sessionId: string, headers: Record<string, string> = {}) {
  return request(target.server)
    .post(`/api/sessions/${sessionId}/messages`)
    .set(headers)
    .send({ content: 'hello', create: true });
}

/** The one message the bus was handed: its payload and its sender. */
function sent(): { payload: Record<string, unknown>; from: string } {
  expect(relayCore.publish).toHaveBeenCalledTimes(1);
  const [, payload, opts] = vi.mocked(relayCore.publish).mock.calls[0]!;
  return { payload: payload as Record<string, unknown>, from: (opts as { from: string }).from };
}

/** The payload the bus was handed. */
function published(): Record<string, unknown> {
  return sent().payload;
}

/** The sealed limits the bus was handed (empty when none), and the sender they went from. */
function stamp(): { carried: Record<string, unknown>; from: string } {
  const { payload, from } = sent();
  const carried = payload[CARRIED_TURN_LIMITS_FIELD] as Record<string, unknown> | undefined;
  return { carried: carried ?? {}, from };
}

/** The headers of a request from the agent at this home. */
const asAgent = (home: string) => ({ [AGENT_HEADER]: home });

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-new-chat-')));
  sol = path.join(scratch, 'agents', 'sol');
  ori = path.join(scratch, 'agents', 'ori');
  stray = path.join(scratch, 'agents', 'stray');
  for (const dir of [sol, ori, stray]) fs.mkdirSync(dir, { recursive: true });
  await initBoundary(scratch);
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  db = createTestDb();
  runtimeRegistry.setDb(db);
  runtime = new FakeAgentRuntime('claude-code');
  runtimeRegistry.register(runtime as never);
  discoveryDown = false;
  const sidecar: FakeAgentRuntime & { findSession?: (id: string) => Promise<null> } =
    new FakeAgentRuntime('sidecar-test');
  sidecar.findSession = async () => {
    if (discoveryDown) throw new Error('store unreadable');
    return null;
  };
  runtimeRegistry.register(sidecar as never);
  registerTestHomes([sol, ori, stray]);
  setSessionAgentSources({ liveCwd: () => undefined });
  relayCore = createMockRelayCore();
  mount();
});

afterEach(() => {
  setSessionAgentSources(undefined);
  clearTestHomes();
  vi.unstubAllEnvs();
});

describe("a verified agent's new chat over relay", () => {
  it('opens in its own home and runs as itself, sealed for its own address', async () => {
    const res = await send(FRESH_CHAT, asAgent(sol));
    expect(res.status).toBe(200);
    const { carried, from } = stamp();
    expect(from).toBe(SOL_SUBJECT);
    expect(carried.newChat).toEqual({ sessionKey: FRESH_CHAT, cwd: sol, forAgent: sol });
    expect(isSealedTurnLimits(from, carried)).toBe(true);
  });

  it('opens where the sessions route opens the same agent’s new chat', async () => {
    await send(FRESH_CHAT, asAgent(sol));
    const sessions = await start(FRESH_CHAT_TWO, asAgent(sol));
    expect(sessions.status).toBe(202);
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalled());
    const opts = vi.mocked(runtime.sendMessage).mock.calls[0]![2] as {
      cwd?: string;
      forAgent?: string;
    };
    const placed = (stamp().carried.newChat ?? {}) as { cwd?: string; forAgent?: string };
    expect(placed.cwd).toEqual(expect.any(String));
    expect({ cwd: placed.cwd, forAgent: placed.forAgent }).toEqual({
      cwd: opts.cwd,
      forAgent: opts.forAgent,
    });
  });

  it('never takes a folder or an agent from its own payload', async () => {
    const res = await send(FRESH_CHAT, asAgent(sol), {
      content: 'hello',
      cwd: ori,
      forAgent: ori,
    });
    expect(res.status).toBe(200);
    expect(published()).not.toHaveProperty('cwd');
    expect(published()).not.toHaveProperty('forAgent');
    expect(stamp().carried.newChat).toEqual({ sessionKey: FRESH_CHAT, cwd: sol, forAgent: sol });
  });

  it('drops a place written into the payload, and carries only the server’s', async () => {
    const forged = { newChat: { sessionKey: FRESH_CHAT, cwd: ori, forAgent: ori }, seal: 'x' };
    const res = await send(FRESH_CHAT, asAgent(sol), {
      content: 'hello',
      [CARRIED_TURN_LIMITS_FIELD]: forged,
    });
    expect(res.status).toBe(200);
    const { carried, from } = stamp();
    expect(carried.newChat).toEqual({ sessionKey: FRESH_CHAT, cwd: sol, forAgent: sol });
    expect(isSealedTurnLimits(from, carried)).toBe(true);
  });

  it('carries no place into a chat it already runs', async () => {
    db.insert(sessionMetadata)
      .values({
        sessionId: SOL_CHAT,
        runtime: 'claude-code',
        agentPath: sol,
        createdAt: new Date().toISOString(),
      })
      .run();
    const res = await send(SOL_CHAT, asAgent(sol));
    expect(res.status).toBe(200);
    expect(published()[CARRIED_TURN_LIMITS_FIELD]).toBeUndefined();
  });

  it("carries no place on a message to another agent's own address", async () => {
    const res = await request(target.server)
      .post('/api/relay/messages')
      .set(asAgent(sol))
      .send({ subject: ORI_SUBJECT, payload: { content: 'hello' }, from: 'relay.human.console' });
    expect(res.status).toBe(200);
    expect(published()[CARRIED_TURN_LIMITS_FIELD]).toBeUndefined();
  });

  it('asks the runtimes once whether the chat is held, then places it', async () => {
    const lookup = vi.spyOn(runtimeRegistry, 'resolveSessionRuntime');
    try {
      const res = await send(FRESH_CHAT, asAgent(sol));
      expect(res.status).toBe(200);
      // Once to read who holds it, and once by the folder chain the sessions route shares.
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      lookup.mockRestore();
    }
  });

  it("is refused, saying the check couldn't be made, while a runtime's store can't be read", async () => {
    discoveryDown = true;
    const res = await send(FRESH_CHAT, asAgent(sol));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'desk_not_own', detail: CHAT_UNCHECKED_MESSAGE });
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });
});

/** The server's default stands in for home here, so it is a protected folder (DOR-4060). */
describe('a new chat when the default folder is protected', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', DEFAULT_CWD);
    vi.stubEnv('DORK_HOME', `${DEFAULT_CWD}/.dork-fixture-5209`);
    vi.stubEnv('CLAUDE_CONFIG_DIR', `${DEFAULT_CWD}/.claude-fixture-5209`);
  });

  it('refuses a caller DorkOS cannot name, with the sessions route’s own answer', async () => {
    const nobody = { ...asAgent(sol), [INACTIVE_HEADER]: '1' };
    const relay = await send(FRESH_CHAT, nobody, { content: 'hello' }, OUTSIDE_SENDER);
    const sessions = await start(FRESH_CHAT_TWO, nobody);
    expect(relay.status).toBe(403);
    expect(relay.body).toMatchObject({
      code: 'protected_folder',
      detail: PROTECTED_DEFAULT_FOLDER_MESSAGE,
    });
    expect({ status: relay.status, body: relay.body }).toEqual({
      status: sessions.status,
      body: sessions.body,
    });
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it('refuses a verified agent Mesh does not list, as the sessions route does', async () => {
    const asStray = asAgent(stray);
    const relay = await send(FRESH_CHAT, asStray);
    const sessions = await start(FRESH_CHAT_TWO, asStray);
    expect(relay.status).toBe(403);
    expect(relay.body.code).toBe('protected_folder');
    expect({ status: relay.status, body: relay.body }).toEqual({
      status: sessions.status,
      body: sessions.body,
    });
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it("refuses a caller DorkOS cannot name while a runtime's store can't be read, as the sessions route does", async () => {
    discoveryDown = true;
    const nobody = { ...asAgent(sol), [INACTIVE_HEADER]: '1' };
    const relay = await send(FRESH_CHAT, nobody, { content: 'hello' }, OUTSIDE_SENDER);
    const sessions = await start(FRESH_CHAT_TWO, nobody);
    expect(relay.status).toBe(403);
    expect(relay.body.code).toBe('protected_folder');
    expect({ status: relay.status, body: relay.body }).toEqual({
      status: sessions.status,
      body: sessions.body,
    });
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it("refuses a caller DorkOS cannot name a person's address before asking about the chat", async () => {
    const nobody = { ...asAgent(sol), [INACTIVE_HEADER]: '1' };
    const res = await send(FRESH_CHAT, nobody, { content: 'hello' }, 'relay.human.console');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it("still opens a listed agent's chat in its own home", async () => {
    const res = await send(FRESH_CHAT, asAgent(sol));
    expect(res.status).toBe(200);
    expect(stamp().carried.newChat).toEqual({ sessionKey: FRESH_CHAT, cwd: sol, forAgent: sol });
  });

  it("leaves the person's message as it was", async () => {
    const res = await send(FRESH_CHAT, {}, { content: 'hello', cwd: sol });
    expect(res.status).toBe(200);
    expect(published()).toEqual({ content: 'hello', cwd: sol });
  });
});
