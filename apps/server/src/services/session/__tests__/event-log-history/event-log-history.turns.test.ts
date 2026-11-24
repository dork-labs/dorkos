// Purpose: Decision 1 / runtime-agnosticism — a log-backed runtime's completed
// history must be reconstructible from the DorkOS-owned event stream alone
// (no JSONL, no native transcript). These tests pin the folding rules.
import { describe, it, expect } from 'vitest';
import { reconstructHistoryFromEvents } from '../../event-log-history.js';
import { events } from './event-log-history.fixtures.js';

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

  it.each(['codex_git_metadata_unavailable', 'codex_git_metadata_unavailable_extra', undefined])(
    'preserves only the Git-folder refusal code in completed error parts (%s)',
    (code) => {
      const messages = reconstructHistoryFromEvents(
        events(
          { seq: 1, type: 'turn_start', userMessage: 'hello' },
          {
            seq: 2,
            type: 'error',
            message: 'Original message',
            details: 'Original details',
            ...(code !== undefined ? { code } : {}),
          },
          { seq: 3, type: 'turn_end', terminalReason: 'error' }
        )
      );
      expect(messages[1]?.parts).toEqual([
        {
          type: 'error',
          message: 'Original message',
          ...(code === 'codex_git_metadata_unavailable' ? { code } : {}),
          details: code !== undefined ? `[${code}] Original details` : 'Original details',
        },
      ]);
    }
  );

  it('upgrades a legacy persisted nested model error without changing its raw details', () => {
    const raw =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}}';
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'continue' },
        {
          seq: 2,
          type: 'error',
          code: 'turn_failed',
          message: raw,
          details: 'Original diagnostic context',
        },
        { seq: 3, type: 'turn_end', terminalReason: 'error' }
      )
    );

    expect(messages[1]?.parts).toEqual([
      {
        type: 'error',
        message:
          'gpt-5.4 isn\u2019t available with a ChatGPT account. Choose another model from the model menu.',
        category: 'model_unavailable',
        details: `[turn_failed] Original diagnostic context\n${raw}`,
      },
    ]);
  });
});

describe('a model DorkOS credits ran in place of the session’s (DOR-2636)', () => {
  it('comes back as a lasting notice in the turn it opened', () => {
    const history = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'go' },
        {
          seq: 2,
          type: 'model_substituted',
          from: 'gpt-old',
          fromName: 'GPT Old',
          to: 'gpt-pick',
          toName: 'GPT Pick',
          reason: 'credits-not-covered',
        },
        { seq: 3, type: 'text_delta', text: 'done' },
        { seq: 4, type: 'turn_end' }
      )
    );
    expect(history.map((m) => m.id)).toEqual(['user-1', 'model-substituted-2', 'assistant-1']);
    expect(history[1]!.parts).toEqual([
      {
        type: 'model_substituted',
        from: 'gpt-old',
        fromName: 'GPT Old',
        to: 'gpt-pick',
        toName: 'GPT Pick',
        reason: 'credits-not-covered',
      },
    ]);
  });
});

// A compaction is the one turn that produces no text and no tool call, so
// before DOR-1215 it folded to NOTHING: a log-backed runtime lost every trace
// of it the moment the turn closed, and the row the reader is owed — the line
// saying the conversation above was summarized away — never came back on a
// reload. The Claude adapter has always produced that row from JSONL
// (`messageType: 'compaction'` + `compactMetadata`, transcript-parser.ts), so
// these pin the SAME shape here and both history sources render through one row.
describe('reconstructHistoryFromEvents — compaction boundaries', () => {
  it('folds a compact_boundary into a compaction message carrying its metadata', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start' },
        {
          seq: 2,
          type: 'compact_boundary',
          trigger: 'manual',
          preTokens: 51_226,
          postTokens: 4_151,
          durationMs: 63_275,
        },
        { seq: 3, type: 'turn_end' }
      )
    );

    expect(messages).toEqual([
      {
        id: 'compaction-2',
        role: 'user',
        content: '',
        messageType: 'compaction',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 51_226,
          postTokens: 4_151,
          durationMs: 63_275,
        },
      },
    ]);
  });

  it('lands the boundary between the turns it separates, in stream order', () => {
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'before' },
        { seq: 2, type: 'text_delta', text: 'said before' },
        { seq: 3, type: 'turn_end' },
        { seq: 4, type: 'turn_start' },
        { seq: 5, type: 'compact_boundary', trigger: 'manual' },
        { seq: 6, type: 'turn_end' },
        { seq: 7, type: 'turn_start', userMessage: 'after' },
        { seq: 8, type: 'text_delta', text: 'said after' },
        { seq: 9, type: 'turn_end' }
      )
    );

    // The history a reader scrolls: the turn before the boundary still renders,
    // the boundary sits between them, and the turn after is unaffected.
    expect(messages.map((m) => m.id)).toEqual([
      'user-1',
      'assistant-1',
      'compaction-5',
      'user-7',
      'assistant-7',
    ]);
  });
});

describe('reconstructHistoryFromEvents — images (DOR-1663)', () => {
  /** One `image_attachment` as it rides the durable stream: a reference. */
  const IMAGE = {
    type: 'image_attachment' as const,
    attachmentId: 'abc123',
    url: '/api/sessions/s1/attachments/abc123.png',
    mediaType: 'image/png',
    size: 2048,
    alt: 'banana.png',
  };

  it('rebuilds a picture the turn produced', () => {
    // OpenCode declares `logBackedHistory: true` so this loader is the fallback
    // when its sidecar read fails. An `image_attachment` not handled here is a
    // picture that exists on disk and is reachable from nothing — the same
    // silent drop the whole feature exists to end, on a path DorkOS fully owns.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'draw me a banana' },
        { seq: 2, type: 'text_delta', text: 'Here you go.' },
        { seq: 3, ...IMAGE },
        { seq: 4, type: 'turn_end' }
      )
    );

    expect(messages).toHaveLength(2);
    const assistant = messages[1]!;
    expect(assistant.content).toBe('Here you go.');
    expect(assistant.parts).toEqual([
      { type: 'text', text: 'Here you go.' },
      {
        type: 'image',
        attachmentId: 'abc123',
        url: '/api/sessions/s1/attachments/abc123.png',
        mediaType: 'image/png',
        size: 2048,
        alt: 'banana.png',
      },
    ]);
  });

  it('rebuilds the turn WHOLE when it carries an image — text and tools included', () => {
    // The client renders from `parts` exclusively when present, so emitting
    // parts for an image-bearing turn and forgetting its text would DELETE the
    // text. This is the case that catches that.
    const messages = reconstructHistoryFromEvents(
      events(
        { seq: 1, type: 'turn_start', userMessage: 'go' },
        { seq: 2, type: 'text_delta', text: 'running the tool' },
        { seq: 3, type: 'tool_call', toolCallId: 'tc1', toolName: 'screenshot', status: 'running' },
        {
          seq: 4,
          type: 'tool_result',
          toolCallId: 'tc1',
          toolName: 'screenshot',
          result: 'captured',
          status: 'complete',
        },
        { seq: 5, ...IMAGE },
        { seq: 6, type: 'turn_end' }
      )
    );

    expect(messages[1]!.parts?.map((p) => p.type)).toEqual(['text', 'tool_call', 'image']);
  });

  it('carries only a reference — the durable stream never holds the bytes', () => {
    const messages = reconstructHistoryFromEvents(
      events({ seq: 1, type: 'turn_start' }, { seq: 2, ...IMAGE }, { seq: 3, type: 'turn_end' })
    );

    expect(JSON.stringify(messages)).not.toContain('base64');
    expect(JSON.stringify(messages)).not.toContain('data:');
  });
});
