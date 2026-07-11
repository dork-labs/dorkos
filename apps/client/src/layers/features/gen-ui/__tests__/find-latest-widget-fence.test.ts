import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { DEFAULT_SESSION_STREAM_STATE, type SessionStreamState } from '@/layers/entities/session';
import { findLatestWidgetFence } from '../lib/find-latest-widget-fence';

/** Build a minimal `HistoryMessage` fixture, defaulting to an assistant turn. */
function historyMessage(id: string, content: string): HistoryMessage {
  return { id, role: 'assistant', content };
}

/** Build a `SessionStreamState` fixture, overriding only what a test cares about. */
function streamState(overrides: Partial<SessionStreamState>): SessionStreamState {
  return { ...DEFAULT_SESSION_STREAM_STATE, ...overrides };
}

const BOARD_A = '```dorkos-ui\n{"kind":"board","id":"a"}\n```';
const BOARD_B = '```dorkos-ui\n{"kind":"board","id":"b"}\n```';

describe('findLatestWidgetFence', () => {
  it('returns null for a session with no fences anywhere', () => {
    const state = streamState({
      messages: [historyMessage('m1', 'just plain text'), historyMessage('m2', 'more plain text')],
    });

    expect(findLatestWidgetFence(state)).toBeNull();
  });

  it('newest-message-wins: two completed messages both carry a fence, the later one wins', () => {
    const state = streamState({
      messages: [
        historyMessage('m1', `before\n${BOARD_A}\nafter`),
        historyMessage('m2', `before\n${BOARD_B}\nafter`),
      ],
    });

    const result = findLatestWidgetFence(state);

    expect(result).toEqual({
      code: '{"kind":"board","id":"b"}',
      isIncomplete: false,
      sourceMessageKey: 'm2',
      isLatest: true,
      isStreaming: false,
    });
  });

  it('an older message with a fence is superseded by a newer fence-less message (isLatest: false)', () => {
    const state = streamState({
      messages: [
        historyMessage('m1', `board here ${BOARD_A}`),
        historyMessage('m2', 'no widget in this one'),
      ],
    });

    const result = findLatestWidgetFence(state);

    expect(result).toEqual({
      code: '{"kind":"board","id":"a"}',
      isIncomplete: false,
      sourceMessageKey: 'm1',
      isLatest: false,
      isStreaming: false,
    });
  });

  it('the optimistic user message slot supersedes an earlier assistant board (isLatest: false)', () => {
    const state = streamState({
      messages: [historyMessage('m1', `board here ${BOARD_A}`)],
      optimisticUserMessage: { id: 'u1', content: 'ok thanks' },
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m1');
    expect(result?.isLatest).toBe(false);
  });

  it('last-fence-within-message: a single message with two fences returns the second body', () => {
    const state = streamState({
      messages: [historyMessage('m1', `${BOARD_A}\nsome text between\n${BOARD_B}`)],
    });

    const result = findLatestWidgetFence(state);

    expect(result?.code).toBe('{"kind":"board","id":"b"}');
    expect(result?.sourceMessageKey).toBe('m1');
  });

  it('a fence with trailing text after the closing delimiter is still extracted cleanly', () => {
    const state = streamState({
      messages: [historyMessage('m1', `${BOARD_A}\nhope that helps!`)],
    });

    const result = findLatestWidgetFence(state);

    expect(result).toEqual({
      code: '{"kind":"board","id":"a"}',
      isIncomplete: false,
      sourceMessageKey: 'm1',
      isLatest: true,
      isStreaming: false,
    });
  });

  it('a still-streaming in-progress turn with an unclosed fence returns isIncomplete + isStreaming + isLatest', () => {
    const inProgressTurn: SessionEvent[] = [
      { type: 'turn_start', seq: 1 },
      { type: 'text_delta', seq: 2, text: 'here is a board:\n```dorkos-ui\n{"kind":"board"' },
    ];
    const state = streamState({
      messages: [historyMessage('m1', 'earlier turn, no fence')],
      inProgressTurn,
    });

    const result = findLatestWidgetFence(state);

    expect(result).toEqual({
      code: '{"kind":"board"',
      isIncomplete: true,
      sourceMessageKey: '__in_progress_turn__',
      isLatest: true,
      isStreaming: true,
    });
  });

  it('concatenates multiple text_delta events in order before scanning for a fence', () => {
    const inProgressTurn: SessionEvent[] = [
      { type: 'text_delta', seq: 1, text: 'part one ' },
      { type: 'text_delta', seq: 2, text: `${BOARD_A}` },
    ];
    const state = streamState({ inProgressTurn });

    const result = findLatestWidgetFence(state);

    expect(result?.code).toBe('{"kind":"board","id":"a"}');
    expect(result?.isIncomplete).toBe(false);
    expect(result?.isStreaming).toBe(true);
  });

  it('a thinking-only in-progress turn supersedes a history board (parity with buildInProgressMessage)', () => {
    // Regression (review finding 1): the inline projection appends the trailing
    // bubble for ANY renderable part, not just text — a thinking-only turn must
    // freeze the history board here too, or PIP stays clickable while inline froze.
    const inProgressTurn: SessionEvent[] = [
      { type: 'turn_start', seq: 1 },
      { type: 'thinking_delta', seq: 2, text: 'pondering the next move...' },
    ];
    const state = streamState({
      messages: [historyMessage('m1', `board here\n${BOARD_A}`)],
      inProgressTurn,
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m1');
    expect(result?.isLatest).toBe(false);
  });

  it('a tool-call-only in-progress turn supersedes a history board (parity with buildInProgressMessage)', () => {
    const inProgressTurn: SessionEvent[] = [
      { type: 'turn_start', seq: 1 },
      { type: 'tool_call', seq: 2, toolCallId: 't1', toolName: 'Bash', status: 'running' },
    ];
    const state = streamState({
      messages: [historyMessage('m1', `board here\n${BOARD_A}`)],
      inProgressTurn,
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m1');
    expect(result?.isLatest).toBe(false);
  });

  it('a turn with only non-renderable events does NOT supersede the history board', () => {
    // turn_start and a non-failed operation_progress fold no bubble part in the
    // inline projection, so no phantom trailing message may claim the latest slot.
    const inProgressTurn: SessionEvent[] = [
      { type: 'turn_start', seq: 1 },
      {
        type: 'operation_progress',
        seq: 2,
        operation: 'compaction',
        state: 'started',
        determinate: false,
      },
    ];
    const state = streamState({
      messages: [historyMessage('m1', `board here\n${BOARD_A}`)],
      inProgressTurn,
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m1');
    expect(result?.isLatest).toBe(true);
  });

  it('pending interactions alone occupy the trailing bubble slot (history board isLatest false)', () => {
    // The inline projection folds snapshot-recovered pendingInteractions into the
    // trailing bubble even with an EMPTY turn (foldPendingInteractions parity).
    const state = streamState({
      messages: [historyMessage('m1', `board here\n${BOARD_A}`)],
      pendingInteractions: [
        {
          type: 'approval',
          id: 'i1',
          startedAt: 0,
          remainingMs: 60_000,
          toolName: 'Bash',
          input: '{}',
          hasSuggestions: false,
        },
      ],
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m1');
    expect(result?.isLatest).toBe(false);
  });

  it('tolerates CRLF line endings: a fence closed with "```\\r" still counts as complete', () => {
    const crlfContent = 'before\r\n```dorkos-ui\r\n{"kind":"board","id":"a"}\r\n```\r\nafter';
    const state = streamState({ messages: [historyMessage('m1', crlfContent)] });

    const result = findLatestWidgetFence(state);

    expect(result).toEqual({
      code: '{"kind":"board","id":"a"}',
      isIncomplete: false,
      sourceMessageKey: 'm1',
      isLatest: true,
      isStreaming: false,
    });
  });

  it('a completed message AFTER a fence-bearing one but with no fence still supersedes it (positional rule)', () => {
    const state = streamState({
      messages: [
        historyMessage('m1', `board here ${BOARD_A}`),
        historyMessage('m2', 'a plain follow-up with no widget at all'),
      ],
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m1');
    expect(result?.isLatest).toBe(false);
  });
});
