import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import { DEFAULT_SESSION_STREAM_STATE } from '@/layers/entities/session';
import type { SessionStreamState } from '@/layers/entities/session';
import { selectRenderedMessages } from '../model/stream/derive-rendered-state';
import type { ChatMessage } from '../model/chat-types';

const KICKOFF_TEXT = '<dork-kickoff>\nintroduce yourself from SOUL.md\n</dork-kickoff>';
const GREETING_TEXT = "Hi — I'm Keeper. Want me to do a dry run?";

// Legacy-path fixtures (ChatMessage[] — the send-path fallback list).
const KICKOFF: ChatMessage = {
  id: 'kick-1',
  role: 'user',
  content: KICKOFF_TEXT,
  parts: [],
  timestamp: '2026-07-20T00:00:00.000Z',
};
const GREETING: ChatMessage = {
  id: 'greet-1',
  role: 'assistant',
  content: GREETING_TEXT,
  parts: [{ type: 'text', text: GREETING_TEXT }],
  timestamp: '2026-07-20T00:00:01.000Z',
};

// Projected-path fixtures (HistoryMessage[] — the hydrated snapshot list).
const KICKOFF_HISTORY: HistoryMessage = { id: 'kick-1', role: 'user', content: KICKOFF_TEXT };
const GREETING_HISTORY: HistoryMessage = {
  id: 'greet-1',
  role: 'assistant',
  content: GREETING_TEXT,
  parts: [{ type: 'text', text: GREETING_TEXT }],
};

describe('selectRenderedMessages — kickoff honesty (M4)', () => {
  it('filters a kickoff out of the legacy fallback so it never becomes a user bubble', () => {
    const rendered = selectRenderedMessages(DEFAULT_SESSION_STREAM_STATE, [KICKOFF, GREETING]);
    expect(rendered.map((m) => m.id)).toEqual(['greet-1']);
    expect(rendered.some((m) => m.role === 'user')).toBe(false);
  });

  it('filters a kickoff out of the projected (reloaded-history) path', () => {
    const stream: SessionStreamState = {
      ...DEFAULT_SESSION_STREAM_STATE,
      messages: [KICKOFF_HISTORY, GREETING_HISTORY],
    };
    const rendered = selectRenderedMessages(stream, []);
    expect(rendered.map((m) => m.id)).toEqual(['greet-1']);
  });

  it('leaves ordinary conversations untouched (no needless copy)', () => {
    const ordinary: ChatMessage[] = [{ ...GREETING, role: 'user', content: 'hello' }, GREETING];
    const rendered = selectRenderedMessages(DEFAULT_SESSION_STREAM_STATE, ordinary);
    expect(rendered).toBe(ordinary);
  });
});

// Adversarial preservation at the RENDER backstop: genuine content that merely
// touches the marker must never vanish from the visible transcript. These were
// all suppressed under the pre-review either/or predicate.
describe('selectRenderedMessages — adversarial preservation', () => {
  it('shows a user message that only STARTS with the open tag', () => {
    const asks: ChatMessage[] = [{ ...KICKOFF, content: '<dork-kickoff> what is this?' }, GREETING];
    expect(selectRenderedMessages(DEFAULT_SESSION_STREAM_STATE, asks)).toBe(asks);
  });

  it('shows a user message that only ENDS with the close tag', () => {
    const ends: ChatMessage[] = [
      { ...KICKOFF, content: 'my notes on fences ... </dork-kickoff>' },
      GREETING,
    ];
    expect(selectRenderedMessages(DEFAULT_SESSION_STREAM_STATE, ends)).toBe(ends);
  });

  it('shows an ASSISTANT message shaped like the envelope (role scope)', () => {
    const assistantEnvelope: ChatMessage[] = [
      { ...GREETING, id: 'u1', role: 'user', content: 'hi', parts: [] },
      { ...GREETING, id: 'a1', content: KICKOFF_TEXT },
    ];
    expect(selectRenderedMessages(DEFAULT_SESSION_STREAM_STATE, assistantEnvelope)).toBe(
      assistantEnvelope
    );
  });

  it('shows a full-envelope user paste later in the conversation (first-user-record scope)', () => {
    const later: ChatMessage[] = [
      { ...KICKOFF, id: 'u1', content: 'hello' },
      GREETING,
      { ...KICKOFF, id: 'u2' },
    ];
    expect(selectRenderedMessages(DEFAULT_SESSION_STREAM_STATE, later)).toBe(later);
  });
});
