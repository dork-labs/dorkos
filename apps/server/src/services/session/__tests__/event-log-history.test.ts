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

  it('reconstructs a steer (turn_input) as an inline user message (AC6)', () => {
    // A steer joined the turn mid-flight. For a log-backed runtime this stream
    // IS the transcript, so the steered words survive only if rebuilt here — as
    // a user message at the point they arrived, between the trigger and the
    // assistant reply.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'do the thing' },
        { seq: 2, type: 'text_delta', text: 'starting' },
        {
          seq: 3,
          type: 'turn_input',
          content: 'also run the tests',
          disposition: 'steer',
          messageId: 'm-1',
        },
        { seq: 4, type: 'text_delta', text: ' and testing' },
        { seq: 5, type: 'turn_end' }
      )
    );

    expect(messages).toEqual([
      { id: 'user-1', role: 'user', content: 'do the thing' },
      { id: 'steer-m-1', role: 'user', content: 'also run the tests' },
      { id: 'assistant-1', role: 'assistant', content: 'starting and testing' },
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

  it('reconstructs a failed turn WITH parts: text, merged tools, then error parts', () => {
    // Failed-turn parity with Claude's JSONL history: the errors must
    // reconstruct inline. `parts` is emitted ONLY for failed turns; the client's
    // mapHistoryMessage uses it exclusively when present. ErrorPart carries no
    // `code` field, so the code folds into the details string.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'do the thing' },
        { seq: 2, type: 'text_delta', text: 'Working…' },
        {
          seq: 3,
          type: 'tool_call',
          toolCallId: 'tc-1',
          toolName: 'Bash',
          status: 'running',
          input: '{"command":"boom"}',
        },
        {
          seq: 4,
          type: 'error',
          message: 'SDK exploded',
          code: 'turn_exception',
          category: 'execution_error',
          details: 'stack trace',
        },
        { seq: 5, type: 'turn_end', terminalReason: 'error' }
      )
    );

    expect(messages).toEqual([
      { id: 'user-1', role: 'user', content: 'do the thing' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Working…',
        toolCalls: [
          {
            toolCallId: 'tc-1',
            toolName: 'Bash',
            status: 'complete',
            input: '{"command":"boom"}',
          },
        ],
        parts: [
          { type: 'text', text: 'Working…' },
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'Bash',
            status: 'complete',
            input: '{"command":"boom"}',
          },
          {
            type: 'error',
            message: 'SDK exploded',
            category: 'execution_error',
            details: '[turn_exception] stack trace',
          },
        ],
      },
    ]);
  });

  it('emits an assistant message for an errors-only turn (the failure IS the output)', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'hello?' },
        { seq: 2, type: 'error', message: 'backend unreachable', code: 'turn_exception' },
        { seq: 3, type: 'turn_end', terminalReason: 'error' }
      )
    );

    expect(messages).toEqual([
      { id: 'user-1', role: 'user', content: 'hello?' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        parts: [{ type: 'error', message: 'backend unreachable', details: '[turn_exception]' }],
      },
    ]);
  });

  it('keeps clean turns parts-less (byte-identical to the pre-error fold)', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'Hello' },
        { seq: 2, type: 'text_delta', text: 'Hi' },
        { seq: 3, type: 'turn_end', terminalReason: 'completed' }
      )
    );

    expect(messages[1]).toEqual({ id: 'assistant-1', role: 'assistant', content: 'Hi' });
    expect(messages[1]).not.toHaveProperty('parts');
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

// Purpose: receipt permanence for LOG-BACKED runtimes. The permission prompt is
// a DorkOS event, so the answer has to survive in the same place the rest of
// the turn does — reopening the session tomorrow must rebuild the same receipt
// line the person saw when they answered.
describe('reconstructHistoryFromEvents — answered approvals', () => {
  /** A turn whose only tool call was gated on a permission prompt. */
  function gatedTurn(...tail: SessionEvent[]): SessionEvent[] {
    return events(
      { seq: 1, type: 'turn_start', userMessage: 'run the tests' },
      {
        seq: 2,
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        status: 'pending',
        input: '{"command":"npm test"}',
      },
      ...tail
    );
  }

  it('records how an approval was answered onto the tool call it gated', () => {
    const messages = reconstructHistoryFromEvents(
      gatedTurn(
        {
          seq: 3,
          type: 'interaction_resolved',
          id: 'tc-1',
          kind: 'approval',
          resolution: 'approved',
          at: 1_700_000_005_000,
          startedAt: 1_700_000_000_000,
        },
        {
          seq: 4,
          type: 'tool_result',
          toolCallId: 'tc-1',
          toolName: 'Bash',
          status: 'complete',
          result: 'ok',
        },
        { seq: 5, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls?.[0]).toEqual({
      toolCallId: 'tc-1',
      toolName: 'Bash',
      status: 'complete',
      input: '{"command":"npm test"}',
      result: 'ok',
      approvalOutcome: 'allowed',
      approvalResolvedAt: 1_700_000_005_000,
      approvalStartedAt: 1_700_000_000_000,
    });
  });

  it('keeps a denial, which is the record most worth keeping', () => {
    const messages = reconstructHistoryFromEvents(
      gatedTurn(
        {
          seq: 3,
          type: 'interaction_resolved',
          id: 'tc-1',
          kind: 'approval',
          resolution: 'denied',
          at: 1_700_000_005_000,
        },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls?.[0].approvalOutcome).toBe('denied');
  });

  it('keeps an expiry as an expiry, not as something the person did', () => {
    // Nobody answered; the timer denied it on their behalf. Recording that as
    // `denied` would put words in the person's mouth.
    const messages = reconstructHistoryFromEvents(
      gatedTurn(
        {
          seq: 3,
          type: 'interaction_resolved',
          id: 'tc-1',
          kind: 'approval',
          resolution: 'expired',
          at: 1_700_000_600_000,
          startedAt: 1_700_000_000_000,
        },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls?.[0].approvalOutcome).toBe('expired');
    expect(messages[1].toolCalls?.[0].approvalStartedAt).toBe(1_700_000_000_000);
  });

  it('records nothing for a withdrawn ask', () => {
    // `cancelled` means the request was pulled before anyone could answer it.
    const messages = reconstructHistoryFromEvents(
      gatedTurn(
        {
          seq: 3,
          type: 'interaction_resolved',
          id: 'tc-1',
          kind: 'approval',
          resolution: 'cancelled',
          at: 1_700_000_005_000,
        },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls?.[0]).not.toHaveProperty('approvalOutcome');
  });

  it('records nothing for a resolved QUESTION riding the same tool call id', () => {
    // AskUserQuestion is an ordinary tool_use block, so a timed-out question
    // resolves `expired` on a real tool call. Reading the kind out of the
    // outcome would print a permission receipt over a question.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'ask me' },
        {
          seq: 2,
          type: 'tool_call',
          toolCallId: 'tc-q',
          toolName: 'AskUserQuestion',
          status: 'pending',
        },
        {
          seq: 3,
          type: 'interaction_resolved',
          id: 'tc-q',
          kind: 'question',
          resolution: 'expired',
          at: 1_700_000_600_000,
        },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls?.[0]).not.toHaveProperty('approvalOutcome');
  });

  it('lands the answer even when the resolution is folded before the tool call', () => {
    // Order independence: the receipt is applied once the turn closes, so a
    // runtime that reports the answer before the call still gets it right.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'run it' },
        {
          seq: 2,
          type: 'interaction_resolved',
          id: 'tc-1',
          kind: 'approval',
          resolution: 'approved',
          at: 1_700_000_005_000,
        },
        {
          seq: 3,
          type: 'tool_result',
          toolCallId: 'tc-1',
          toolName: 'Bash',
          status: 'complete',
          result: 'ok',
        },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls?.[0].approvalOutcome).toBe('allowed');
  });

  it('carries the answer into a FAILED turn’s parts too', () => {
    // A failed turn reconstructs through `parts`, which is what the client
    // renders from when present — a receipt only on `toolCalls` would vanish.
    const messages = reconstructHistoryFromEvents(
      gatedTurn(
        {
          seq: 3,
          type: 'interaction_resolved',
          id: 'tc-1',
          kind: 'approval',
          resolution: 'denied',
          at: 1_700_000_005_000,
          startedAt: 1_700_000_000_000,
        },
        { seq: 4, type: 'error', message: 'turn failed' },
        { seq: 5, type: 'turn_end', terminalReason: 'error' }
      )
    );

    expect(messages[1].parts).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        toolCallId: 'tc-1',
        interactiveType: 'approval',
        approvalOutcome: 'denied',
        approvalResolvedAt: 1_700_000_005_000,
        approvalStartedAt: 1_700_000_000_000,
      })
    );
  });
});
