/**
 * Reading messaging tool calls and placing chat-message rows (spec
 * `spin-off-chats` §6).
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessageStamp, SentChatMessage } from '@dorkos/shared/chat-messages';
import type { ChatMessage } from '@/layers/shared/model';
import {
  deliveryLabel,
  interleaveStopNotices,
  readMessagingCall,
  sentRecordFor,
  sentSummary,
  stampTags,
  transcriptIdForChatMessage,
} from '../chat-messaging';
import { resolveMessageAuthor } from '../resolve-message-author';

const SENT: SentChatMessage = {
  id: 'cm-1',
  kind: 'message',
  to: { chatId: 'chat-b' },
  text: 'Hi',
  delivery: 'queue',
  status: 'queued',
  sentAt: '2026-10-09T10:00:00.000Z',
};

const STAMP: ChatMessageStamp = {
  id: 'cm-9',
  kind: 'report',
  from: { chatId: 'chat-b', chatTitle: 'Fix it', agentName: 'Builder', agentId: 'builder' },
  text: 'Done.',
  delivery: 'queue',
  status: 'working',
  sentAt: '2026-10-09T10:00:00.000Z',
};

describe('readMessagingCall', () => {
  it('reads chat_send under any server prefix, its receipt, and its refusal', () => {
    const ok = readMessagingCall({
      toolName: 'mcp__dorkos__chat_send',
      input: JSON.stringify({ to: 'chat-b', message: 'Hi', summary: 'Say hi', delivery: 'steer' }),
      result: JSON.stringify({ ok: true, messageId: 'cm-1', chatId: 'chat-b', status: 'queued' }),
    });
    expect(ok).toMatchObject({
      tool: 'chat_send',
      to: 'chat-b',
      message: 'Hi',
      summary: 'Say hi',
      delivery: 'steer',
      messageId: 'cm-1',
      chatId: 'chat-b',
    });
    expect(ok?.error).toBeUndefined();
    const refused = readMessagingCall({
      toolName: 'dorkos_chat_send',
      input: '{}',
      result: JSON.stringify({ ok: false, code: 'SELF', error: 'That is your own chat.' }),
    });
    expect(refused?.error).toBe('That is your own chat.');
  });

  it('reads a result wrapped in MCP content blocks', () => {
    const call = readMessagingCall({
      toolName: 'chat_send',
      input: '{}',
      result: JSON.stringify({
        content: [{ type: 'text', text: '{"ok":true,"messageId":"cm-2"}' }],
      }),
    });
    expect(call?.messageId).toBe('cm-2');
  });

  it('reads session_start and chat_stop by their own field names', () => {
    expect(
      readMessagingCall({
        toolName: 'mcp__dorkos__session_start',
        input: JSON.stringify({ prompt: 'Cut it', cwd: '/w' }),
        result: JSON.stringify({ sessionId: 'chat-new' }),
      })
    ).toMatchObject({ tool: 'session_start', message: 'Cut it', chatId: 'chat-new' });
    expect(
      readMessagingCall({
        toolName: 'chat_stop',
        input: JSON.stringify({ chat: 'chat-b', reason: 'wrong branch' }),
      })
    ).toMatchObject({ tool: 'chat_stop', to: 'chat-b', reason: 'wrong branch' });
  });

  it('is null for every other tool, chat_read included', () => {
    expect(readMessagingCall({ toolName: 'Read', input: '{}' })).toBeNull();
    expect(readMessagingCall({ toolName: 'mcp__dorkos__chat_read', input: '{}' })).toBeNull();
  });
});

describe('the Sent card words', () => {
  it('finds the server record by receipt id, or by the spin-off a start made', () => {
    const start = { ...SENT, id: 'cm-s', kind: 'start' as const, to: { chatId: 'chat-new' } };
    expect(sentRecordFor({ tool: 'chat_send', messageId: 'cm-1' }, [SENT, start])).toBe(SENT);
    expect(sentRecordFor({ tool: 'session_start', chatId: 'chat-new' }, [SENT, start])).toBe(start);
  });

  it('labels every state, the queue position and an interrupt', () => {
    expect(deliveryLabel({ ...SENT, position: 2 }, {}).label).toBe('Queued · #2');
    expect(deliveryLabel({ ...SENT, status: 'working', delivery: 'interrupt' }, {}).label).toBe(
      'Interrupted, working'
    );
    expect(deliveryLabel({ ...SENT, status: 'delivered' }, {}).label).toBe('Delivered');
    expect(deliveryLabel({ ...SENT, status: 'replied' }, {}).label).toBe('Replied');
    expect(deliveryLabel(undefined, { pending: true }).label).toBe('Sending');
    expect(deliveryLabel(SENT, { error: 'no' }).tone).toBe('error');
  });

  it('summarizes with the label, else the first line', () => {
    expect(sentSummary('Fix it', 'long')).toBe('Fix it');
    expect(sentSummary(undefined, '\n## Plan\nmore')).toBe('Plan');
  });

  it('tags reports, starts, steers and interrupts', () => {
    expect(stampTags({ kind: 'report', delivery: 'queue' })).toEqual(['Report']);
    expect(stampTags({ kind: 'message', delivery: 'steer' })).toEqual(['Steered in']);
    expect(stampTags({ kind: 'start', delivery: 'interrupt' })).toEqual([
      'Started this chat',
      'Interrupted',
    ]);
  });
});

describe('placing and finding chat messages in a transcript', () => {
  const msg = (id: string, at: string): ChatMessage => ({
    id,
    role: 'assistant',
    content: '',
    parts: [],
    timestamp: at,
  });

  it('puts a stop after the last message sent at or before it', () => {
    const out = interleaveStopNotices(
      [msg('a', '2026-10-09T10:00:00Z'), msg('b', '2026-10-09T10:05:00Z')],
      [{ id: 's1', by: STAMP.from, at: '2026-10-09T10:02:00Z' }]
    );
    expect(out.map((m) => m.id)).toEqual(['a', 'chat-stop-s1', 'b']);
    expect(out[1]!._chatStop?.id).toBe('s1');
  });

  it('finds the row a chat message id lives in, on either side', () => {
    const history = [
      { id: 'u1', chatMessages: [STAMP] },
      {
        id: 'a1',
        toolCalls: [
          {
            toolCallId: 't',
            toolName: 'mcp__dorkos__chat_send',
            input: '{}',
            result: '{"ok":true,"messageId":"cm-1"}',
            status: 'complete' as const,
          },
        ],
      },
    ];
    expect(transcriptIdForChatMessage(history, 'cm-9')).toBe('u1');
    expect(transcriptIdForChatMessage(history, 'cm-1')).toBe('a1');
    expect(transcriptIdForChatMessage(history, 'nope')).toBeUndefined();
  });
});

describe('who a received message is from', () => {
  it('is the sending agent, never "You", in a group of its own', () => {
    const author = resolveMessageAuthor(
      { id: 'u', role: 'user', content: 'fenced', parts: [], timestamp: '', chatMessages: [STAMP] },
      { humanName: 'Dorian', agent: { id: 'builder', displayName: 'Builder' } }
    );
    expect(author.kind).toBe('agent');
    expect(author.displayName).toBe('Builder');
    expect(author.id).not.toBe('builder');
    expect(author.displayName).not.toBe('Dorian');
  });

  it('a stop line is the system speaking', () => {
    const author = resolveMessageAuthor(
      {
        id: 's',
        role: 'user',
        content: '',
        parts: [],
        timestamp: '',
        _chatStop: { id: 's1', by: STAMP.from, at: '' },
      },
      {}
    );
    expect(author.kind).toBe('system');
  });

  it('a message with no stamp is still the person', () => {
    expect(
      resolveMessageAuthor({ id: 'p', role: 'user', content: 'hi', parts: [], timestamp: '' }, {})
        .kind
    ).toBe('human');
  });
});
