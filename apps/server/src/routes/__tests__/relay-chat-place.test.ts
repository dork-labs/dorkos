/**
 * @vitest-environment node
 *
 * Where a relay message into a chat may go (`POST /api/relay/messages`,
 * DOR-5200). A subject that names a chat starts or feeds a turn there, so an
 * agent whose token verified meets the sessions route's own place rule and
 * gets its answer: its own chat goes through, another agent's chat does not.
 * A message to an agent's own address, and anything the person sends, are
 * unchanged.
 *
 * The runtime registry runs on a real throwaway database, so "a chat" is a
 * real binding row; only the bus and Mesh's list of homes are fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import type { RelayCore } from '@dorkos/relay';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../services/core/agent-identity/__tests__/agent-home-fixture.js';
import { setSessionAgentSources } from '../../services/core/agent-identity/session-agent.js';
import { OTHER_AGENTS_CHAT_MESSAGE } from '../../services/session/launch/launch-caller.js';
import { createRelayRoutes } from '../relay.js';
import { relayWebhookBodyRule } from '../relay-webhooks.js';
import { registerSessionQueueRoutes } from '../session-queue-handler.js';
import { createMockRelayCore, target, useLoginOffConfig } from './relay/relay.fixtures.js';

useLoginOffConfig();

const JUNO = '/made-up/agents/juno';
const RIO = '/made-up/agents/rio';
const RIO_SUBJECT = 'relay.agent.default.rio';
const JUNO_SUBJECT = 'relay.agent.default.juno';
/** A chat the person started with Juno. */
const PERSON_CHAT = '00000000-0000-4000-8000-00000000a001';
/** A chat Juno runs that recorded no agent, standing in Juno's home. */
const JUNO_CHAT = '00000000-0000-4000-8000-00000000a002';
/** A chat Rio runs. */
const RIO_CHAT = '00000000-0000-4000-8000-00000000a003';
/** An id no runtime holds. */
const FRESH_CHAT = '00000000-0000-4000-8000-00000000a004';
/** Test-only: the request comes from an agent whose token verified. */
const AGENT_HEADER = 'x-test-agent-path';
/** Test-only: that agent's token no longer counts (revoked or expired). */
const INACTIVE_HEADER = 'x-test-agent-inactive';

const mesh = {
  listWithPaths: () => [
    { id: 'juno-id', name: 'juno', projectPath: JUNO },
    { id: 'rio-id', name: 'rio', projectPath: RIO },
  ],
  getProjectPath: (id: string) => ({ 'juno-id': JUNO, 'rio-id': RIO })[id],
};

let db: Db;
let live: Record<string, string>;
let relayCore: RelayCore;

/** Bind a chat as a launch binds it. */
function chat(sessionId: string, agentPath: string | null, runningIn?: string): void {
  db.insert(sessionMetadata)
    .values({ sessionId, runtime: 'claude-code', agentPath, createdAt: new Date().toISOString() })
    .run();
  if (runningIn) live[sessionId] = runningIn;
}

/** The Relay routes and the sessions queue routes on one `/api` chain. */
function mount(): void {
  const sessions = new Hono<ApiEnv>();
  registerSessionQueueRoutes(sessions, mesh as never);
  target.mount(
    honoGroupListener(
      [
        {
          path: '/api/relay',
          routes: createRelayRoutes({
            relayCore,
            isRoomSession: () => false,
            agentSubjectOf: (agentPath) =>
              agentPath === RIO ? RIO_SUBJECT : agentPath === JUNO ? JUNO_SUBJECT : undefined,
            chatMesh: () => mesh as never,
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

function send(subject: string, headers: Record<string, string> = {}, from = 'relay.human.console') {
  return request(target.server)
    .post('/api/relay/messages')
    .set(headers)
    .send({ subject, payload: { content: 'hello' }, from });
}

const asRio = { [AGENT_HEADER]: RIO };

beforeEach(() => {
  db = createTestDb();
  runtimeRegistry.setDb(db);
  live = {};
  registerTestHomes([JUNO, RIO]);
  setSessionAgentSources({ liveCwd: (sessionId) => live[sessionId] });
  relayCore = createMockRelayCore();
  chat(PERSON_CHAT, JUNO, JUNO);
  chat(JUNO_CHAT, null, JUNO);
  chat(RIO_CHAT, RIO, RIO);
  mount();
});

afterEach(() => {
  setSessionAgentSources(undefined);
  clearTestHomes();
});

describe("a verified agent's message into a chat", () => {
  it("refuses the person's chat with another agent, as the sessions route does", async () => {
    const res = await send(`relay.agent.claude-code.${PERSON_CHAT}`, asRio);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: OTHER_AGENTS_CHAT_MESSAGE, code: 'DESK_NOT_OWN' });
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it("refuses another agent's chat, read from its folder when it recorded no agent", async () => {
    const res = await send(`relay.agent.claude-code.${JUNO_CHAT}`, asRio);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESK_NOT_OWN');
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it('refuses the three-token form of a chat’s address too', async () => {
    const res = await send(`relay.agent.${PERSON_CHAT}`, asRio);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESK_NOT_OWN');
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it('refuses the chat however the address is shaped', async () => {
    const res = await send(`relay.agent.default.${PERSON_CHAT}`, asRio);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DESK_NOT_OWN');
    expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
  });

  it('delivers to a chat address no runtime holds yet, as before', async () => {
    const res = await send(`relay.agent.claude-code.${FRESH_CHAT}`, asRio);
    expect(res.status).toBe(200);
  });

  it('delivers into its own chat, from its own address', async () => {
    const res = await send(`relay.agent.claude-code.${RIO_CHAT}`, asRio);
    expect(res.status).toBe(200);
    expect(vi.mocked(relayCore.publish)).toHaveBeenCalledWith(
      `relay.agent.claude-code.${RIO_CHAT}`,
      expect.anything(),
      expect.objectContaining({ from: RIO_SUBJECT })
    );
  });

  it("delivers into the person's chat with it, which is its own chat too", async () => {
    const res = await send(`relay.agent.claude-code.${PERSON_CHAT}`, { [AGENT_HEADER]: JUNO });
    expect(res.status).toBe(200);
  });

  it("delivers a message to another agent's own address", async () => {
    const res = await send(JUNO_SUBJECT, asRio);
    expect(res.status).toBe(200);
    expect(vi.mocked(relayCore.publish)).toHaveBeenCalledWith(
      JUNO_SUBJECT,
      expect.anything(),
      expect.objectContaining({ from: RIO_SUBJECT })
    );
  });

  it('delivers to an address Mesh knows as an agent, even in a chat’s shape', async () => {
    chat('juno-id', JUNO, JUNO);
    const res = await send('relay.agent.juno-id', asRio);
    expect(res.status).toBe(200);
  });

  it('answers exactly as the sessions route answers the same agent about the same chat', async () => {
    for (const sessionId of [PERSON_CHAT, JUNO_CHAT]) {
      const relay = await send(`relay.agent.claude-code.${sessionId}`, asRio);
      const sessions = await request(target.server)
        .delete(`/api/sessions/${sessionId}/queue/waiting-1`)
        .set(asRio);
      expect(sessions.status).toBe(403);
      expect({ status: relay.status, body: relay.body }).toEqual({
        status: sessions.status,
        body: sessions.body,
      });
    }
  });
});

describe('a caller DorkOS cannot name', () => {
  // Not asked by this rule: how far such a caller may reach is decided apart from it,
  // so this records today's answer and keeps this change from moving it.
  it('keeps the answer it had, sent from the outside address', async () => {
    const res = await send(
      `relay.agent.claude-code.${PERSON_CHAT}`,
      { ...asRio, [INACTIVE_HEADER]: '1' },
      'relay.external.my-script'
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(relayCore.publish)).toHaveBeenCalledWith(
      `relay.agent.claude-code.${PERSON_CHAT}`,
      expect.anything(),
      expect.objectContaining({ from: 'relay.external.http' })
    );
  });
});

describe("the person's message into a chat", () => {
  it('is delivered into any chat, as before', async () => {
    const res = await send(`relay.agent.claude-code.${PERSON_CHAT}`);
    expect(res.status).toBe(200);
    expect(vi.mocked(relayCore.publish)).toHaveBeenCalledWith(
      `relay.agent.claude-code.${PERSON_CHAT}`,
      expect.anything(),
      expect.objectContaining({ from: 'relay.human.console' })
    );
  });
});
