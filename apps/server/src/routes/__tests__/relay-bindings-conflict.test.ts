/**
 * Route-level coverage for "one chat, one agent" (connection-scoping spec
 * `specs/connection-scoping/` §Part 2): the 409 conflict shape on
 * `POST/PATCH /bindings` and the `POST /bindings/:id/move` endpoint. Uses the
 * REAL {@link BindingStore} (a temp directory) and a REAL {@link BindingRouter}
 * — not a hand-rolled stateful fake — because the invariant under test lives
 * inside `BindingStore.create`/`update`/`moveToAgent`, not in routing glue.
 *
 * @module routes/__tests__/relay-bindings-conflict
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelayCore } from '@dorkos/relay';
import { createRelayRouter } from '../relay.js';
import { BindingStore } from '../../services/relay/binding-store.js';
import { BindingRouter, type RelayCoreLike } from '../../services/relay/binding-router.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';

function createMockRelayCore(): RelayCoreLike {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 0, rejected: [] }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

describe('POST/PATCH /bindings conflict + POST /bindings/:id/move', () => {
  let tmpDir: string;
  let bindingStore: BindingStore;
  let bindingRouter: BindingRouter;
  let app: express.Application;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dorkos-binding-conflict-'));
    bindingStore = new BindingStore(tmpDir);
    await bindingStore.init();
    bindingRouter = new BindingRouter({
      bindingStore,
      relayCore: createMockRelayCore(),
      agentManager: { createSession: vi.fn().mockResolvedValue({ id: 'sess-x' }) },
      meshCore: { getProjectPath: vi.fn().mockReturnValue('/proj/agent-a') },
      relayDir: tmpDir,
    });
    await bindingRouter.init();

    const adapterManager = {
      listAdapters: vi.fn().mockReturnValue([]),
      getAdapter: vi.fn().mockReturnValue({ id: 'tg-bot' }),
      getCatalog: vi.fn().mockReturnValue([]),
      getBindingStore: vi.fn().mockReturnValue(bindingStore),
      getBindingRouter: vi.fn().mockReturnValue(bindingRouter),
      getMeshCore: vi.fn().mockReturnValue({ getProjectPath: () => '/proj/agent-a' }),
    } as unknown as AdapterManager;

    app = express();
    app.use(express.json());
    app.use(
      '/api/relay',
      createRelayRouter(createMockRelayCore() as unknown as RelayCore, adapterManager, undefined)
    );
  });

  afterEach(async () => {
    await bindingRouter.shutdown();
    await bindingStore.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AC2.1: creating a second binding on the same (adapterId, chatId) 409s with the conflicting binding', async () => {
    const first = await request(app)
      .post('/api/relay/bindings')
      .send({ adapterId: 'tg-bot', agentId: 'agent-a', chatId: '123' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/relay/bindings')
      .send({ adapterId: 'tg-bot', agentId: 'agent-b', chatId: '123' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CHAT_ALREADY_BOUND');
    expect(second.body.conflict).toMatchObject({
      bindingId: first.body.binding.id,
      agentId: 'agent-a',
    });

    // The second binding was never created — resolve() still returns the first.
    expect(bindingStore.getAll()).toHaveLength(1);
  });

  it('AC2.2: PATCHing chatId onto a value another binding already owns 409s the same way', async () => {
    const owner = await request(app)
      .post('/api/relay/bindings')
      .send({ adapterId: 'tg-bot', agentId: 'agent-a', chatId: '123' });
    const other = await request(app)
      .post('/api/relay/bindings')
      .send({ adapterId: 'tg-bot', agentId: 'agent-b', chatId: '456' });

    const patch = await request(app)
      .patch(`/api/relay/bindings/${other.body.binding.id}`)
      .send({ chatId: '123' });
    expect(patch.status).toBe(409);
    expect(patch.body.conflict.bindingId).toBe(owner.body.binding.id);
  });

  it('AC2.3: move re-points agentId on the SAME binding id and clears its stale sessions', async () => {
    const created = await request(app)
      .post('/api/relay/bindings')
      .send({ adapterId: 'tg-bot', agentId: 'agent-a', chatId: '123' });
    const bindingId = created.body.binding.id as string;

    // Force a session mapping to exist for this binding (as a real inbound
    // message would create), so we can assert it's gone after the move.
    await bindingRouter.testBinding(bindingId); // sanity: binding resolves
    const sessionMapPrivate = bindingRouter as unknown as {
      sessionMap: Map<string, { sessionId: string; lastActivityAt: number }>;
    };
    sessionMapPrivate.sessionMap.set(`${bindingId}:chat:123`, {
      sessionId: 'stale-session',
      lastActivityAt: Date.now(),
    });
    expect(bindingRouter.getSessionsByBinding(bindingId)).toHaveLength(1);

    const moved = await request(app)
      .post(`/api/relay/bindings/${bindingId}/move`)
      .send({ agentId: 'agent-b' });
    expect(moved.status).toBe(200);
    expect(moved.body.binding).toMatchObject({ id: bindingId, agentId: 'agent-b', chatId: '123' });
    expect(bindingStore.getAll()).toHaveLength(1); // still one row, same id

    expect(bindingRouter.getSessionsByBinding(bindingId)).toHaveLength(0);
  });

  it('move on an unknown binding id 404s', async () => {
    const res = await request(app)
      .post('/api/relay/bindings/does-not-exist/move')
      .send({ agentId: 'agent-b' });
    expect(res.status).toBe(404);
  });
});
