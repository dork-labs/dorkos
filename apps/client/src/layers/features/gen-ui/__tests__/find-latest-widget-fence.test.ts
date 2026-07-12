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

  it('a fence followed by a later TEXT-only message stays live (fence-based supersede — the DOR-302 repro)', () => {
    // The live repro: turn 1 emits the board, turn 2 is the agent's plain-text
    // reply ("opened it!"). Under the retired positional rule the reply
    // superseded the board and the PIP arrived dead; under the fence-based rule
    // only a NEWER FENCE stales a board.
    const state = streamState({
      messages: [
        historyMessage('m1', `board here ${BOARD_A}`),
        historyMessage('m2', 'no widget in this one — opened it for you!'),
      ],
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

  it('a fence followed by a later FENCE-BEARING message returns the newer fence', () => {
    const state = streamState({
      messages: [
        historyMessage('m1', `board here ${BOARD_A}`),
        historyMessage('m2', `here is the next turn ${BOARD_B}`),
      ],
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m2');
    expect(result?.code).toBe('{"kind":"board","id":"b"}');
    expect(result?.isLatest).toBe(true);
  });

  it('the optimistic user message never supersedes an earlier assistant board (it carries no fence)', () => {
    const state = streamState({
      messages: [historyMessage('m1', `board here ${BOARD_A}`)],
      optimisticUserMessage: { id: 'u1', content: 'ok thanks' },
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('m1');
    expect(result?.isLatest).toBe(true);
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

  it('a thinking-only in-progress turn does NOT stale a history board (no fence in the turn)', () => {
    // Fence-based supersede: a turn that has streamed no fence-bearing text
    // cannot supersede anything — the operator keeps playing while the agent
    // thinks or runs tools.
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
    expect(result?.isLatest).toBe(true);
  });

  it('a fence streaming in the in-progress turn wins over a history fence (newest fence wins)', () => {
    const inProgressTurn: SessionEvent[] = [
      { type: 'turn_start', seq: 1 },
      { type: 'text_delta', seq: 2, text: `fresh board:\n${BOARD_B}` },
    ];
    const state = streamState({
      messages: [historyMessage('m1', `board here\n${BOARD_A}`)],
      inProgressTurn,
    });

    const result = findLatestWidgetFence(state);

    expect(result?.sourceMessageKey).toBe('__in_progress_turn__');
    expect(result?.code).toBe('{"kind":"board","id":"b"}');
    expect(result?.isStreaming).toBe(true);
    expect(result?.isLatest).toBe(true);
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
});
