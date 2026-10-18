/**
 * How a Direct chat's pings sit in its transcript (rule S12, DOR-2997): once,
 * where they landed, as their author's message, with the unread rule above the
 * first one the person has not read.
 *
 * @module widgets/session/__tests__/direct-chat-notes
 */
import { describe, expect, it } from 'vitest';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { ChatMessage } from '@/layers/shared/model';
import { withDirectNotes, type DirectChatLog } from '../model/use-direct-chat-notes';

const AGENT = 'author-ana';
const PERSON = 'author-dorian';

function entry(seq: number, at: string, over: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'dm-ana',
    seq,
    id: `e${seq}`,
    authorId: AGENT,
    kind: 'post',
    body: { text: `entry ${seq}` },
    mentions: [],
    mentionSpans: [],
    sessionId: null,
    cascadeRoot: `e${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: at,
    ...over,
  } as RoomEntry;
}

function message(id: string, at: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content: id, parts: [], timestamp: at, ...over };
}

function tool(toolName: string, input: Record<string, string>): ChatMessage['parts'][number] {
  return {
    type: 'tool_call',
    toolCallId: `call-${toolName}`,
    toolName,
    input: JSON.stringify(input),
    status: 'complete',
  };
}

function log(entries: RoomEntry[], over: Partial<DirectChatLog> = {}): DirectChatLog {
  return {
    roomId: 'dm-ana',
    entries,
    sessionIds: ['direct', 'direct-old'],
    agentAuthorIds: new Set([AGENT]),
    readSeq: 0,
    ready: true,
    ...over,
  };
}

const T = (minute: number) => `2026-10-17T12:${String(minute).padStart(2, '0')}:00.000Z`;

describe('withDirectNotes', () => {
  it('leaves an ordinary chat alone', () => {
    const transcript = [message('m1', T(1))];
    expect(withDirectNotes(transcript, undefined).messages).toBe(transcript);
  });

  it('puts a ping where it landed, as the agent’s message', () => {
    const transcript = [message('m1', T(1)), message('m2', T(5))];
    const { messages } = withDirectNotes(transcript, log([entry(1, T(3))]));

    expect(messages.map((m) => m.id)).toEqual(['m1', 'direct-note-e1', 'm2']);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'entry 1' });
  });

  it('never shows twice what the transcript already holds', () => {
    const transcript = [
      message('m1', T(1), { roomMessage: { roomId: 'dm-ana', entryId: 'e1' } }),
      message('m2', T(2), { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] }),
    ];
    const entries = [
      entry(1, T(1), { authorId: PERSON }),
      // Written by this session, under the id it held before a rename.
      entry(2, T(2), { sessionId: 'direct-old', body: { text: 'Done.' } }),
      // In a thread, which a Direct chat does not draw.
      entry(3, T(3), { threadRootEntryId: 'e2' }),
      entry(4, T(4)),
    ];

    const { messages } = withDirectNotes(transcript, log(entries));

    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'direct-note-e4']);
  });

  it('draws what this session wrote once its transcript is gone', () => {
    // Claude Code deleted the seat's transcript: the person's "hi" and the
    // agent's reply both live only in the log now.
    const entries = [
      entry(1, T(1), { authorId: PERSON, body: { text: 'hi' } }),
      entry(2, T(2), { sessionId: 'direct', body: { text: 'Hey! What are you on today?' } }),
    ];

    const { messages } = withDirectNotes([], log(entries));

    expect(messages.map((m) => m.id)).toEqual(['direct-note-e1', 'direct-note-e2']);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Hey! What are you on today?',
    });
  });

  it('draws only what a cut-short transcript no longer holds', () => {
    const posted = message('m1', T(3), {
      role: 'assistant',
      parts: [
        tool('mcp__dorkos__post_to_room', { roomId: 'dm-ana', text: 'still here' }),
        { type: 'text', text: 'Said it in the DM.' },
      ],
    });
    const entries = [
      entry(1, T(1), { sessionId: 'direct-old', body: { text: 'lost with the old file' } }),
      entry(2, T(2), { sessionId: 'direct', body: { text: 'still here' } }),
      entry(3, T(4), { sessionId: 'direct', body: { text: 'Said it in the DM.' } }),
    ];

    const { messages } = withDirectNotes([posted], log(entries));

    expect(messages.map((m) => m.id)).toEqual(['direct-note-e1', 'm1']);
  });

  it('matches a ping sent from inside the chat, and a reply posted as its joined paragraphs', () => {
    const turn = message('m1', T(3), {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me check.\n' },
        tool('mcp__dorkos__relay_notify_user', { message: 'Heads up: CI is red.' }),
        { type: 'text', text: 'Fixed it.' },
      ],
    });
    const entries = [
      entry(1, T(1), { sessionId: 'direct', body: { text: 'Heads up: CI is red.' } }),
      entry(2, T(2), { sessionId: 'direct', body: { text: 'Let me check.\n\nFixed it.' } }),
    ];

    expect(withDirectNotes([turn], log(entries)).messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('is not fooled by the same words in a tool that does not post', () => {
    const turn = message('m1', T(3), {
      role: 'assistant',
      parts: [tool('Write', { file_path: 'notes.md', content: 'lost reply' })],
    });
    const entries = [entry(1, T(1), { sessionId: 'direct', body: { text: 'lost reply' } })];

    const { messages } = withDirectNotes([turn], log(entries));

    expect(messages.map((m) => m.id)).toEqual(['direct-note-e1', 'm1']);
  });

  describe('while older pages of the transcript are unread', () => {
    const window = [message('m1', T(5), { role: 'assistant', parts: [] })];

    it('takes what this session wrote before the window to be in them', () => {
      const entries = [entry(1, T(1), { sessionId: 'direct' })];
      expect(withDirectNotes(window, log(entries), false).messages.map((m) => m.id)).toEqual([
        'm1',
      ]);
    });

    it('still draws what it wrote inside the window and the window lacks', () => {
      const entries = [entry(1, T(7), { sessionId: 'direct' })];
      expect(withDirectNotes(window, log(entries), false).messages.map((m) => m.id)).toEqual([
        'm1',
        'direct-note-e1',
      ]);
    });

    it('still draws a ping from another chat', () => {
      const entries = [entry(1, T(1))];
      expect(withDirectNotes(window, log(entries), false).messages.map((m) => m.id)).toEqual([
        'direct-note-e1',
        'm1',
      ]);
    });
  });

  it('reads the person’s own old posts as theirs', () => {
    const { messages } = withDirectNotes([], log([entry(1, T(1), { authorId: PERSON })]));
    expect(messages[0]).toMatchObject({ role: 'user' });
  });

  it('puts the unread rule above the first ping the person has not read', () => {
    const transcript = [message('m1', T(1))];
    const view = withDirectNotes(transcript, log([entry(1, T(2)), entry(2, T(3))], { readSeq: 1 }));

    expect(view.lastSeenBeforeUnread).toBe('direct-note-e1');
    expect(view.unreadFromStart).toBe(false);
  });

  it('starts the rule at the top when the first ping is the first message', () => {
    const view = withDirectNotes([], log([entry(1, T(1))], { readSeq: 0 }));
    expect(view.unreadFromStart).toBe(true);
  });

  it('keeps a ping above a reply that is still streaming', () => {
    const transcript = [message('live', '', { role: 'assistant' })];
    const { messages } = withDirectNotes(transcript, log([entry(1, T(9))]));
    expect(messages.map((m) => m.id)).toEqual(['direct-note-e1', 'live']);
  });
});
