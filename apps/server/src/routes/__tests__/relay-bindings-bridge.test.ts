/**
 * The "Bridge to a channel" route (DOR-878): PATCH /bindings/:id routes a
 * `bridge` TRANSITION through `BridgeLifecycle` rather than writing the flag
 * straight to the store. These tests pin that the route is the first production
 * caller of `BridgeLifecycle.bridge`/`unbridge` (spec §3.1, A12.2), derives the
 * lifecycle's input from the stored binding, and REFUSES anything it cannot
 * prove is a two-way chat before touching the lifecycle (spec §3.3, A3.7).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRelayRouter } from '../relay.js';
import type { RelayCore } from '@dorkos/relay';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { RoomError } from '../../services/rooms/room-errors.js';

function createMockRelayCore(): RelayCore {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'm-1', deliveredTo: 1 }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onSignal: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as RelayCore;
}

interface StoredBinding {
  id: string;
  adapterId: string;
  agentId: string;
  chatId?: string;
  channelType?: string;
  sessionStrategy: string;
  label: string;
  bridge: 'off' | 'room';
  roomId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A stateful store whose contents survive across the requests in one test. The
 * default binding is a **DM** (no `channelType`) — the one shape the detail
 * sheet can bridge; group/broadcast cases override it.
 */
function createStore(seed: Partial<StoredBinding>) {
  const now = new Date().toISOString();
  const binding: StoredBinding = {
    id: 'b-1',
    adapterId: 'telegram-1',
    agentId: 'agent-1',
    chatId: '12345',
    sessionStrategy: 'per-chat',
    label: 'Ana',
    bridge: 'off',
    roomId: null,
    createdAt: now,
    updatedAt: now,
    ...seed,
  };
  const bindings = new Map<string, StoredBinding>([[binding.id, binding]]);
  return {
    map: bindings,
    getAll: vi.fn(() => Array.from(bindings.values())),
    getById: vi.fn((id: string) => bindings.get(id)),
    update: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const existing = bindings.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      bindings.set(id, updated);
      return updated;
    }),
    delete: vi.fn(async (id: string) => bindings.delete(id)),
  };
}

/**
 * A lifecycle stand-in that mutates the store exactly as the real one does —
 * `bridge()` flips `bridge: 'room'` + a roomId; `unbridge()` clears them — so
 * the route's re-read reflects a real flip, not a mock artifact.
 */
function createLifecycle(store: ReturnType<typeof createStore>, opts?: { throwOnBridge?: Error }) {
  return {
    bridge: vi.fn(async (input: { bindingId: string }) => {
      if (opts?.throwOnBridge) throw opts.throwOnBridge;
      const existing = store.map.get(input.bindingId)!;
      store.map.set(input.bindingId, { ...existing, bridge: 'room', roomId: 'room-9' });
      return { id: 'room-9', adopted: false };
    }),
    unbridge: vi.fn(async (bindingId: string) => {
      const existing = store.map.get(bindingId)!;
      store.map.set(bindingId, { ...existing, bridge: 'off', roomId: null });
    }),
  };
}

function createApp(
  store: ReturnType<typeof createStore>,
  overrides: Partial<AdapterManager> = {}
): express.Application {
  const adapterManager = {
    getAdapter: vi.fn().mockReturnValue({ config: { id: 'telegram-1', label: 'Telegram' } }),
    getBindingStore: vi.fn().mockReturnValue(store),
    getBindingRouter: vi.fn().mockReturnValue(undefined),
    getMeshCore: vi.fn().mockReturnValue({ getProjectPath: () => '/agents/agent-1' }),
    getBridgeLifecycle: vi.fn().mockReturnValue(undefined),
    ...overrides,
  } as unknown as AdapterManager;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/relay',
    createRelayRouter(createMockRelayCore(), adapterManager, undefined as never)
  );
  return app;
}

describe('PATCH /bindings/:id — bridge transitions route through BridgeLifecycle (DOR-878)', () => {
  let store: ReturnType<typeof createStore>;
  let lifecycle: ReturnType<typeof createLifecycle>;

  beforeEach(() => {
    store = createStore({});
    lifecycle = createLifecycle(store);
  });

  it('A12.2: one PATCH { bridge: "room" } on a DM fires BridgeLifecycle.bridge once and flips the binding — no restart', async () => {
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
    });

    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'room' })
      .expect(200);

    // One cockpit action → exactly one lifecycle bridge call (A12.2).
    expect(lifecycle.bridge).toHaveBeenCalledTimes(1);
    // The lifecycle input is derived from the stored binding; a DM bridges as a
    // `private` chat with no subject-level channel type (spec §3.3).
    expect(lifecycle.bridge).toHaveBeenCalledWith({
      adapterId: 'telegram-1',
      chatId: '12345',
      bindingId: 'b-1',
      agentId: 'agent-1',
      chatType: 'private',
      channelType: null,
      title: 'Ana',
      agentPath: '/agents/agent-1',
    });
    expect(res.body.binding.bridge).toBe('room');
    expect(res.body.binding.roomId).toBe('room-9');
  });

  it('does not re-run bridge when the binding is already bridged (no transition)', async () => {
    store = createStore({ bridge: 'room', roomId: 'room-9' });
    lifecycle = createLifecycle(store);
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
    });

    await request(app).patch('/api/relay/bindings/b-1').send({ bridge: 'room' }).expect(200);
    expect(lifecycle.bridge).not.toHaveBeenCalled();
  });

  it('PATCH { bridge: "off" } on a bridged binding calls unbridge and clears the room', async () => {
    store = createStore({ bridge: 'room', roomId: 'room-9' });
    lifecycle = createLifecycle(store);
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
    });

    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'off' })
      .expect(200);

    expect(lifecycle.unbridge).toHaveBeenCalledTimes(1);
    expect(lifecycle.unbridge).toHaveBeenCalledWith('b-1');
    expect(res.body.binding.bridge).toBe('off');
    expect(res.body.binding.roomId).toBeNull();
  });

  // The refusal that must actually fire on a real Telegram broadcast. A broadcast
  // reaches us folded into `channelType: 'group'` (isGroupChat, inbound.ts:355),
  // so a group-typed binding is the shape a real broadcast takes. The refusal
  // runs through the REAL derivation (bridgeChatTypeForBinding), NOT a mock throw,
  // so this fails if the refusal is ever made unreachable.
  it('refuses a group binding (the shape a folded broadcast takes) before the lifecycle', async () => {
    store = createStore({ channelType: 'group' });
    lifecycle = createLifecycle(store);
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
    });

    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'room' })
      .expect(400);

    expect(res.body.code).toBe('BRIDGE_NOT_A_DM');
    expect(res.body.error).toMatch(/broadcast/i);
    expect(lifecycle.bridge).not.toHaveBeenCalled();
    expect(store.map.get('b-1')!.bridge).toBe('off');
  });

  it('refuses an explicitly broadcast-typed binding (channelType: channel)', async () => {
    store = createStore({ channelType: 'channel' });
    lifecycle = createLifecycle(store);
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
    });

    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'room' })
      .expect(400);

    expect(res.body.code).toBe('BRIDGE_NOT_A_DM');
    expect(lifecycle.bridge).not.toHaveBeenCalled();
    expect(store.map.get('b-1')!.bridge).toBe('off');
  });

  it('refuses a chat-wildcard binding (no chatId) with the wildcard reason, before the lifecycle', async () => {
    store = createStore({ chatId: undefined });
    lifecycle = createLifecycle(store);
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
    });

    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'room' })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain('one room cannot honestly be the channel');
    expect(lifecycle.bridge).not.toHaveBeenCalled();
    expect(store.map.get('b-1')!.bridge).toBe('off');
  });

  it('maps a RoomError thrown by the lifecycle to its HTTP status', async () => {
    lifecycle = createLifecycle(store, {
      throwOnBridge: new RoomError('OPERATOR_ONLY', 'Only you can bridge a chat'),
    });
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
    });

    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'room' })
      .expect(403);

    expect(res.body.code).toBe('OPERATOR_ONLY');
    expect(store.map.get('b-1')!.bridge).toBe('off');
  });

  it('refuses when the bound agent is not in the mesh (no project path)', async () => {
    const app = createApp(store, {
      getBridgeLifecycle: vi.fn().mockReturnValue(lifecycle) as never,
      getMeshCore: vi.fn().mockReturnValue({ getProjectPath: () => undefined }) as never,
    });

    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'room' })
      .expect(400);

    expect(res.body.error).toContain('agent-1');
    expect(lifecycle.bridge).not.toHaveBeenCalled();
  });

  it('falls back to a direct field write when no lifecycle is wired (rooms not available)', async () => {
    // No getBridgeLifecycle override → undefined. The bridged binding is inert
    // without the rooms subsystem, so a plain flag write is acceptable and keeps
    // the schema/route boundary (A3.5) behaving as before DOR-878.
    const app = createApp(store);
    const res = await request(app)
      .patch('/api/relay/bindings/b-1')
      .send({ bridge: 'room' })
      .expect(200);
    expect(res.body.binding.bridge).toBe('room');
  });
});
