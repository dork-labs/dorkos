import { describe, it, expect } from 'vitest';
import { resolveNotifyTarget } from '../notify-target.js';
import type {
  NotifyTargetBindingStore,
  NotifyTargetBindingRouter,
  NotifyTargetAdapterManager,
} from '../notify-target.js';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

/** Build a binding with the fields the resolver reads. */
function binding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b-1',
    adapterId: 'tg-main',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: '',
    permissionMode: 'acceptEdits',
    enabled: true,
    canInitiate: true,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function store(bindings: AdapterBinding[]): NotifyTargetBindingStore {
  return { getAll: () => bindings };
}

/** A session as the router reports it, with the boilerplate fields defaulted. */
type TestSession = {
  chatId?: string;
  userId?: string;
  sessionId: string;
  scope?: 'chat' | 'user';
  lastActivityAt?: number;
};

function router(sessionsByBinding: Record<string, TestSession[]>): NotifyTargetBindingRouter {
  return {
    getSessionsByBinding: (id) =>
      (sessionsByBinding[id] ?? []).map((s) => ({
        scope: s.scope ?? (s.userId ? 'user' : 'chat'),
        ...(s.chatId ? { chatId: s.chatId } : {}),
        ...(s.userId ? { userId: s.userId } : {}),
        sessionId: s.sessionId,
        lastActivityAt: s.lastActivityAt ?? 0,
      })),
  };
}

function adapters(list: Array<{ id: string; type: string }>): NotifyTargetAdapterManager {
  return { listAdapters: () => list.map((config) => ({ config })) };
}

describe('resolveNotifyTarget', () => {
  it('resolves the most-recent active chat and builds the human subject', () => {
    const result = resolveNotifyTarget('agent-1', {
      bindingStore: store([binding()]),
      bindingRouter: router({ 'b-1': [{ chatId: 'chat-42', sessionId: 'sess-1' }] }),
      adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe('relay.human.telegram.tg-main.chat-42');
    expect(result.adapterId).toBe('tg-main');
    expect(result.adapterType).toBe('telegram');
    expect(result.chatId).toBe('chat-42');
    expect(result.bindingId).toBe('b-1');
    expect(result.notifyOnTaskComplete).toBe(true);
  });

  it('carries the resolved binding notifyOnTaskComplete flag through', () => {
    const result = resolveNotifyTarget('agent-1', {
      bindingStore: store([binding({ notifyOnTaskComplete: false })]),
      bindingRouter: router({ 'b-1': [{ chatId: 'chat-42', sessionId: 'sess-1' }] }),
      adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
    });
    expect(result.ok && result.notifyOnTaskComplete).toBe(false);
  });

  it('returns NO_BINDING (with available channels) when the agent has no binding', () => {
    const result = resolveNotifyTarget('agent-1', {
      bindingStore: store([binding({ agentId: 'other-agent', adapterId: 'tg-other' })]),
      bindingRouter: router({}),
      adapterManager: adapters([]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NO_BINDING');
  });

  it('excludes paused bindings (enabled=false) up front', () => {
    const result = resolveNotifyTarget('agent-1', {
      bindingStore: store([binding({ enabled: false })]),
      bindingRouter: router({ 'b-1': [{ chatId: 'chat-42', sessionId: 'sess-1' }] }),
      adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
    });
    // The only binding is paused → the agent has no eligible channel at all.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NO_BINDING');
  });

  it('returns NO_ACTIVE_SESSIONS when a binding exists but has no chat session', () => {
    const result = resolveNotifyTarget('agent-1', {
      bindingStore: store([binding()]),
      bindingRouter: router({}),
      adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('NO_ACTIVE_SESSIONS');
    if (result.reason !== 'NO_ACTIVE_SESSIONS') return;
    expect(result.availableAdapters).toEqual(['tg-main']);
  });

  it('returns INITIATE_NOT_ALLOWED when the resolved binding has canInitiate=false', () => {
    const result = resolveNotifyTarget('agent-1', {
      bindingStore: store([binding({ canInitiate: false })]),
      bindingRouter: router({ 'b-1': [{ chatId: 'chat-42', sessionId: 'sess-1' }] }),
      adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('INITIATE_NOT_ALLOWED');
    if (result.reason !== 'INITIATE_NOT_ALLOWED') return;
    expect(result.bindingId).toBe('b-1');
    expect(result.adapterId).toBe('tg-main');
  });

  it('filters by channel adapter type when specified', () => {
    const result = resolveNotifyTarget('agent-1', {
      bindingStore: store([
        binding({ id: 'b-1', adapterId: 'tg-lifeos' }),
        binding({ id: 'b-2', adapterId: 'slack-ops' }),
      ]),
      bindingRouter: router({
        'b-1': [{ chatId: 'chat-77', sessionId: 'sess-3' }],
        'b-2': [{ chatId: 'chat-99', sessionId: 'sess-2' }],
      }),
      adapterManager: adapters([
        { id: 'tg-lifeos', type: 'telegram' },
        { id: 'slack-ops', type: 'slack' },
      ]),
      channel: 'telegram',
    });
    expect(result.ok && result.adapterId).toBe('tg-lifeos');
    expect(result.ok && result.chatId).toBe('chat-77');
  });

  // The doc always claimed "most-recently-active"; the code took whichever
  // session the file happened to list last, so a completion notice landed in a
  // stale public channel instead of the DM in use (DOR-789).
  describe('recency', () => {
    it('picks the chat with the newest activity, not the last one listed', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([binding()]),
        bindingRouter: router({
          'b-1': [
            { chatId: 'chat-fresh', sessionId: 's1', lastActivityAt: 5_000 },
            { chatId: 'chat-stale', sessionId: 's2', lastActivityAt: 1_000 },
          ],
        }),
        adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
      });
      expect(result.ok && result.chatId).toBe('chat-fresh');
    });

    it('picks across bindings, not just within the last one that has sessions', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([
          binding({ id: 'b-1', adapterId: 'tg-main' }),
          binding({ id: 'b-2', adapterId: 'tg-other' }),
        ]),
        bindingRouter: router({
          'b-1': [{ chatId: 'chat-fresh', sessionId: 's1', lastActivityAt: 9_000 }],
          'b-2': [{ chatId: 'chat-stale', sessionId: 's2', lastActivityAt: 2_000 }],
        }),
        adapterManager: adapters([
          { id: 'tg-main', type: 'telegram' },
          { id: 'tg-other', type: 'telegram' },
        ]),
      });
      expect(result.ok && result.chatId).toBe('chat-fresh');
      expect(result.ok && result.bindingId).toBe('b-1');
    });
  });

  describe('per-user sessions', () => {
    it('addresses the binding chat, never the person id', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([binding({ chatId: 'C-group', sessionStrategy: 'per-user' })]),
        bindingRouter: router({
          'b-1': [{ userId: 'U-person', sessionId: 's1', lastActivityAt: 5_000 }],
        }),
        adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
      });
      expect(result.ok && result.chatId).toBe('C-group');
      expect(result.ok && result.subject).toBe('relay.human.telegram.tg-main.C-group');
    });

    it('reports no active session when the binding names no chat to answer in', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([binding({ sessionStrategy: 'per-user' })]),
        bindingRouter: router({
          'b-1': [{ userId: 'U-person', sessionId: 's1', lastActivityAt: 5_000 }],
        }),
        adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
      });
      // Knowing who was active is not knowing where to answer. Guessing here is
      // what put a group's notification into somebody's private messages.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('NO_ACTIVE_SESSIONS');
    });
  });
});
