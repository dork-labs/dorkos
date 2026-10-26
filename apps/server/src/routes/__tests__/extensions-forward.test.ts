/**
 * `api.forward` on the server (DOR-3325): what the person typed in a mini app
 * reaches the agent they picked for it, in their Direct chat, as their own
 * words, and the agent's answers come back to the app under the agent's name.
 *
 * The refusals are the point. Each case that must send nothing checks the
 * Direct chat afterwards, so "refused" means the message is not there, not
 * just that the status was 403.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const state = vi.hoisted(() => ({
  authEnabled: true,
  ownerId: 'acct-owner' as string | null,
  extensions: {} as Record<string, unknown>,
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: state.authEnabled };
      if (key === 'extensions') return state.extensions;
      return null;
    },
    set: (key: string, value: unknown) => {
      if (key === 'extensions') state.extensions = value as Record<string, unknown>;
    },
  },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
}));
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');
vi.stubEnv('DORKOS_CORS_ORIGIN', 'https://evil.example');
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, auditEvents, type Db } from '@dorkos/db';
import { eq } from 'drizzle-orm';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createExtensionsRoutes } from '../extensions.js';
import { scriptedRunner } from '../../services/rooms/__tests__/room-test-harness.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomService,
} from '../../services/rooms/index.js';
import { wireDirectChats, type DirectChats } from '../../services/rooms/direct-chat/index.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { matchWifiRefusedRoute } from '../../services/core/auth/sessions/wifi-level.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import type { RoomTurnRequest } from '../../services/rooms/room-turn-port.js';
import { setEntryMarksStore } from '../../services/core/turn-power/turn-levels.js';
import { createEntryMarksStore } from '../../services/rooms/limits/entry-marks-store.js';
import { createRoomMessageLookup } from '../../services/rooms/session-bindings/room-message-lookup.js';
import { refuseForward } from '../extensions-forward.js';

const target = swappableServer();
const server = target.server;
const TRUSTED_ORIGIN = 'http://localhost:7777';
const APP = { Origin: TRUSTED_ORIGIN, 'X-Client-Id': 'web-test' };
const ANA_PATH = '/agents/ana';
const ANA_ID = 'ULID_ANA';
const BO_PATH = '/agents/bo';
const BO_ID = 'ULID_BO';
const FORWARD = '/api/extensions/desk/forward';

afterAll(() => vi.unstubAllEnvs());

let db: Db;
let service: RoomService;
let chats: DirectChats;
let roomStore: ReturnType<typeof createRoomSubsystem>['store'];
let ownerAuthorId: string;
let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
let statusOf: Record<string, string>;
/** Every turn a post started, with the ceiling it ran under. */
const turns: RoomTurnRequest[] = [];

/** Register an agent with Mesh's table, so the room can resolve it. */
function registerAgent(id: string, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id,
      name,
      displayName: name[0]!.toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

/** The Mesh the route reads: two agents, by id. */
const mesh = {
  get: (id: string) =>
    id === ANA_ID
      ? { name: 'ana', displayName: 'Ana' }
      : id === BO_ID
        ? { name: 'bo', displayName: 'Bo' }
        : undefined,
  getProjectPath: (id: string) => (id === ANA_ID ? ANA_PATH : id === BO_ID ? BO_PATH : undefined),
};

/** Pick the agent the desk mini app forwards to. */
function pick(agentId: string): void {
  state.extensions = { ...state.extensions, forwardAgent: { desk: agentId } };
}

/** Every post in an agent's Direct chat, oldest first. */
function dmPosts(agentPath = ANA_PATH, name = 'Ana'): RoomEntry[] {
  const chat = chats.ensureForAgent(agentPath, name);
  return service.readHistory(chat.roomId, ownerAuthorId, { limit: 200 });
}

/** The audit rows forwards wrote. */
function forwardAudits() {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, 'extension.person_forward'))
    .all();
}

beforeEach(async () => {
  state.authEnabled = true;
  state.ownerId = 'acct-owner';
  state.extensions = {};
  signedInUser = { userId: 'acct-owner', credential: 'cookie' };
  turns.length = 0;
  statusOf = { desk: 'compiled', off: 'disabled', plain: 'compiled' };
  db = createTestDb();
  registerAgent(ANA_ID, 'ana', ANA_PATH);
  registerAgent(BO_ID, 'bo', BO_PATH);
  const subsystem = createRoomSubsystem({
    db,
    turns: scriptedRunner((request) => {
      turns.push(request);
      return null;
    }),
  });
  service = subsystem.service;
  roomStore = subsystem.store;
  setRoomService(service);
  setEntryMarksStore(createEntryMarksStore(db));
  chats = wireDirectChats({
    store: subsystem.store,
    authors: subsystem.authors,
    rooms: subsystem.service,
  });
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
  ownerAuthorId = subsystem.authors.bindOwner('acct-owner').id;

  const manager = {
    get: (id: string) =>
      statusOf[id]
        ? {
            id,
            status: statusOf[id],
            manifest: {
              id,
              name: id === 'desk' ? 'Dorian Desk' : 'Other',
              version: '1.0.0',
              // `plain` never asks to forward.
              ...(id === 'plain' ? {} : { capabilities: { forward: true } }),
            },
          }
        : undefined,
    listPublic: () => [],
  };
  target.mount(
    honoGroupListener(
      {
        path: '/api/extensions',
        routes: createExtensionsRoutes({
          manager: manager as never,
          dorkHome: '/tmp/unused',
          getCwd: () => null,
          mesh: () => mesh,
        }),
      },
      {
        before: async (c, next) => {
          if (signedInUser) c.set('user', signedInUser as never);
          if (c.req.header('x-test-via') === 'wifi') markIngress(c.env.incoming, 'wifi');
          await next();
        },
      }
    )
  );
});

afterEach(() => {
  resetAuditTrail();
  setEntryMarksStore(null);
});

describe('forwarding a comment', () => {
  it('posts only the typed words into the Direct chat as the person, with the app and item beside them', async () => {
    pick(ANA_ID);
    const res = await request(server)
      .post(FORWARD)
      .set(APP)
      .send({ text: 'Yes, pay it.', itemId: 'item-7', itemTitle: 'Pay the Fly invoice' });

    expect(res.status).toBe(201);
    expect(res.body.agent).toEqual({ id: ANA_ID, name: 'Ana' });
    const posts = dmPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: res.body.id,
      authorId: ownerAuthorId,
      body: {
        text: 'Yes, pay it.',
        via: {
          extensionId: 'desk',
          appName: 'Dorian Desk',
          itemId: 'item-7',
          itemTitle: 'Pay the Fly invoice',
        },
      },
    });
  });

  it('wakes the agent at the person’s own level, with no outsider mark', async () => {
    pick(ANA_ID);
    const res = await request(server)
      .post(FORWARD)
      .set(APP)
      .send({ text: 'Go ahead.', itemId: 'item-1' });
    await service.triggersIdle();

    expect(res.status).toBe(201);
    const turn = turns.find((t) => t.entry.id === res.body.id);
    expect(turn).toBeDefined();
    // A mini app's own words (`ctx.agent.send`, or an `api.rooms` reply) cap
    // this at the runtime default. A person's forward must not.
    expect(turn?.permissionCeiling).toBeUndefined();
    expect(createEntryMarksStore(db).read(turn!.entry.roomId, res.body.id)).toBeNull();
  });

  it('holds a forward from Wi-Fi to the default, as a person’s own post from Wi-Fi is', async () => {
    pick(ANA_ID);
    const res = await request(server)
      .post(FORWARD)
      .set(APP)
      .set('x-test-via', 'wifi')
      .send({ text: 'From the phone.', itemId: 'item-1' });
    await service.triggersIdle();

    expect(res.status).toBe(201);
    const turn = turns.find((t) => t.entry.id === res.body.id);
    expect(turn?.permissionCeiling).toBe('runtime-default');
  });

  it('sends to the picked agent whatever else the body names', async () => {
    pick(ANA_ID);
    const res = await request(server)
      .post(FORWARD)
      .set(APP)
      .send({ text: 'hi', itemId: 'i', to: BO_ID });

    // An unknown field is refused outright, so nothing can steer the target.
    expect(res.status).toBe(400);
    expect(dmPosts()).toHaveLength(0);
    expect(dmPosts(BO_PATH, 'Bo')).toHaveLength(0);
  });

  it('refuses when no agent is picked, and sends nothing', async () => {
    const res = await request(server).post(FORWARD).set(APP).send({ text: 'hi', itemId: 'i' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_agent');
    expect(dmPosts()).toHaveLength(0);
  });

  it('refuses a mini app that does not ask to forward', async () => {
    state.extensions = { forwardAgent: { plain: ANA_ID } };
    const res = await request(server)
      .post('/api/extensions/plain/forward')
      .set(APP)
      .send({ text: 'hi', itemId: 'i' });
    expect(res.status).toBe(400);
    expect(dmPosts()).toHaveLength(0);
  });

  it('refuses a mini app that is turned off', async () => {
    state.extensions = { forwardAgent: { off: ANA_ID } };
    const res = await request(server)
      .post('/api/extensions/off/forward')
      .set(APP)
      .send({ text: 'hi', itemId: 'i' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('extension_off');
    expect(dmPosts()).toHaveLength(0);
  });

  it('refuses text over the cap, an empty comment, and attachments', async () => {
    pick(ANA_ID);
    for (const body of [
      { text: 'x'.repeat(8_001), itemId: 'i' },
      { text: '   ', itemId: 'i' },
      { text: 'hi', itemId: 'i', attachmentIds: ['a'] },
      { text: 'hi', itemId: 'i', delivery: 'steer' },
      { text: 'hi' },
    ]) {
      const res = await request(server).post(FORWARD).set(APP).send(body);
      expect(res.status).toBe(400);
    }
    expect(dmPosts()).toHaveLength(0);
  });

  it('writes one audit row per forward, naming the mini app, the agent and the item', async () => {
    pick(ANA_ID);
    const res = await request(server).post(FORWARD).set(APP).send({ text: 'ok', itemId: 'i-9' });
    const rows = forwardAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'ok', targetId: 'desk' });
    expect(rows[0]!.change).toContain(res.body.id);
    expect(rows[0]!.change).toContain(ANA_ID);
    expect(rows[0]!.change).toContain('i-9');
    // The words are in the Direct chat, not copied into the audit trail.
    expect(rows[0]!.change).not.toContain('"ok"');
  });
});

describe('the forward bar', () => {
  beforeEach(() => pick(ANA_ID));

  /** Assert a refusal that posted nothing and was audited. */
  async function expectRefused(
    req: ReturnType<ReturnType<typeof request>['post']>,
    why: string
  ): Promise<void> {
    const res = await req.send({ text: why, itemId: 'i' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_required');
    expect(dmPosts().some((e) => e.body.text === why)).toBe(false);
    expect(forwardAudits().some((row) => row.outcome === 'refused')).toBe(true);
  }

  it('refuses a request with no Origin, as a server half or a script sends', async () => {
    await expectRefused(request(server).post(FORWARD).set('X-Client-Id', 'web-test'), 'no origin');
  });

  it('refuses another site', async () => {
    await expectRefused(
      request(server)
        .post(FORWARD)
        .set({ Origin: 'https://evil.example', 'X-Client-Id': 'web-test' }),
      'evil'
    );
  });

  it('refuses an agent', async () => {
    await expectRefused(
      request(server).post(FORWARD).set(APP).set('X-DorkOS-Agent', 'token'),
      'agent'
    );
  });

  it('refuses an API key', async () => {
    signedInUser = { userId: 'acct-owner', credential: 'api-key' };
    await expectRefused(request(server).post(FORWARD).set(APP), 'api key');
  });

  it('refuses when login is off, where the bar proves only "this computer"', async () => {
    state.authEnabled = false;
    signedInUser = undefined;
    await expectRefused(request(server).post(FORWARD).set(APP), 'login off');
    expect(forwardAudits().map((row) => row.error)).toContain('login-off');
  });

  it('refuses a signed-in person who does not own this DorkOS', async () => {
    signedInUser = { userId: 'acct-guest', credential: 'cookie' };
    await expectRefused(request(server).post(FORWARD).set(APP), 'guest');
    expect(forwardAudits().map((row) => row.error)).toContain('not-the-owner');
  });

  it('refuses a body that is not JSON', async () => {
    const res = await request(server)
      .post(FORWARD)
      .set(APP)
      .set('Content-Type', 'text/plain')
      .send('{"text":"plain","itemId":"i"}');
    expect(res.status).toBe(403);
    expect(dmPosts()).toHaveLength(0);
  });

  it('names each refusal in the pure bar', () => {
    const facts = (over: Record<string, unknown>) =>
      ({
        headers: { origin: TRUSTED_ORIGIN, 'x-client-id': 'w' },
        user: { userId: 'acct-owner', credential: 'cookie' },
        peerAddress: '127.0.0.1',
        forwardedAddress: '127.0.0.1',
        connectionEncrypted: false,
        ingress: 'direct',
        ...over,
      }) as never;
    expect(refuseForward(facts({}), 'application/json')).toBeUndefined();
    expect(refuseForward(facts({}), 'application/json; charset=utf-8')).toBeUndefined();
    expect(refuseForward(facts({}), 'text/plain')).toBe('not-json');
    // No signed-in session is never a pass. Which refusal depends on the
    // gate; the login-off one is pinned through the route above.
    expect(refuseForward(facts({ user: undefined }), 'application/json')).toBeDefined();
    expect(refuseForward(facts({ ingress: 'relay' }), 'application/json')).toBe('relayed');
  });
});

describe('replies', () => {
  beforeEach(() => pick(ANA_ID));

  it('returns the agent’s answers to the forward, under its name, with HTML defused', async () => {
    const sent = await request(server).post(FORWARD).set(APP).send({ text: 'Do it', itemId: 'i' });
    const chat = chats.ensureForAgent(ANA_PATH, 'Ana');
    const anaAuthor = chat.agentAuthorId;
    service.post(chat.roomId, {
      authorId: anaAuthor,
      text: 'Paid. <img src=x onerror=alert(1)> [see](javascript:alert(1))',
      answersEntryId: sent.body.id,
    });
    // Ana's post answering something else is not this forward's reply.
    service.post(chat.roomId, { authorId: anaAuthor, text: 'unrelated' });

    const res = await request(server).get(`${FORWARD}/${sent.body.id}/replies`);

    expect(res.status).toBe(200);
    expect(res.body.replies).toHaveLength(1);
    expect(res.body.replies[0]).toMatchObject({ agent: { id: ANA_ID, name: 'Ana' } });
    expect(res.body.replies[0].markdown).toBe('Paid. &lt;img src=x onerror=alert(1)> [see](#)');
  });

  it('never returns the person’s own posts as replies', async () => {
    const sent = await request(server).post(FORWARD).set(APP).send({ text: 'Do it', itemId: 'i' });
    const chat = chats.ensureForAgent(ANA_PATH, 'Ana');
    service.post(chat.roomId, {
      authorId: ownerAuthorId,
      text: 'me again',
      answersEntryId: sent.body.id,
    });
    const res = await request(server).get(`${FORWARD}/${sent.body.id}/replies`);
    expect(res.body.replies).toEqual([]);
  });

  it('refuses an entry that is not this mini app’s forward', async () => {
    const chat = chats.ensureForAgent(ANA_PATH, 'Ana');
    const typed = service.post(chat.roomId, { authorId: ownerAuthorId, text: 'typed by hand' });
    const res = await request(server).get(`${FORWARD}/${typed.id}/replies`);
    expect(res.status).toBe(404);
  });

  it('refuses an agent reading them', async () => {
    const res = await request(server)
      .get(`${FORWARD}/whatever/replies`)
      .set('X-DorkOS-Agent', 'token');
    expect(res.status).toBe(403);
  });
});

describe('the forward agent setting', () => {
  it('a person picks, reads back and clears the agent', async () => {
    const put = await request(server)
      .put('/api/extensions/desk/forward-agent')
      .set(APP)
      .send({ agentId: BO_ID });
    expect(put.status).toBe(200);
    expect(put.body.agent).toEqual({ id: BO_ID, name: 'Bo' });
    expect(state.extensions.forwardAgent).toEqual({ desk: BO_ID });

    const read = await request(server).get('/api/extensions/desk/forward-agent');
    expect(read.body.agent).toEqual({ id: BO_ID, name: 'Bo' });

    const cleared = await request(server)
      .put('/api/extensions/desk/forward-agent')
      .set(APP)
      .send({ agentId: null });
    expect(cleared.body.agent).toBeNull();
    expect(state.extensions.forwardAgent).toEqual({});
  });

  it('refuses an agent picking it', async () => {
    const res = await request(server)
      .put('/api/extensions/desk/forward-agent')
      .set('X-DorkOS-Agent', 'token')
      .send({ agentId: ANA_ID });
    expect(res.status).toBe(403);
    expect(state.extensions.forwardAgent).toBeUndefined();
  });

  it('refuses an agent id Mesh does not know', async () => {
    const res = await request(server)
      .put('/api/extensions/desk/forward-agent')
      .set(APP)
      .send({ agentId: 'nobody' });
    expect(res.status).toBe(404);
    expect(state.extensions.forwardAgent).toBeUndefined();
  });

  it('is refused from Wi-Fi', () => {
    expect(
      matchWifiRefusedRoute('PUT', ['/api/extensions/desk/forward-agent'], false)
    ).toBeDefined();
    // The forward itself is not refused there: it is held to the default instead.
    expect(matchWifiRefusedRoute('POST', [FORWARD], false)).toBeUndefined();
  });
});

describe('the Direct chat view', () => {
  it('stamps the app and item on the person’s message from the room’s own record', async () => {
    pick(ANA_ID);
    const sent = await request(server)
      .post(FORWARD)
      .set(APP)
      .send({ text: 'Yes', itemId: 'item-7', itemTitle: 'Pay it' });
    const chat = chats.ensureForAgent(ANA_PATH, 'Ana');
    const facts = createRoomMessageLookup(
      roomStore,
      service.authorRegistry,
      () => 'acct-owner'
    )(chat.roomId, sent.body.id);
    expect(facts?.via).toEqual({
      extensionId: 'desk',
      appName: 'Dorian Desk',
      itemId: 'item-7',
      itemTitle: 'Pay it',
    });
    expect(facts?.author.you).toBe(true);
  });
});
