/**
 * The `chat` capability domain (spec `spin-off-chats` §1): the caller is the
 * verified turn and nothing else, a refusal is an answer rather than a throw,
 * and the three tools exist only on the in-session server.
 */
import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../../core/capabilities/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { chatCallerOf, chatDomain } from '../chat-capabilities.js';
import { ChatMessageError } from '../chat-message-service.js';
import type { ChatReadDeps } from '../chat-read.js';

const identity: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-10-09T10:00:00.000Z',
} as AgentIdentity;

function capability(id: string) {
  const found = chatDomain.capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`chat domain does not declare ${id}`);
  return found;
}

function depsWith(service: { send?: unknown; stopChat?: unknown }, read?: Partial<ChatReadDeps>) {
  return {
    logger: noopLogger,
    chatMessageDeps: {
      service: {
        send: vi.fn(),
        stopChat: vi.fn(),
        ...service,
      },
      read: {
        mayRead: vi.fn(async () => false),
        ...read,
      } as unknown as ChatReadDeps,
    },
  } as unknown as CapabilityDeps;
}

describe('chatCallerOf', () => {
  it('is the verified session and its agent', () => {
    expect(chatCallerOf({ sessionId: 's1', identity })).toEqual({
      sessionId: 's1',
      agentPath: '/agents/ana',
    });
  });

  it.each([
    ['no session', { identity } as CapabilityHandlerContext],
    ['no identity', { sessionId: 's1' }],
    ['a revoked identity', { sessionId: 's1', identity: { ...identity, inactive: 'revoked' } }],
    ['an expired identity', { sessionId: 's1', identity: { ...identity, inactive: 'expired' } }],
  ] as const)('is null with %s', (_label, context) => {
    expect(chatCallerOf(context as CapabilityHandlerContext)).toBeNull();
  });
});

describe('chat domain', () => {
  it('declares exactly the three in-session tools, in the messages area', () => {
    expect(chatDomain.capabilities.map((c) => [c.id, c.surfaces.mcp?.toolName, c.area])).toEqual([
      ['chat.send', 'chat_send', 'messages'],
      ['chat.read', 'chat_read', 'messages'],
      ['chat.stop', 'chat_stop', 'messages'],
    ]);
    for (const c of chatDomain.capabilities) {
      expect(c.surfaces.mcp?.servers).toEqual(['in-session']);
    }
  });

  it.each(['chat.send', 'chat.read', 'chat.stop'])(
    '%s refuses a call with no calling chat, without touching the service',
    async (id) => {
      const send = vi.fn();
      const stopChat = vi.fn();
      const mayRead = vi.fn();
      const deps = depsWith({ send, stopChat }, { mayRead });
      const input = { to: 'x', message: 'hi', chat: 'x' };

      const result = await capability(id).invoke(deps, input as never, { identity });

      expect(result).toMatchObject({ ok: false, code: 'NO_CHAT', error: expect.any(String) });
      expect(send).not.toHaveBeenCalled();
      expect(stopChat).not.toHaveBeenCalled();
      expect(mayRead).not.toHaveBeenCalled();
    }
  );

  it('sends as the verified caller and answers the receipt', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1', chatId: 'b', status: 'queued' as const }));
    const deps = depsWith(
      { send },
      { describe: vi.fn(async () => ({ title: 'Release notes', agent: 'Bo' })) }
    );

    const result = await capability('chat.send').invoke(deps, { to: 'b', message: 'hi' } as never, {
      sessionId: 's1',
      identity,
    });

    expect(send).toHaveBeenCalledWith(
      { sessionId: 's1', agentPath: '/agents/ana' },
      {
        to: 'b',
        message: 'hi',
      }
    );
    // The chat it landed in comes back by name, with a link to use instead of
    // the id (DOR-2824).
    expect(result).toEqual({
      ok: true,
      messageId: 'm1',
      chatId: 'b',
      chatTitle: 'Release notes',
      link: '[Release notes](/session?session=b)',
      status: 'queued',
    });
  });

  it('still answers a sent message when the chat title cannot be read', async () => {
    const send = vi.fn(async () => ({ messageId: 'm1', chatId: 'b', status: 'queued' as const }));
    const deps = depsWith(
      { send },
      {
        describe: vi.fn(async () => {
          throw new Error('runtime offline');
        }),
      }
    );

    const result = await capability('chat.send').invoke(deps, { to: 'b', message: 'hi' } as never, {
      sessionId: 's1',
      identity,
    });

    expect(result).toMatchObject({
      ok: true,
      chatTitle: null,
      link: '[New chat](/session?session=b)',
    });
  });

  it('answers a ChatMessageError as a refusal with its code', async () => {
    const send = vi.fn(async () => {
      throw new ChatMessageError('SELF', 'That is your own chat.');
    });
    const result = await capability('chat.send').invoke(
      depsWith({ send }),
      { to: 's1', message: 'hi' } as never,
      { sessionId: 's1', identity }
    );
    expect(result).toEqual({ ok: false, code: 'SELF', error: 'That is your own chat.' });
  });

  it('answers a read refusal the same way', async () => {
    const result = await capability('chat.read').invoke(
      depsWith({}, { mayRead: vi.fn(async () => false) }),
      { chat: 'other' } as never,
      { sessionId: 's1', identity }
    );
    expect(result).toMatchObject({ ok: false, code: 'NOT_READABLE' });
  });

  it('lets any other error through rather than dressing it up as a refusal', async () => {
    const stopChat = vi.fn(async () => {
      throw new Error('database is gone');
    });
    await expect(
      capability('chat.stop').invoke(depsWith({ stopChat }), { chat: 'b' } as never, {
        sessionId: 's1',
        identity,
      })
    ).rejects.toThrow('database is gone');
  });
});
