import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { reconstructHistoryFromEvents } from '../../event-log-history.js';
import { events } from './event-log-history.fixtures.js';

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

  it('records a resolved QUESTION as a question, never as an approval', () => {
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
    // …but it DOES earn its own record. For a log-backed runtime this stream is
    // the only transcript, so an expiry not folded here comes back from a
    // reload as a question with no answers — which is what the renderer read as
    // "Question answered" (DOR-1293).
    expect(messages[1].toolCalls?.[0].questionOutcome).toBe('expired');
  });

  it('never mints a SECOND row when the ask and the tool call use different ids', () => {
    // Fails CLOSED, like `applyReceipts`. A runtime whose interaction ids live
    // in their own space (the shape OpenCode's `Permission.id` already takes)
    // would otherwise produce two `AskUserQuestion` rows for one ask — one with
    // the questions and no result, one with the result and no questions.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'ask me' },
        {
          seq: 2,
          type: 'tool_call',
          toolCallId: 'tool-abc',
          toolName: 'AskUserQuestion',
          status: 'pending',
        },
        {
          seq: 3,
          type: 'question_prompt',
          id: 'ask-xyz',
          questions: [{ question: 'Which?', header: 'Q', multiSelect: false, options: [] }],
          startedAt: 1_700_000_000_000,
          remainingMs: 600_000,
        },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls).toHaveLength(1);
    expect(messages[1].toolCalls?.[0].toolCallId).toBe('tool-abc');
    // The options are lost with the unmatched ask…
    expect(messages[1].toolCalls?.[0].questions).toBeUndefined();
    // …but the row that RAISED it still says it went unanswered, marked by
    // tool name. A bare `AskUserQuestion` card would hide that entirely.
    expect(messages[1].toolCalls?.[0].questionOutcome).toBe('unresolved');
  });

  it('lands a resolution that arrives AFTER its turn closed', () => {
    // The projector holds interactions across `turn_end` by design, so "late"
    // is a state it models. Dropped, this read as "Question answered" before
    // DOR-1293 (right by accident) and "No answer was recorded" after it —
    // a question somebody DID answer claiming nobody had.
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
          type: 'question_prompt',
          id: 'tc-q',
          questions: [{ question: 'Which?', header: 'Q', multiSelect: false, options: [] }],
          startedAt: 1_700_000_000_000,
          remainingMs: 600_000,
        },
        { seq: 4, type: 'turn_end' },
        {
          seq: 5,
          type: 'interaction_resolved',
          id: 'tc-q',
          kind: 'question',
          resolution: 'answered',
          at: 1_700_000_005_000,
        }
      )
    );

    expect(messages[1].toolCalls?.[0].questionOutcome).toBe('answered');
  });

  it('says a question never resolved rather than letting it read as answered', () => {
    // The turn ended with the ask still open — interrupted, or trimmed out of
    // the log between the ask and the answer. Unmarked, it reaches the renderer
    // as "settled, no answers", which is what an ANSWERED question looks like
    // on a client that did not submit it (DOR-1293).
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
          type: 'question_prompt',
          id: 'tc-q',
          questions: [{ question: 'Which?', header: 'Q', multiSelect: false, options: [] }],
          startedAt: 1_700_000_000_000,
          remainingMs: 600_000,
        },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages[1].toolCalls?.[0].questionOutcome).toBe('unresolved');
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

  it('settles a tool a Stop withdrew the card for, rather than leaving it running (DOR-3202)', () => {
    const messages = reconstructHistoryFromEvents(
      gatedTurn(
        { seq: 3, type: 'tool_result', toolCallId: 'tc-1', toolName: 'Bash', status: 'running' },
        { seq: 4, type: 'interaction_resolved', id: 'tc-1', resolution: 'cancelled', at: 1 },
        { seq: 5, type: 'turn_end', terminalReason: 'aborted_streaming' }
      )
    );

    expect(messages[1].toolCalls?.[0].status).toBe('error');
  });
});
