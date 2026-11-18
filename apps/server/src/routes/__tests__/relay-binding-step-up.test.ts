/**
 * A chat-route write that raises what a route may do, or points it at another
 * chat or agent, waits for the owner to confirm it's them (DOR-4355). The
 * reverse of each, and a rename, answer at once.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BindingStore } from '../../services/relay/binding-store.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { createAdapterRoutes } from '../relay-adapters.js';
import { UnclaimedChatStore } from '../../services/relay/unclaimed-chat-store.js';
import { createUnclaimedChatsRoutes } from '../unclaimed-chats.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('chat route confirmation', () => {
  let dir: string;
  let store: BindingStore;
  let bindingId: string;
  const manager = {
    resolveAdapterName: vi.fn(() => 'Northwind Telegram'),
    getManifest: vi.fn(() => undefined),
    getAdapter: vi.fn(() => ({ id: 'tg', config: { id: 'tg', label: 'Northwind Telegram' } })),
    getBindingStore: vi.fn(() => store),
    getBindingRouter: vi.fn(() => undefined),
    getBridgeLifecycle: vi.fn(() => undefined),
    getMeshCore: vi.fn(() => ({ getProjectPath: () => '/made-up/agents/northwind' })),
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/relay',
      routes: createAdapterRoutes({ adapterManager: manager as unknown as AdapterManager }),
    },
  ]);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dorkos-binding-step-up-'));
    store = new BindingStore(dir);
    await store.init();
    bindingId = (await store.create({ adapterId: 'tg', agentId: 'agent-a', chatId: '123' })).id;
  });
  afterEach(async () => {
    await store.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['a looser permission mode', { permissionMode: 'bypassPermissions' }],
    ['letting it start chats', { canInitiate: true }],
    ['clearing its chat filter', { chatId: null }],
    ['pointing it at another chat', { chatId: '456' }],
  ])('holds %s until the owner confirms', async (_label, patch) => {
    const before = JSON.stringify(store.getById(bindingId));
    const held = await owner
      .call('patch', `/api/relay/bindings/${bindingId}`, 'own-tunnel')
      .send(patch);
    expect(held.status).toBe(428);
    expect(JSON.stringify(store.getById(bindingId))).toBe(before);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(JSON.stringify(store.getById(bindingId))).toBe(before);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(JSON.stringify(store.getById(bindingId))).not.toBe(before);
  });

  // Security S5 on DOR-4355 M3: a change read as free must still be free when it lands.
  it('answers 409 for a free change judged on a route the person narrowed meanwhile', async () => {
    const narrowed = store.getById(bindingId)!;
    expect(narrowed.canInitiate).toBe(false);
    // The read the route judges on is from before the person took "start chats" away.
    vi.spyOn(store, 'getById').mockReturnValueOnce({ ...narrowed, canInitiate: true });
    const res = await owner
      .call('patch', `/api/relay/bindings/${bindingId}`, 'own-tunnel')
      .send({ canInitiate: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BINDING_CHANGED');
    expect(store.getById(bindingId)?.canInitiate).toBe(false);
  });

  it('holds a new route that starts looser than the defaults', async () => {
    const held = await owner
      .call('post', '/api/relay/bindings', 'own-tunnel')
      .send({ adapterId: 'tg', agentId: 'agent-a', chatId: '789', canInitiate: true });
    expect(held.status).toBe(428);
    expect(store.getAll()).toHaveLength(1);
  });

  it('holds pointing a route at another agent', async () => {
    const held = await owner
      .call('post', `/api/relay/bindings/${bindingId}/move`, 'own-tunnel')
      .send({ agentId: 'agent-b' });
    expect(held.status).toBe(428);
    expect(store.getById(bindingId)?.agentId).toBe('agent-a');
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(store.getById(bindingId)?.agentId).toBe('agent-b');
  });

  it.each([
    ['a rename', { label: 'Northwind support' }],
    ['a stricter mode', { permissionMode: 'plan' }],
    ['turning replies off', { canReply: false }],
  ])('answers %s at once', async (_label, patch) => {
    const res = await owner
      .call('patch', `/api/relay/bindings/${bindingId}`, 'own-tunnel')
      .send(patch);
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
  });

  it('answers a new route with the defaults at once', async () => {
    const res = await owner
      .call('post', '/api/relay/bindings', 'own-tunnel')
      .send({ adapterId: 'tg', agentId: 'agent-a', chatId: '789' });
    expect(res.status).toBe(201);
    expect(store.getAll()).toHaveLength(2);
  });
});

describe('claiming a chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dorkos-claim-step-up-'));
  const bindings = new BindingStore(dir);
  let chats: UnclaimedChatStore;
  const owner = frontDoorStepUpHarness(() => {
    chats = new UnclaimedChatStore(owner.db());
    return [
      {
        path: '/api/relay/unclaimed-chats',
        routes: createUnclaimedChatsRoutes({ store: chats, bindingStore: bindings }),
      },
    ];
  });
  beforeAll(() => bindings.init());
  afterAll(async () => {
    await bindings.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds a claim that starts looser than the default, and answers one that does not', async () => {
    const first = chats.recordSighting({ adapterId: 'tg', chatId: '111', chatKind: 'dm' }).chat;
    const held = await owner
      .call('post', `/api/relay/unclaimed-chats/${first.id}/claim`, 'own-tunnel')
      .send({ agentId: 'agent-a', permissionMode: 'bypassPermissions' });
    expect(held.status).toBe(428);
    expect(bindings.getAll()).toHaveLength(0);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
    });
    expect(bindings.getAll()).toHaveLength(1);

    const second = chats.recordSighting({ adapterId: 'tg', chatId: '222', chatKind: 'dm' }).chat;
    const plain = await owner
      .call('post', `/api/relay/unclaimed-chats/${second.id}/claim`, 'own-tunnel')
      .send({ agentId: 'agent-a' });
    expect(plain.body.heldActionId).toBeUndefined();
    expect(bindings.getAll()).toHaveLength(2);
  });
});
