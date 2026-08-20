import { describe, it, expect } from 'vitest';
import { resolveNotifyTarget } from '../notify-target.js';
import type {
  NotifyTargetBindingStore,
  NotifyTargetBindingRouter,
  NotifyTargetAdapterManager,
  NotifyTargetBridgeStore,
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
    bridge: 'off',
    roomId: null,
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

/** A live bridge row as the store reports it, boilerplate fields defaulted. */
type TestBridge = { bindingId: string; chatId: string; lastActivityAt?: string | null };

function bridges(rows: TestBridge[]): NotifyTargetBridgeStore {
  return {
    listLiveBridges: () => rows.map((r) => ({ lastActivityAt: r.lastActivityAt ?? null, ...r })),
  };
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

  // Bridged bindings vacate `sessionMap` (chats-as-channels spec §7.2), so a
  // live bridge row must compete as a recency candidate too — otherwise a
  // bridged chat looks exactly like one that was never active (DOR-876).
  describe('bridged bindings (§7.5)', () => {
    it('A7.5: resolves the bridged chat with every session vacated from sessionMap', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([binding({ bridge: 'room', roomId: 'room-1', chatId: 'chat-42' })]),
        // The sessionMap for this binding is fully empty — this is the whole
        // point of §7.2: bridging adopts/starts a room session and removes
        // the sessionMap entry, so there is nothing here to find it by.
        bindingRouter: router({}),
        bridgeStore: bridges([
          { bindingId: 'b-1', chatId: 'chat-42', lastActivityAt: '2026-01-01T00:05:00.000Z' },
        ]),
        adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.chatId).toBe('chat-42');
      expect(result.subject).toBe('relay.human.telegram.tg-main.chat-42');
      expect(result.bindingId).toBe('b-1');
      // The caller's cue to publish under `relay.bridge.initiate.*` instead
      // of its own principal — the actual gate/principal assertion lives in
      // the two callers' own test suites (the notification pipeline's relay
      // channel, and relay_notify_user), since `subject` alone never carries
      // this.
      expect(result.bridged).toBe(true);
    });

    it('returns NO_ACTIVE_SESSIONS when a bridge row exists for a DIFFERENT binding', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([binding({ bridge: 'room', roomId: 'room-1', chatId: 'chat-42' })]),
        bindingRouter: router({}),
        // A live bridge for someone else's binding must not leak in as this
        // agent's target — the resolver already scopes `myBindings` to this
        // agent, and the bridge-row pass must respect the same scope.
        bridgeStore: bridges([{ bindingId: 'b-OTHER', chatId: 'chat-99' }]),
        adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('NO_ACTIVE_SESSIONS');
    });

    it('mixed: a more-recent bridge row wins over an unbridged session', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([
          binding({ id: 'b-unbridged', adapterId: 'tg-unbridged' }),
          binding({
            id: 'b-bridged',
            adapterId: 'tg-bridged',
            bridge: 'room',
            roomId: 'room-1',
            chatId: 'chat-bridged',
          }),
        ]),
        bindingRouter: router({
          'b-unbridged': [{ chatId: 'chat-session', sessionId: 's1', lastActivityAt: 1_000 }],
        }),
        bridgeStore: bridges([
          {
            bindingId: 'b-bridged',
            chatId: 'chat-bridged',
            // Epoch 5_000ms as ISO — well past the session's lastActivityAt.
            lastActivityAt: new Date(5_000).toISOString(),
          },
        ]),
        adapterManager: adapters([
          { id: 'tg-unbridged', type: 'telegram' },
          { id: 'tg-bridged', type: 'telegram' },
        ]),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.chatId).toBe('chat-bridged');
      expect(result.bindingId).toBe('b-bridged');
      expect(result.bridged).toBe(true);
    });

    it('mixed, reversed: a more-recent unbridged session wins over a bridge row', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([
          binding({ id: 'b-unbridged', adapterId: 'tg-unbridged' }),
          binding({
            id: 'b-bridged',
            adapterId: 'tg-bridged',
            bridge: 'room',
            roomId: 'room-1',
            chatId: 'chat-bridged',
          }),
        ]),
        bindingRouter: router({
          'b-unbridged': [{ chatId: 'chat-session', sessionId: 's1', lastActivityAt: 9_000 }],
        }),
        bridgeStore: bridges([
          {
            bindingId: 'b-bridged',
            chatId: 'chat-bridged',
            lastActivityAt: new Date(1_000).toISOString(),
          },
        ]),
        adapterManager: adapters([
          { id: 'tg-unbridged', type: 'telegram' },
          { id: 'tg-bridged', type: 'telegram' },
        ]),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.chatId).toBe('chat-session');
      expect(result.bindingId).toBe('b-unbridged');
      expect(result.bridged).toBe(false);
    });

    it('a tie resolves exactly as today: the sessionMap candidate wins, not the bridge row', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([
          binding({ id: 'b-unbridged', adapterId: 'tg-unbridged' }),
          binding({
            id: 'b-bridged',
            adapterId: 'tg-bridged',
            bridge: 'room',
            roomId: 'room-1',
            chatId: 'chat-bridged',
          }),
        ]),
        bindingRouter: router({
          'b-unbridged': [{ chatId: 'chat-session', sessionId: 's1', lastActivityAt: 5_000 }],
        }),
        // Exactly the same instant as the session above, as an ISO string.
        bridgeStore: bridges([
          {
            bindingId: 'b-bridged',
            chatId: 'chat-bridged',
            lastActivityAt: new Date(5_000).toISOString(),
          },
        ]),
        adapterManager: adapters([
          { id: 'tg-unbridged', type: 'telegram' },
          { id: 'tg-bridged', type: 'telegram' },
        ]),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No unbridged case changes: on a tie, the pre-existing session-based
      // pick still wins — a bridge row must beat it, never merely match it.
      expect(result.chatId).toBe('chat-session');
      expect(result.bindingId).toBe('b-unbridged');
      expect(result.bridged).toBe(false);
    });

    it('a malformed lastActivityAt does not poison the scan (NaN never beats, never freezes it)', () => {
      // `Date.parse` of a malformed value returns NaN, and `at > best.at` is
      // false for every `at` once `best.at` is NaN — including a genuinely
      // more-recent candidate processed afterward. Order matters here: the
      // malformed row is listed FIRST, so an unguarded scan would seed `best`
      // with a NaN `at` (nothing beats `!best`), and the valid, more-recent
      // row second would then lose to it purely because `at > NaN` is always
      // false. The current sole writer of this field (BridgeStore.stampActivity)
      // never writes a bad value, but the invariant lives in a different file
      // than this comparison, so it's guarded here too.
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([
          binding({
            id: 'b-malformed',
            adapterId: 'tg-malformed',
            bridge: 'room',
            roomId: 'room-malformed',
            chatId: 'chat-malformed',
          }),
          binding({
            id: 'b-good',
            adapterId: 'tg-good',
            bridge: 'room',
            roomId: 'room-good',
            chatId: 'chat-good',
          }),
        ]),
        bindingRouter: router({}),
        bridgeStore: bridges([
          {
            bindingId: 'b-malformed',
            chatId: 'chat-malformed',
            lastActivityAt: 'not-a-real-timestamp',
          },
          {
            bindingId: 'b-good',
            chatId: 'chat-good',
            lastActivityAt: new Date(9_000).toISOString(),
          },
        ]),
        adapterManager: adapters([
          { id: 'tg-malformed', type: 'telegram' },
          { id: 'tg-good', type: 'telegram' },
        ]),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.chatId).toBe('chat-good');
      expect(result.bindingId).toBe('b-good');
    });

    it('omitting bridgeStore behaves exactly as before bridging existed', () => {
      const result = resolveNotifyTarget('agent-1', {
        bindingStore: store([binding({ bridge: 'room', roomId: 'room-1', chatId: 'chat-42' })]),
        bindingRouter: router({}),
        // No bridgeStore dep at all — mirrors any caller that hasn't been
        // updated to pass one yet.
        adapterManager: adapters([{ id: 'tg-main', type: 'telegram' }]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('NO_ACTIVE_SESSIONS');
    });
  });
});
