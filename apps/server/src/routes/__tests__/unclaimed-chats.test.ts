import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BindingStore } from '../../services/relay/binding-store.js';
import { UnclaimedChatStore } from '../../services/relay/unclaimed-chat-store.js';
import { createUnclaimedChatsRouter } from '../unclaimed-chats.js';

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
