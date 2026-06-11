import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { reconstructHistoryFromEvents } from '../event-log-history.js';

// Purpose: Decision 1 / runtime-agnosticism — a log-backed runtime's completed
// history must be reconstructible from the DorkOS-owned event stream alone
// (no JSONL, no native transcript). These tests pin the folding rules.

/** Shorthand for building seq'd events without repeating the cast dance. */
function events(...list: SessionEvent[]): SessionEvent[] {
  return list;
}

describe('reconstructHistoryFromEvents', () => {
  it('folds a completed turn into a user + assistant message pair', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'Hello' },
        { seq: 2, type: 'text_delta', text: 'Echo: ' },
        { seq: 3, type: 'text_delta', text: 'Hello' },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages).toEqual([
      { id: 'user-1', role: 'user', content: 'Hello' },
      { id: 'assistant-1', role: 'assistant', content: 'Echo: Hello' },
    ]);
  });

  it('merges tool_call/tool_progress/tool_result into one HistoryToolCall', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'run it' },
        {
          seq: 2,
          type: 'tool_call',
          toolCallId: 'tc-1',
          toolName: 'Bash',
          status: 'running',
          input: '{"command":"echo hi"}',
        },
        { seq: 3, type: 'tool_progress', toolCallId: 'tc-1', content: 'hi\n' },
        {
          seq: 4,
          type: 'tool_result',
          toolCallId: 'tc-1',
          toolName: 'Bash',
          status: 'complete',
          result: 'hi',
        },
        { seq: 5, type: 'text_delta', text: 'Done.' },
        { seq: 6, type: 'turn_end' }
      )
    );

    expect(messages).toEqual([
      { id: 'user-1', role: 'user', content: 'run it' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done.',
        toolCalls: [
          {
            toolCallId: 'tc-1',
            toolName: 'Bash',
            status: 'complete',
            input: '{"command":"echo hi"}',
            progressOutput: 'hi\n',
            result: 'hi',
          },
        ],
      },
    ]);
  });

  it("emits the OPEN turn's user message but no assistant message", () => {
    // Mid-turn parity with the Claude adapter: the user message is "on disk"
    // (in the log) the moment the turn starts, so a mid-turn snapshot shows the
    // prompt; the assistant side is delivered live via inProgressTurn instead.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'first' },
        { seq: 2, type: 'text_delta', text: 'done' },
        { seq: 3, type: 'turn_end' },
        { seq: 4, type: 'turn_start', userMessage: 'second (in progress)' },
        { seq: 5, type: 'text_delta', text: 'streaming…' }
      )
    );

    expect(messages).toEqual([
      { id: 'user-1', role: 'user', content: 'first' },
      { id: 'assistant-1', role: 'assistant', content: 'done' },
      { id: 'user-4', role: 'user', content: 'second (in progress)' },
    ]);
  });

  it('omits the user message for a turn_start without userMessage (externally driven)', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start' },
        { seq: 2, type: 'text_delta', text: 'reply' },
        { seq: 3, type: 'turn_end' }
      )
    );

    expect(messages).toEqual([{ id: 'assistant-1', role: 'assistant', content: 'reply' }]);
  });

  it('skips an empty turn and tolerates a trimmed log head', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        // Trimmed head: deltas with no retained turn_start are unattributable.
        { seq: 7, type: 'text_delta', text: 'orphan' },
        { seq: 8, type: 'turn_end' },
        // A turn that produced no assistant output emits only its user message.
        { seq: 9, type: 'turn_start', userMessage: 'nothing came back' },
        { seq: 10, type: 'turn_end' }
      )
    );

    expect(messages).toEqual([{ id: 'user-9', role: 'user', content: 'nothing came back' }]);
  });

  it('ignores non-message events (status/todo/interaction) without breaking the fold', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'q' },
        { seq: 2, type: 'status_change', status: { lifecycle: 'streaming' } },
        {
          seq: 3,
          type: 'todo_update',
          action: 'create',
          task: { id: '1', subject: 'Task', status: 'pending' },
        },
        { seq: 4, type: 'interaction_resolved', id: 'tc-9', resolution: 'approved' },
        { seq: 5, type: 'text_delta', text: 'a' },
        { seq: 6, type: 'turn_end' }
      )
    );

    expect(messages).toEqual([
      { id: 'user-1', role: 'user', content: 'q' },
      { id: 'assistant-1', role: 'assistant', content: 'a' },
    ]);
  });
});
