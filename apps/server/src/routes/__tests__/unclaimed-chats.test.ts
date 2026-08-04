import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BindingStore } from '../../services/relay/binding-store.js';
import { UnclaimedChatStore } from '../../services/relay/unclaimed-chat-store.js';
import type { BridgeLifecycle } from '../../services/relay/chat-bridge/index.js';
import { createUnclaimedChatsRouter } from '../unclaimed-chats.js';

/**
 * A lifecycle stand-in that mutates the real `BindingStore` exactly as the
 * real coordinator does — `bridge()` flips `bridge: 'room'` + a roomId — so a
 * route re-read reflects a real flip, not a mock artifact. Mirrors
 * `relay-bindings-bridge.test.ts`'s `createLifecycle`.
 */
function fakeLifecycle(
  bindingStore: BindingStore,
  opts: { throwOnBridge?: Error; roomId?: string } = {}
) {
  const bridge = vi.fn(async (input: { bindingId: string }) => {
    if (opts.throwOnBridge) throw opts.throwOnBridge;
    const roomId = opts.roomId ?? 'room-9';
    await bindingStore.update(input.bindingId, { bridge: 'room', roomId });
    return { id: roomId, adopted: false };
  });
  return { bridge, unbridge: vi.fn(), rebridge: vi.fn() } as unknown as BridgeLifecycle;
}

describe('unclaimed-chats router', () => {
  let db: Db;
  let tmpDir: string;
  let bindingStore: BindingStore;
  let store: UnclaimedChatStore;
  let app: express.Application;

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'dorkos-unclaimed-'));
    bindingStore = new BindingStore(tmpDir);
    await bindingStore.init();
    store = new UnclaimedChatStore(db);

    app = express();
    app.use(express.json());
    app.use(
      '/api/relay/unclaimed-chats',
      createUnclaimedChatsRouter({
        store,
        bindingStore,
        meshCore: { getProjectPath: (id: string) => (id === 'agent-a' ? '/proj/a' : undefined) },
      })
    );
  });

  afterEach(async () => {
    await bindingStore.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET lists pending chats by default', async () => {
    store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' });
    const res = await request(app).get('/api/relay/unclaimed-chats');
    expect(res.status).toBe(200);
    expect(res.body.chats).toHaveLength(1);
  });

  it('GET filters by status', async () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    store.block(chat.id);
    const pending = await request(app).get('/api/relay/unclaimed-chats?status=pending');
    expect(pending.body.chats).toHaveLength(0);
    const blocked = await request(app).get('/api/relay/unclaimed-chats?status=blocked');
    expect(blocked.body.chats).toHaveLength(1);
  });

  it('AC3.4: claim creates a binding through the uniqueness-checked path and marks the chat claimed', async () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a' });

    expect(res.status).toBe(201);
    expect(res.body.binding).toMatchObject({
      adapterId: 'tg-bot',
      chatId: '123',
      agentId: 'agent-a',
    });
    expect(store.getById(chat.id)?.status).toBe('claimed');
    expect(store.getById(chat.id)?.decidedAgentId).toBe('agent-a');
  });

  // DOR-907: the full chain — a group sighting persists its raw platform type to
  // SQLite, and claiming it copies that type onto the created binding, so the
  // "Bridge to a channel" action can later bridge it as a channel. Real stores
  // and a real DB, no mocks: the binding is read back from the JSON store.
  it('DOR-907: claim copies the sighting platformChatType onto the created binding', async () => {
    const chat = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '999',
      channelType: 'group',
      chatKind: 'group',
      platformChatType: 'supergroup',
    }).chat;

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a' });

    expect(res.status).toBe(201);
    expect(res.body.binding.platformChatType).toBe('supergroup');
    // And it is actually on the persisted binding, not just the response.
    expect(bindingStore.getById(res.body.binding.id)?.platformChatType).toBe('supergroup');
  });

  // DOR-907: a broadcast sighting round-trips its `channel` type onto the
  // binding too — the binding the bridge action will refuse precisely.
  it('DOR-907: claim on a broadcast sighting carries channel onto the binding', async () => {
    const chat = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '777',
      channelType: 'group',
      chatKind: 'group',
      platformChatType: 'channel',
    }).chat;

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a' });

    expect(res.status).toBe(201);
    expect(res.body.binding.platformChatType).toBe('channel');
    expect(bindingStore.getById(res.body.binding.id)?.platformChatType).toBe('channel');
  });

  it('AC3.4: claiming a chat a manual binding has since taken 409s (the same race the create route handles)', async () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    // Someone else bound this chat manually in the meantime.
    await bindingStore.create({ adapterId: 'tg-bot', agentId: 'agent-a', chatId: '123' });

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHAT_ALREADY_BOUND');
    // The unclaimed chat was NOT marked claimed on the failed attempt.
    expect(store.getById(chat.id)?.status).toBe('pending');
  });

  it('claim 400s for an agent the mesh does not know about', async () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'ghost-agent' });
    expect(res.status).toBe(400);
  });

  it('claim 404s for an unknown chat id', async () => {
    const res = await request(app)
      .post('/api/relay/unclaimed-chats/does-not-exist/claim')
      .send({ agentId: 'agent-a' });
    expect(res.status).toBe(404);
  });

  it('POST /:id/ignore mutes a chat, idempotently', async () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    const first = await request(app).post(`/api/relay/unclaimed-chats/${chat.id}/ignore`);
    expect(first.status).toBe(204);
    const second = await request(app).post(`/api/relay/unclaimed-chats/${chat.id}/ignore`);
    expect(second.status).toBe(204);
    expect(store.getById(chat.id)?.status).toBe('ignored');
  });

  it('POST /:id/block blocks a chat, idempotently', async () => {
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;
    const res = await request(app).post(`/api/relay/unclaimed-chats/${chat.id}/block`);
    expect(res.status).toBe(204);
    expect(store.isBlocked('tg-bot', '123')).toBe(true);
  });
});

/**
 * "Answer in a channel" (chats-as-channels spec §3.1, task 2.1, DOR-882) — the
 * claim card's primary action. Claims, binds, and bridges through the SAME
 * `BridgeLifecycle.bridge()` path task 1.14 (DOR-878) already uses; there is
 * no second create path. A bridge failure must never leave a broken partial
 * state — the claim (this task's "Answer privately", unchanged) already
 * stands on its own, so failure degrades to that and reports why.
 */
describe('unclaimed-chats router — "Answer in a channel" (DOR-882)', () => {
  let db: Db;
  let tmpDir: string;
  let bindingStore: BindingStore;
  let store: UnclaimedChatStore;

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'dorkos-unclaimed-bridge-'));
    bindingStore = new BindingStore(tmpDir);
    await bindingStore.init();
    store = new UnclaimedChatStore(db);
  });

  afterEach(async () => {
    await bindingStore.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createApp(lifecycle?: BridgeLifecycle, withMesh = true) {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/relay/unclaimed-chats',
      createUnclaimedChatsRouter({
        store,
        bindingStore,
        ...(withMesh && {
          meshCore: { getProjectPath: (id: string) => (id === 'agent-a' ? '/proj/a' : undefined) },
        }),
        ...(lifecycle && { lifecycle }),
      })
    );
    return app;
  }

  it('claims, binds, and bridges atomically in one call — the response binding carries the room', async () => {
    const lifecycle = fakeLifecycle(bindingStore, { roomId: 'room-42' });
    const app = createApp(lifecycle);
    const chat = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '123',
      chatKind: 'dm',
      platformChatType: 'private',
    }).chat;

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a', bridge: true });

    expect(res.status).toBe(201);
    expect(res.body.bridgeError).toBeUndefined();
    expect(res.body.binding).toMatchObject({ bridge: 'room', roomId: 'room-42' });
    expect(lifecycle.bridge).toHaveBeenCalledTimes(1);
    expect(lifecycle.bridge).toHaveBeenCalledWith({
      adapterId: 'tg-bot',
      chatId: '123',
      bindingId: res.body.binding.id,
      agentId: 'agent-a',
      chatType: 'private',
      channelType: null,
      title: '123',
      agentPath: '/proj/a',
    });
    // All four artifacts: the unclaimed row is claimed, the binding exists
    // and is bridged, and the room the lifecycle minted is what the binding
    // now points at (the fourth — the room itself — is BridgeLifecycle's own
    // property, asserted at lifecycle.test.ts and room-bridged-create.test.ts;
    // this suite pins that the claim route reaches it atomically).
    expect(store.getById(chat.id)?.status).toBe('claimed');
    expect(bindingStore.getById(res.body.binding.id)).toMatchObject({
      bridge: 'room',
      roomId: 'room-42',
    });
  });

  it("'Answer privately' (bridge omitted) never touches the lifecycle", async () => {
    const lifecycle = fakeLifecycle(bindingStore);
    const app = createApp(lifecycle);
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a' });

    expect(res.status).toBe(201);
    expect(lifecycle.bridge).not.toHaveBeenCalled();
    expect(res.body.binding.bridge).toBe('off');
  });

  it('a bridge failure leaves the claim standing, never a binding that says bridged over a broken room', async () => {
    const lifecycle = fakeLifecycle(bindingStore, { throwOnBridge: new Error('room mint failed') });
    const app = createApp(lifecycle);
    const chat = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '123',
      chatKind: 'dm',
      platformChatType: 'private',
    }).chat;

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a', bridge: true });

    // The claim itself succeeded — the person is not left with an unclaimed
    // chat because a room failed to mint.
    expect(res.status).toBe(201);
    expect(res.body.bridgeError).toBe('room mint failed');
    expect(res.body.binding.bridge).toBe('off');
    expect(res.body.binding.roomId).toBeNull();
    expect(store.getById(chat.id)?.status).toBe('claimed');
    // Persisted, not just the response: no partial bridge survives.
    expect(bindingStore.getById(res.body.binding.id)).toMatchObject({
      bridge: 'off',
      roomId: null,
    });
  });

  it('with no lifecycle wired, bridge: true still claims privately and says why', async () => {
    const app = createApp(undefined);
    const chat = store.recordSighting({ adapterId: 'tg-bot', chatId: '123', chatKind: 'dm' }).chat;

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a', bridge: true });

    expect(res.status).toBe(201);
    expect(res.body.bridgeError).toMatch(/not available/i);
    expect(res.body.binding.bridge).toBe('off');
    expect(store.getById(chat.id)?.status).toBe('claimed');
  });

  it('a broadcast sighting refuses the bridge but the claim still stands', async () => {
    const lifecycle = fakeLifecycle(bindingStore);
    const app = createApp(lifecycle);
    const chat = store.recordSighting({
      adapterId: 'tg-bot',
      chatId: '777',
      channelType: 'group',
      chatKind: 'group',
      platformChatType: 'channel',
    }).chat;

    const res = await request(app)
      .post(`/api/relay/unclaimed-chats/${chat.id}/claim`)
      .send({ agentId: 'agent-a', bridge: true });

    expect(res.status).toBe(201);
    expect(res.body.bridgeError).toMatch(/broadcast channel/i);
    expect(lifecycle.bridge).not.toHaveBeenCalled();
    expect(res.body.binding.bridge).toBe('off');
    expect(store.getById(chat.id)?.status).toBe('claimed');
  });
});
