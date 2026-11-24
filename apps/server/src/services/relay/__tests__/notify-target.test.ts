import { describe, it, expect } from 'vitest';
import { resolveNotifyTarget } from '../notify-target.js';
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

type TestSession = { chatId?: string; userId?: string; sessionId: string; lastActivityAt?: number };
type TestBridge = { bindingId: string; chatId: string; lastActivityAt?: string | null };

/** Resolve for `agent-1` over the given bindings, sessions, and live bridge rows. */
function resolve(
  bindings: AdapterBinding[],
  sessions: Record<string, TestSession[]> = {},
  opts: { bridges?: TestBridge[]; channel?: string; types?: Record<string, string> } = {}
) {
  const adapterIds = [...new Set(bindings.map((b) => b.adapterId))];
  return resolveNotifyTarget('agent-1', {
    bindingStore: { getAll: () => bindings },
    bindingRouter: {
      getSessionsByBinding: (id) =>
        (sessions[id] ?? []).map((s) => ({
          scope: s.userId ? ('user' as const) : ('chat' as const),
          ...(s.chatId ? { chatId: s.chatId } : {}),
          ...(s.userId ? { userId: s.userId } : {}),
          sessionId: s.sessionId,
          lastActivityAt: s.lastActivityAt ?? 0,
        })),
    },
    adapterManager: {
      listAdapters: () =>
        adapterIds.map((id) => ({ config: { id, type: opts.types?.[id] ?? 'telegram' } })),
    },
    ...(opts.bridges
      ? {
          bridgeStore: {
            listLiveBridges: () =>
              opts.bridges!.map((r) => ({ lastActivityAt: r.lastActivityAt ?? null, ...r })),
          },
        }
      : {}),
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
}

const ACTIVE = { 'b-1': [{ chatId: 'chat-42', sessionId: 'sess-1' }] };

describe('resolveNotifyTarget', () => {
  it('resolves the active chat, builds the human subject, and carries the notify flag', () => {
    expect(resolve([binding({ notifyOnTaskComplete: false })], ACTIVE)).toEqual(
      expect.objectContaining({
        ok: true,
        subject: 'relay.human.telegram.tg-main.chat-42',
        adapterId: 'tg-main',
        adapterType: 'telegram',
        chatId: 'chat-42',
        bindingId: 'b-1',
        notifyOnTaskComplete: false,
      })
    );
  });

  it.each([
    ['the agent has no binding', [binding({ agentId: 'other-agent' })], 'NO_BINDING'],
    ['its only binding is paused', [binding({ enabled: false })], 'NO_BINDING'],
    [
      'the binding may not start conversations',
      [binding({ canInitiate: false })],
      'INITIATE_NOT_ALLOWED',
    ],
  ])('refuses when %s', (_label, bindings, reason) => {
    expect(resolve(bindings, ACTIVE)).toMatchObject({ ok: false, reason });
  });

  it('returns NO_ACTIVE_SESSIONS with the available adapters when no chat is active', () => {
    expect(resolve([binding()])).toEqual({
      ok: false,
      reason: 'NO_ACTIVE_SESSIONS',
      availableAdapters: ['tg-main'],
    });
  });

  it('filters by channel adapter type when one is named', () => {
    const result = resolve(
      [
        binding({ id: 'b-1', adapterId: 'tg-lifeos' }),
        binding({ id: 'b-2', adapterId: 'slack-ops' }),
      ],
      {
        'b-1': [{ chatId: 'chat-77', sessionId: 's1' }],
        'b-2': [{ chatId: 'chat-99', sessionId: 's2', lastActivityAt: 9_000 }],
      },
      { channel: 'telegram', types: { 'slack-ops': 'slack' } }
    );
    expect(result).toMatchObject({ ok: true, adapterId: 'tg-lifeos', chatId: 'chat-77' });
  });

  it('picks the newest chat across bindings, not the last one listed (DOR-789)', () => {
    const result = resolve(
      [binding({ id: 'b-1' }), binding({ id: 'b-2', adapterId: 'tg-other' })],
      {
        'b-1': [
          { chatId: 'chat-fresh', sessionId: 's1', lastActivityAt: 9_000 },
          { chatId: 'chat-stale', sessionId: 's2', lastActivityAt: 1_000 },
        ],
        'b-2': [{ chatId: 'chat-other', sessionId: 's3', lastActivityAt: 2_000 }],
      }
    );
    expect(result).toMatchObject({ ok: true, chatId: 'chat-fresh', bindingId: 'b-1' });
  });

  it('addresses a per-user session in the binding chat, never the person, and refuses to guess', () => {
    const userSession = { 'b-1': [{ userId: 'U-person', sessionId: 's1', lastActivityAt: 5_000 }] };
    expect(
      resolve([binding({ chatId: 'C-group', sessionStrategy: 'per-user' })], userSession)
    ).toMatchObject({
      ok: true,
      chatId: 'C-group',
      subject: 'relay.human.telegram.tg-main.C-group',
    });
    expect(resolve([binding({ sessionStrategy: 'per-user' })], userSession)).toMatchObject({
      ok: false,
      reason: 'NO_ACTIVE_SESSIONS',
    });
  });
});

// Bridged bindings vacate the session map, so a live bridge row competes as a
// recency candidate (DOR-876).
describe('bridged bindings (§7.5)', () => {
  const bridged = binding({ bridge: 'room', roomId: 'room-1', chatId: 'chat-42' });

  it('A7.5: resolves the bridged chat with no session map entry, marked bridged', () => {
    const result = resolve(
      [bridged],
      {},
      {
        bridges: [
          { bindingId: 'b-1', chatId: 'chat-42', lastActivityAt: '2026-01-01T00:05:00.000Z' },
        ],
      }
    );
    expect(result).toMatchObject({
      ok: true,
      chatId: 'chat-42',
      subject: 'relay.human.telegram.tg-main.chat-42',
      bridged: true,
    });
  });

  it("ignores a bridge row belonging to another agent's binding", () => {
    const result = resolve(
      [bridged],
      {},
      { bridges: [{ bindingId: 'b-OTHER', chatId: 'chat-99' }] }
    );
    expect(result).toMatchObject({ ok: false, reason: 'NO_ACTIVE_SESSIONS' });
  });

  // On a tie the session-map candidate wins: a bridge row must beat it, never merely match it.
  it.each([
    ['a newer bridge row wins', 1_000, 5_000, 'chat-bridged', true],
    ['a newer session wins', 9_000, 1_000, 'chat-session', false],
    ['a tie keeps the session', 5_000, 5_000, 'chat-session', false],
  ])('%s', (_label, sessionAt, bridgeAt, chatId, isBridged) => {
    const result = resolve(
      [
        binding({ id: 'b-unbridged', adapterId: 'tg-unbridged' }),
        binding({
          id: 'b-bridged',
          adapterId: 'tg-bridged',
          bridge: 'room',
          roomId: 'r',
          chatId: 'chat-bridged',
        }),
      ],
      { 'b-unbridged': [{ chatId: 'chat-session', sessionId: 's1', lastActivityAt: sessionAt }] },
      {
        bridges: [
          {
            bindingId: 'b-bridged',
            chatId: 'chat-bridged',
            lastActivityAt: new Date(bridgeAt).toISOString(),
          },
        ],
      }
    );
    expect(result).toMatchObject({ ok: true, chatId, bridged: isBridged });
  });

  it('a malformed lastActivityAt listed first does not freeze the scan', () => {
    const result = resolve(
      [
        binding({
          id: 'b-bad',
          adapterId: 'tg-bad',
          bridge: 'room',
          roomId: 'r1',
          chatId: 'chat-bad',
        }),
        binding({
          id: 'b-good',
          adapterId: 'tg-good',
          bridge: 'room',
          roomId: 'r2',
          chatId: 'chat-good',
        }),
      ],
      {},
      {
        bridges: [
          { bindingId: 'b-bad', chatId: 'chat-bad', lastActivityAt: 'not-a-real-timestamp' },
          {
            bindingId: 'b-good',
            chatId: 'chat-good',
            lastActivityAt: new Date(9_000).toISOString(),
          },
        ],
      }
    );
    expect(result).toMatchObject({ ok: true, chatId: 'chat-good', bindingId: 'b-good' });
  });
});
