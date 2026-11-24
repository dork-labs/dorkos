import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RawSessionEvent } from '../../index.js';
import { feedProjector } from '../../session-event-normalizer.js';
import { SessionStateProjector } from '../../index.js';
import { mapResultEvent } from '../../../runtimes/claude-code/sdk/event-mappers/result-event-mapper.js';

describe('feedProjector', () => {
  // A triggered turn is wrapped in turn_start/turn_end with mapped events between.
  it('brackets a turn with turn_start/turn_end and ingests mapped events', async () => {
    const projector = new SessionStateProjector('s1');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'hello' } };
      yield { type: 'session_status', data: { sessionId: 's1', model: 'claude-test' } };
      yield { type: 'done', data: { sessionId: 's1' } };
    }

    await feedProjector(projector, turn());

    const types = ingestSpy.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['turn_start', 'text_delta', 'status_change', 'turn_end']);
  });

  // The intent half of settlement. An abort reason says a turn was cut short and
  // never by whom, so the runtime's own stop record has to reach the projections
  // that decide what the ending MEANS — and it has to reach them on the durable
  // `turn_end`, because that same turn is read again from the log after a
  // reconnect.
  describe('the stop record that rides with the terminal reason', () => {
    /**
     * Drive one stream and return every `turn_end` it ingested, in order — a
     * stream that reopens a window (DOR-1100) closes more than one.
     */
    async function turnEndsOf(
      sessionId: string,
      events: StreamEvent[]
    ): Promise<RawSessionEvent[]> {
      const projector = new SessionStateProjector(sessionId);
      const ingestSpy = vi.spyOn(projector, 'ingest');
      async function* turn(): AsyncIterable<StreamEvent> {
        for (const event of events) yield event;
      }
      await feedProjector(projector, turn());
      return ingestSpy.mock.calls.map((c) => c[0]).filter((e) => e.type === 'turn_end');
    }

    /** The single `turn_end` of a stream that closes exactly one window. */
    async function turnEndOf(
      sessionId: string,
      events: StreamEvent[]
    ): Promise<RawSessionEvent | undefined> {
      const ends = await turnEndsOf(sessionId, events);
      expect(ends).toHaveLength(1);
      return ends[0];
    }

    it.each([false])('carries stopWasRequested:%s onto turn_end', async (stop) => {
      const end = await turnEndOf('s-stop', [
        {
          type: 'session_status',
          data: {
            sessionId: 's-stop',
            terminalReason: 'aborted_streaming',
            stopWasRequested: stop,
          },
        },
        { type: 'done', data: { sessionId: 's-stop' } },
      ]);
      expect(end).toMatchObject({ terminalReason: 'aborted_streaming', stopWasRequested: stop });
    });

    it('omits the field entirely when the runtime reported no record', async () => {
      // The degradation pin: codex/opencode and every pre-existing transcript.
      // An absent key is what makes settlement fall back to its old answer, so
      // a `false` written here would silently change every one of those turns.
      const end = await turnEndOf('s-nostop', [
        { type: 'session_status', data: { sessionId: 's-nostop', terminalReason: 'completed' } },
        { type: 'done', data: { sessionId: 's-nostop' } },
      ]);
      expect(end).not.toHaveProperty('stopWasRequested');
    });

    it('resets the record when the runtime reopens the window (DOR-1100)', async () => {
      // A continuation is its own window: the previous window's stop belonged to
      // the turn that already ended, and carrying it forward would let a stop
      // the operator asked for excuse a failure in work they never saw.
      const ends = await turnEndsOf('s-reopen', [
        {
          type: 'session_status',
          data: {
            sessionId: 's-reopen',
            terminalReason: 'aborted_streaming',
            stopWasRequested: false,
          },
        },
        { type: 'done', data: { sessionId: 's-reopen' } },
        { type: 'text_delta', data: { text: 'picking it back up' } },
      ]);
      expect(ends).toHaveLength(2);
      // The window that really did abort keeps its record…
      expect(ends[0]).toMatchObject({
        terminalReason: 'aborted_streaming',
        stopWasRequested: false,
      });
      // …and the continuation, which ended on nothing, inherits neither half.
      expect(ends[1]).not.toHaveProperty('stopWasRequested');
      expect(ends[1]).not.toHaveProperty('terminalReason');
    });
  });

  // A stream that ends without `done` still closes the turn (no stuck streaming).
  it('synthesizes turn_end when the stream ends without a done event', async () => {
    const projector = new SessionStateProjector('s3');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'partial' } };
    }

    await feedProjector(projector, turn());
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  // ERROR LATCH: an adapter that yields a typed error but closes the turn with a
  // reason-less done (the OpenCode/Codex crash shape) must still settle to
  // terminalReason 'error' — otherwise the failure reads as a clean idle turn.
  // The error here carries no code: unclassified means fatal, because most
  // genuinely fatal errors carry none (the other half of the hook_failure denylist).
  it('latches a yielded error into turn_end{terminalReason:"error"} when done carries no reason', async () => {
    const projector = new SessionStateProjector('s-latch');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'error', data: { message: 'backend crashed' } };
      yield { type: 'done', data: { sessionId: 's-latch' } };
    }

    await feedProjector(projector, turn());

    const turnEnd = ingestSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'turn_end');
    expect(turnEnd).toMatchObject({ type: 'turn_end', terminalReason: 'error' });
    expect(projector.getStatus().lifecycle).toBe('error');
  });

  // DOR-1676. A SURVIVABLE error must not latch. A `hook_failure` is the
  // OPERATOR'S own script exiting non-zero — the turn then ends normally
  // carrying the whole answer — so closing it as `terminalReason: 'error'`
  // reported a working turn as a failed one, red-bordered the session and armed
  // the error escalation. The latch means a FATAL frame, and nothing else.
  it('does not latch a non-fatal hook failure into turn_end{terminalReason:"error"}', async () => {
    const projector = new SessionStateProjector('s-latch-hook');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield {
        type: 'error',
        data: { message: 'Hook "notify" failed (Stop)', code: 'hook_failure' },
      };
      yield { type: 'done', data: { sessionId: 's-latch-hook' } };
    }

    await feedProjector(projector, turn());

    const turnEnd = ingestSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'turn_end');
    expect(turnEnd).not.toHaveProperty('terminalReason');
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  // The fidelity events (task #19) must survive the normalizer→projector path
  // into the replayable stream, so a mid-turn reconnect replays thinking/
  // progress/hook/memory detail instead of a lean turn.
  it('projects fidelity events into the seq stream and replay', async () => {
    const projector = new SessionStateProjector('s5');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'thinking_delta', data: { text: 'hmm' } };
      yield {
        type: 'tool_call_start',
        data: { toolCallId: 't1', toolName: 'Bash', status: 'running' },
      };
      yield { type: 'tool_progress', data: { toolCallId: 't1', content: 'out' } };
      yield {
        type: 'hook_started',
        data: { hookId: 'h1', hookName: 'lint', hookEvent: 'PostToolUse', toolCallId: 't1' },
      };
      yield { type: 'memory_recall', data: { mode: 'select', memories: [] } };
      yield { type: 'done', data: { sessionId: 's5' } };
    }

    await feedProjector(projector, turn());
    expect(projector.replayFrom(0).map((e) => e.type)).toEqual([
      'turn_start',
      'thinking_delta',
      'tool_call',
      'tool_progress',
      'hook_update',
      'memory_recall',
      'turn_end',
    ]);
  });

  // DOR-97/DOR-104: the original bug. `control_ui` pushes a `ui_command`
  // StreamEvent onto the eventQueue (drained into the turn's stream); pre-fix the
  // normalizer default-dropped it, so the agent canvas was a silent no-op for
  // live clients. It must now survive the full normalizer→projector path onto the
  // replayable stream — carrying the command whole — while leaving the held
  // status untouched (it is a transient, side-effecting member, not a state delta).
  it('projects a ui_command onto the stream, carrying the command, without touching status', async () => {
    const projector = new SessionStateProjector('s7');
    const command = { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } };

    async function* turn(): AsyncIterable<StreamEvent> {
      // Shape `control_ui` emits: { type: 'ui_command', data: { command } }.
      yield { type: 'ui_command', data: { command } } as unknown as StreamEvent;
      yield { type: 'done', data: { sessionId: 's7' } };
    }

    await feedProjector(projector, turn());

    const events = projector.replayFrom(0);
    expect(events.map((e) => e.type)).toEqual(['turn_start', 'ui_command', 'turn_end']);
    const uiCommand = events.find((e) => e.type === 'ui_command');
    expect(uiCommand).toMatchObject({ type: 'ui_command', command });
    // Transient: no status projection, and the turn settles idle.
    expect(projector.getStatus().lifecycle).toBe('idle');
  });
});

// The turn WINDOW contract (spec `persistent-session-runtime` P0/task 0.1 + DOR-1100).
//
// A `done` closes the window that is open; a `done` with no open window does
// nothing; a content event arriving after a close opens a new window so the
// agent's continuation work is visible, streamed and persisted.
describe('feedProjector — turn windows', () => {
  // P0/F5: a stream carrying two `done`s is one logical turn with one close.
  // The second `done` is the SDK's second `result`, which arrives once the CLI
  // keeps a query alive past the first — the persistent pump's day-one shape.
  it('emits exactly one turn_end for two consecutive done events', async () => {
    const projector = new SessionStateProjector('win-1');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'working' } };
      yield { type: 'done', data: { sessionId: 'win-1' } };
      yield { type: 'done', data: { sessionId: 'win-1' } };
    }

    await feedProjector(projector, turn());

    const types = ingestSpy.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['turn_start', 'text_delta', 'turn_end']);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  // DOR-1100: the agent wakes on a background-task notification and keeps
  // working. That work opens its own window, so the cockpit stops reading idle
  // while text is still arriving.
  it('reopens a window when content arrives after the turn closed', async () => {
    const projector = new SessionStateProjector('win-3');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'first half' } };
      yield { type: 'done', data: { sessionId: 'win-3' } };
      // The CLI drains the queued background-task notification and the agent
      // carries on: more prose, another tool, then its own result.
      yield { type: 'text_delta', data: { text: 'and now the rest' } };
      yield {
        type: 'tool_call_start',
        data: { toolCallId: 't9', toolName: 'Read', status: 'running' },
      };
      yield { type: 'done', data: { sessionId: 'win-3' } };
    }

    await feedProjector(projector, turn());

    expect(ingestSpy.mock.calls.map((c) => c[0].type)).toEqual([
      'turn_start',
      'text_delta',
      'turn_end',
      'turn_start',
      'text_delta',
      'tool_call',
      'turn_end',
    ]);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  // The bookkeeping that legitimately trails a `result` must NOT reopen. Each of
  // these is a real post-`done` emission: the phantom-cancellation notice
  // (DOR-1087) is yielded after its message's mapped events on purpose, a
  // background child's lifecycle keeps reporting after the agent stops talking,
  // and a `rate_limit_event` can land at any time.
  it('does not reopen on trailing bookkeeping events', async () => {
    const projector = new SessionStateProjector('win-8');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'all done' } };
      yield { type: 'done', data: { sessionId: 'win-8' } };
      yield { type: 'system_status', data: { message: 'A background task finished.' } };
      yield { type: 'background_task_done', data: { taskId: 'bt1', status: 'completed' } };
      yield {
        type: 'session_status',
        data: { sessionId: 'win-8', usage: { kind: 'pay-as-you-go', costUsd: 0.02 } },
      };
      yield { type: 'task_update', data: { action: 'snapshot', tasks: [] } };
      // The content-SHAPED trailers, all four reproduced through the real
      // mappers: a tool that was in flight when the result landed, reporting in
      // afterwards. The turn is settling, not restarting.
      yield {
        type: 'tool_result',
        data: { toolCallId: 't1', toolName: 'Read', result: 'late', status: 'complete' },
      };
      yield {
        type: 'tool_call_end',
        data: { toolCallId: 't2', toolName: 'Bash', status: 'complete' },
      };
      yield { type: 'tool_progress', data: { toolCallId: 't2', content: 'still going' } };
    }

    await feedProjector(projector, turn());

    const types = ingestSpy.mock.calls.map((c) => c[0].type);
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(1);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });
});

// The crux of DOR-1100: reopening must not grow a second, empty window onto
// every ordinary turn. This pins the NORMAL turn's real shape by generating its
// tail from `mapResultEvent` itself rather than from a hand-written guess at the
// order — the guess is the thing that would rot.
describe('feedProjector — a normal turn grows no ghost window', () => {
  /** A minimal successful SDK `result` message, as the CLI sends it. */
  const RESULT_MESSAGE = {
    type: 'result',
    subtype: 'success',
    model: 'claude-test',
    total_cost_usd: 0.0123,
    modelUsage: { 'claude-test': { inputTokens: 100, outputTokens: 20, contextWindow: 200_000 } },
  } as unknown as Parameters<typeof mapResultEvent>[0];

  it('emits one turn_start and one turn_end for a real result tail', async () => {
    const projector = new SessionStateProjector('normal-1');
    const ingestSpy = vi.spyOn(projector, 'ingest');
    const session = {
      lastRequestUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
      },
    } as unknown as Parameters<typeof mapResultEvent>[1];

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'thinking_delta', data: { text: 'considering' } };
      yield {
        type: 'tool_call_start',
        data: { toolCallId: 't1', toolName: 'Read', status: 'running' },
      };
      yield {
        type: 'tool_result',
        data: { toolCallId: 't1', toolName: 'Read', result: 'ok', status: 'complete' },
      };
      yield { type: 'text_delta', data: { text: 'here is the answer' } };
      // Everything the result mapper emits, in its real order, `done` included.
      yield* mapResultEvent(RESULT_MESSAGE, session, 'normal-1');
    }

    await feedProjector(projector, turn(), { userMessage: 'do the thing' });

    const types = ingestSpy.mock.calls.map((c) => c[0].type);
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(1);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(1);
    // …and the close is the LAST thing on the stream: nothing the mapper emits
    // after the content trails `done`.
    expect(types[types.length - 1]).toBe('turn_end');
    expect(projector.getStatus().lifecycle).toBe('idle');
  });
});
