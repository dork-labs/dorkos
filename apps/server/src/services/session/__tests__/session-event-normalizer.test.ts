import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RawSessionEvent } from '../index.js';
import {
  toRawSessionEvent,
  feedProjector,
  TURN_REOPENING_STREAM_EVENT_TYPES,
} from '../session-event-normalizer.js';
import { mapResultEvent } from '../../runtimes/claude-code/sdk/event-mappers/result-event-mapper.js';
import { SessionStateProjector, CAPABILITY_HOLD_PAUSE_GRACE_MS } from '../index.js';

describe('toRawSessionEvent', () => {
  // Each StreamEvent kind maps to the right session-stream union member (or null).
  const cases: Array<{ name: string; input: StreamEvent; expected: RawSessionEvent | null }> = [
    {
      name: 'text_delta → text_delta',
      input: { type: 'text_delta', data: { text: 'hi' } },
      expected: { type: 'text_delta', text: 'hi' },
    },
    {
      name: 'tool_call_start → tool_call',
      input: {
        type: 'tool_call_start',
        data: { toolCallId: 't1', toolName: 'Bash', status: 'running' },
      },
      expected: { type: 'tool_call', toolCallId: 't1', toolName: 'Bash', status: 'running' },
    },
    {
      name: 'tool_call_delta → tool_call (carries input)',
      input: {
        type: 'tool_call_delta',
        data: { toolCallId: 't1', toolName: 'Bash', input: '{"x":1}', status: 'running' },
      },
      expected: {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'Bash',
        input: '{"x":1}',
        status: 'running',
      },
    },
    {
      name: 'tool_call_end → tool_result',
      input: {
        type: 'tool_call_end',
        data: { toolCallId: 't1', toolName: 'Bash', status: 'complete' },
      },
      expected: { type: 'tool_result', toolCallId: 't1', toolName: 'Bash', status: 'complete' },
    },
    {
      name: 'tool_result → tool_result (carries result)',
      input: {
        type: 'tool_result',
        data: { toolCallId: 't1', toolName: 'Bash', result: 'ok', status: 'complete' },
      },
      expected: {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'Bash',
        result: 'ok',
        status: 'complete',
      },
    },
    {
      name: 'tool_result → tool_result (carries the MCP App ui reference)',
      input: {
        type: 'tool_result',
        data: {
          toolCallId: 't1',
          toolName: 'mcp__fixture-app__render',
          result: 'ready',
          status: 'complete',
          ui: { resourceUri: 'ui://dash/main' },
        },
      },
      expected: {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'mcp__fixture-app__render',
        result: 'ready',
        status: 'complete',
        ui: { resourceUri: 'ui://dash/main' },
      },
    },
    {
      name: 'approval_required → approval_required (id from toolCallId, timer preserved)',
      input: {
        type: 'approval_required',
        data: {
          toolCallId: 'a1',
          toolName: 'Bash',
          input: '{}',
          startedAt: 1000,
          timeoutMs: 600000,
          hasSuggestions: true,
          title: 'Run command?',
        },
      },
      expected: {
        type: 'approval_required',
        id: 'a1',
        startedAt: 1000,
        remainingMs: 600000,
        // The full budget rides along with what is left of it — the client
        // gates its countdown on this (DOR-810).
        timeoutMs: 600000,
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: true,
        title: 'Run command?',
      },
    },
    {
      name: 'question_prompt → question_prompt (id from toolCallId, budget preserved)',
      input: {
        type: 'question_prompt',
        data: {
          toolCallId: 'q1',
          questions: [{ header: 'H', question: 'Q?', options: [], multiSelect: false }],
          startedAt: 2000,
          timeoutMs: 600000,
        },
      },
      expected: {
        type: 'question_prompt',
        id: 'q1',
        startedAt: 2000,
        remainingMs: 600000,
        // The budget rides the question member exactly as it rides the
        // approval's. Dropping it left the card counting from whatever was left
        // when it arrived, so the countdown restarted on every remount
        // (DOR-1442).
        timeoutMs: 600000,
        questions: [{ header: 'H', question: 'Q?', options: [], multiSelect: false }],
      },
    },
    {
      name: 'elicitation_prompt → elicitation_prompt (id from interactionId)',
      input: {
        type: 'elicitation_prompt',
        data: {
          interactionId: 'e1',
          serverName: 'srv',
          message: 'fill this',
          startedAt: 3000,
          timeoutMs: 600000,
        },
      },
      expected: {
        type: 'elicitation_prompt',
        id: 'e1',
        startedAt: 3000,
        remainingMs: 600000,
        // Same budget, same reason as the question above (DOR-1442).
        timeoutMs: 600000,
        serverName: 'srv',
        message: 'fill this',
      },
    },
    {
      name: 'question_prompt → question_prompt (no budget invented when the runtime declared none)',
      input: {
        type: 'question_prompt',
        data: {
          toolCallId: 'q2',
          questions: [],
          startedAt: 2000,
        },
      },
      // No `timeoutMs` key at all: absent means "this runtime did not say", and
      // a number made up here would draw a deadline nothing enforces.
      expected: {
        type: 'question_prompt',
        id: 'q2',
        startedAt: 2000,
        remainingMs: 0,
        questions: [],
      },
    },
    {
      name: 'session_status → status_change (model + cost + usage)',
      input: {
        type: 'session_status',
        data: {
          sessionId: 's1',
          model: 'claude-test',
          costUsd: 0.5,
          contextTokens: 100,
          contextMaxTokens: 200000,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheCreationTokens: 5,
          usage: { kind: 'subscription', utilization: 0.6, costUsd: 0.5, state: 'ok' },
        },
      },
      expected: {
        type: 'status_change',
        status: {
          model: 'claude-test',
          cost: 0.5,
          usage: { kind: 'subscription', utilization: 0.6, costUsd: 0.5, state: 'ok' },
          contextUsage: {
            totalTokens: 100,
            maxTokens: 200000,
            outputTokens: 20,
            cacheReadTokens: 80,
            cacheCreationTokens: 5,
          },
          cacheStats: { cacheReadTokens: 80, cacheCreationTokens: 5 },
        },
      },
    },
    {
      name: 'usage-only session_status → status_change carrying only usage',
      input: {
        type: 'session_status',
        data: {
          sessionId: 's1',
          usage: { kind: 'subscription', utilization: 0.82, windowLabel: '5-hour window' },
        },
      },
      expected: {
        type: 'status_change',
        status: {
          usage: { kind: 'subscription', utilization: 0.82, windowLabel: '5-hour window' },
        },
      },
    },
    {
      name: 'streaming session_status → status_change carrying ONLY outputTokens (no fabricated 0s)',
      input: { type: 'session_status', data: { sessionId: 's1', outputTokens: 20 } },
      // Only outputTokens is present, so contextUsage carries only that field —
      // the absent context/cache fields are NOT fabricated as 0 (would clobber
      // a later merge). cacheStats is omitted entirely (all-or-nothing).
      expected: {
        type: 'status_change',
        status: { contextUsage: { outputTokens: 20 } },
      },
    },
    {
      name: 'final session_status → status_change OMITS outputTokens (would otherwise zero it)',
      input: {
        type: 'session_status',
        data: {
          sessionId: 's1',
          contextTokens: 100,
          contextMaxTokens: 200000,
          cacheReadTokens: 80,
          cacheCreationTokens: 5,
        },
      },
      // No outputTokens on the source → it is absent from contextUsage so the
      // projector's field-wise merge preserves the running count.
      expected: {
        type: 'status_change',
        status: {
          contextUsage: {
            totalTokens: 100,
            maxTokens: 200000,
            cacheReadTokens: 80,
            cacheCreationTokens: 5,
          },
          cacheStats: { cacheReadTokens: 80, cacheCreationTokens: 5 },
        },
      },
    },
    {
      name: 'session_status with no projectable fields → null',
      input: { type: 'session_status', data: { sessionId: 's1', terminalReason: 'completed' } },
      expected: null,
    },
    {
      name: 'task_update → todo_update',
      input: {
        type: 'task_update',
        data: {
          action: 'snapshot',
          task: { id: '1', subject: 'do it', status: 'pending' },
          tasks: [{ id: '1', subject: 'do it', status: 'pending' }],
        },
      },
      expected: {
        type: 'todo_update',
        action: 'snapshot',
        task: { id: '1', subject: 'do it', status: 'pending' },
        tasks: [{ id: '1', subject: 'do it', status: 'pending' }],
      },
    },
    {
      name: 'background_task_started → subagent_update running',
      input: {
        type: 'background_task_started',
        data: { taskId: 'bt1', taskType: 'agent', startedAt: 1, description: 'sub' },
      },
      expected: { type: 'subagent_update', taskId: 'bt1', status: 'running', description: 'sub' },
    },
    {
      name: 'background_task_progress → subagent_update running (toolUses)',
      input: {
        type: 'background_task_progress',
        data: { taskId: 'bt1', toolUses: 3, durationMs: 100, lastToolName: 'Read' },
      },
      expected: {
        type: 'subagent_update',
        taskId: 'bt1',
        status: 'running',
        toolUses: 3,
        lastToolName: 'Read',
      },
    },
    {
      name: 'background_task_done completed → subagent_update complete',
      input: {
        type: 'background_task_done',
        data: { taskId: 'bt1', status: 'completed', summary: 'done', toolUses: 5 },
      },
      expected: {
        type: 'subagent_update',
        taskId: 'bt1',
        status: 'complete',
        summary: 'done',
        toolUses: 5,
      },
    },
    {
      name: 'background_task_done failed → subagent_update error',
      input: { type: 'background_task_done', data: { taskId: 'bt1', status: 'failed' } },
      expected: { type: 'subagent_update', taskId: 'bt1', status: 'error' },
    },
    // The four fidelity members (spec task #19): a live turn renders thinking,
    // tool progress, hooks, and memory recall with the same fidelity the
    // post-turn history reload provides.
    {
      name: 'thinking_delta → thinking_delta',
      input: { type: 'thinking_delta', data: { text: 't' } },
      expected: { type: 'thinking_delta', text: 't' },
    },
    {
      name: 'tool_progress → tool_progress (delta content)',
      input: { type: 'tool_progress', data: { toolCallId: 't1', content: 'line 1\n' } },
      expected: { type: 'tool_progress', toolCallId: 't1', content: 'line 1\n' },
    },
    {
      name: 'hook_started → hook_update running (identity fields)',
      input: {
        type: 'hook_started',
        data: { hookId: 'h1', hookName: 'lint', hookEvent: 'PostToolUse', toolCallId: 't1' },
      },
      expected: {
        type: 'hook_update',
        hookId: 'h1',
        status: 'running',
        hookName: 'lint',
        hookEvent: 'PostToolUse',
        toolCallId: 't1',
      },
    },
    {
      name: 'hook_started with null toolCallId → hook_update preserving null (session-level hook)',
      input: {
        type: 'hook_started',
        data: { hookId: 'h2', hookName: 'session', hookEvent: 'SessionStart', toolCallId: null },
      },
      expected: {
        type: 'hook_update',
        hookId: 'h2',
        status: 'running',
        hookName: 'session',
        hookEvent: 'SessionStart',
        toolCallId: null,
      },
    },
    {
      name: 'hook_progress → hook_update running (cumulative output)',
      input: { type: 'hook_progress', data: { hookId: 'h1', stdout: 'out', stderr: '' } },
      expected: { type: 'hook_update', hookId: 'h1', status: 'running', stdout: 'out', stderr: '' },
    },
    {
      name: 'hook_response → hook_update with outcome status + exitCode',
      input: {
        type: 'hook_response',
        data: {
          hookId: 'h1',
          hookName: 'lint',
          outcome: 'error',
          exitCode: 2,
          stdout: '',
          stderr: 'boom',
        },
      },
      expected: {
        type: 'hook_update',
        hookId: 'h1',
        status: 'error',
        hookName: 'lint',
        stdout: '',
        stderr: 'boom',
        exitCode: 2,
      },
    },
    {
      name: 'memory_recall → memory_recall (entries pass through)',
      input: {
        type: 'memory_recall',
        data: { mode: 'select', memories: [{ path: '/m/a.md', scope: 'personal' }] },
      },
      expected: {
        type: 'memory_recall',
        mode: 'select',
        memories: [{ path: '/m/a.md', scope: 'personal' }],
      },
    },
    {
      name: 'compact_boundary → compact_boundary (camelCased metadata passes through, DOR-118)',
      input: {
        type: 'compact_boundary',
        data: { trigger: 'manual', preTokens: 52000, postTokens: 8000, durationMs: 1200 },
      },
      expected: {
        type: 'compact_boundary',
        trigger: 'manual',
        preTokens: 52000,
        postTokens: 8000,
        durationMs: 1200,
      },
    },
    {
      name: 'compact_boundary → compact_boundary (preTokens 0 survives, malformed validates as {})',
      input: { type: 'compact_boundary', data: { preTokens: 0 } },
      expected: { type: 'compact_boundary', preTokens: 0 },
    },
    {
      name: 'system_status → system_status (hook flash)',
      input: {
        type: 'system_status',
        data: { message: 'Running hook "format"…' },
      },
      expected: { type: 'system_status', message: 'Running hook "format"…' },
    },
    {
      name: 'operation_progress → operation_progress (compaction started, DOR-110)',
      input: {
        type: 'operation_progress',
        data: {
          operation: 'compaction',
          state: 'started',
          determinate: false,
          message: 'Compacting context…',
        },
      },
      expected: {
        type: 'operation_progress',
        operation: 'compaction',
        state: 'started',
        determinate: false,
        message: 'Compacting context…',
      },
    },
    {
      name: 'operation_progress → operation_progress (failed compaction carries error, DOR-110)',
      input: {
        type: 'operation_progress',
        data: { operation: 'compaction', state: 'failed', determinate: false, error: 'boom' },
      },
      expected: {
        type: 'operation_progress',
        operation: 'compaction',
        state: 'failed',
        determinate: false,
        error: 'boom',
      },
    },
    {
      name: 'interaction_cancelled (aborted) → interaction_resolved with cancelled resolution (F5)',
      input: {
        type: 'interaction_cancelled',
        data: { interactionId: 'toolu_q1', reason: 'aborted' },
      },
      expected: {
        type: 'interaction_resolved',
        id: 'toolu_q1',
        resolution: 'cancelled',
        at: expect.any(Number),
      },
    },
    {
      // An expiry was ANSWERED (auto-denied) on the operator's behalf, unlike an
      // abort that withdrew the question. Clients keep a record of the first and
      // not the second, so collapsing both to `cancelled` erased a decision.
      name: 'interaction_cancelled (timeout) → interaction_resolved with expired resolution',
      input: {
        type: 'interaction_cancelled',
        data: { interactionId: 'toolu_q2', reason: 'timeout' },
      },
      expected: {
        type: 'interaction_resolved',
        id: 'toolu_q2',
        resolution: 'expired',
        at: expect.any(Number),
      },
    },
    {
      // DOR-1148: an OpenCode `permission.replied` echo reporting `once`/
      // `always` means the SAME yes an in-DorkOS approve means, so it must earn
      // the SAME receipt (the projector's `resolveInteraction('approved')` path).
      name: 'interaction_cancelled (approved) → interaction_resolved with approved resolution',
      input: {
        type: 'interaction_cancelled',
        data: { interactionId: 'per_q3', reason: 'approved' },
      },
      expected: {
        type: 'interaction_resolved',
        id: 'per_q3',
        resolution: 'approved',
        at: expect.any(Number),
      },
    },
    {
      // DOR-1148: the `reject` half of the same echo.
      name: 'interaction_cancelled (denied) → interaction_resolved with denied resolution',
      input: {
        type: 'interaction_cancelled',
        data: { interactionId: 'per_q4', reason: 'denied' },
      },
      expected: {
        type: 'interaction_resolved',
        id: 'per_q4',
        resolution: 'denied',
        at: expect.any(Number),
      },
    },
    // Typed turn errors ride the durable stream (adapter-yielded or injected by
    // guardTurnErrors): live clients render them inline and the projector
    // latches SessionStatus.lastError. Pre-fix these default-dropped to null,
    // so OpenCode/Codex failures were invisible on /events.
    {
      name: 'error → error (all four fields carried)',
      input: {
        type: 'error',
        data: {
          message: 'SDK exploded',
          code: 'turn_exception',
          category: 'execution_error',
          details: 'stack trace',
        },
      },
      expected: {
        type: 'error',
        message: 'SDK exploded',
        code: 'turn_exception',
        category: 'execution_error',
        details: 'stack trace',
      },
    },
    {
      name: 'error → error (missing optionals omitted, message falls back)',
      input: { type: 'error', data: {} },
      expected: { type: 'error', message: 'Unknown error' },
    },
    // Events with no durable session-stream projection map to null.
    {
      name: 'done → null (turn boundary handled by feedProjector)',
      input: { type: 'done', data: { sessionId: 's1' } },
      expected: null,
    },
    {
      name: 'sync_update → null',
      input: { type: 'sync_update', data: { sessionId: 's1', timestamp: 'now' } },
      expected: null,
    },
    {
      name: 'permission_denied → null',
      input: {
        type: 'permission_denied',
        data: { toolCallId: 't', toolName: 'Bash', message: 'no' },
      },
      expected: null,
    },
    {
      name: 'ui_command → ui_command (carries the command whole)',
      input: {
        type: 'ui_command',
        data: {
          command: { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } },
        },
      } as unknown as StreamEvent,
      expected: {
        type: 'ui_command',
        command: { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } },
      },
    },
    {
      name: 'ui_command with no command → null (defensive)',
      input: { type: 'ui_command', data: {} } as unknown as StreamEvent,
      expected: null,
    },
    {
      name: 'devtools_capture_request → devtools_capture_request (carries the requestId)',
      input: {
        type: 'devtools_capture_request',
        data: { requestId: 'req-123' },
      } as unknown as StreamEvent,
      expected: { type: 'devtools_capture_request', requestId: 'req-123' },
    },
    {
      name: 'devtools_capture_request with no requestId → null (defensive)',
      input: { type: 'devtools_capture_request', data: {} } as unknown as StreamEvent,
      expected: null,
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(toRawSessionEvent(input)).toEqual(expected);
    });
  }
});

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

  // turn_end carries the terminalReason seen on a session_status/done event.
  it('attaches the last-seen terminalReason to turn_end', async () => {
    const projector = new SessionStateProjector('s2');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'session_status', data: { sessionId: 's2', terminalReason: 'max_turns' } };
      yield { type: 'done', data: { sessionId: 's2' } };
    }

    await feedProjector(projector, turn());

    const turnEnd = ingestSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'turn_end');
    expect(turnEnd).toMatchObject({ type: 'turn_end', terminalReason: 'max_turns' });
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

  // Explicit reasons always win: the latch only fills an UNDEFINED reason, so a
  // runtime that recovered from a mid-turn error and completed cleanly keeps its
  // explicit 'completed'.
  it('lets an explicit terminalReason beat the error latch', async () => {
    const projector = new SessionStateProjector('s-latch-2');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'error', data: { message: 'transient item failure' } };
      yield {
        type: 'session_status',
        data: { sessionId: 's-latch-2', terminalReason: 'completed' },
      };
      yield { type: 'done', data: { sessionId: 's-latch-2' } };
    }

    await feedProjector(projector, turn());

    const turnEnd = ingestSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'turn_end');
    expect(turnEnd).toMatchObject({ type: 'turn_end', terminalReason: 'completed' });
  });

  // The latch also covers the finally branch: a stream that dies after an error
  // WITHOUT a done still closes as an error turn, not a reason-less one.
  it('latches a yielded error into the finally-branch turn_end when the stream ends without done', async () => {
    const projector = new SessionStateProjector('s-latch-3');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'error', data: { message: 'stream died' } };
    }

    await feedProjector(projector, turn());

    const turnEnd = ingestSpy.mock.calls.map((c) => c[0]).find((e) => e.type === 'turn_end');
    expect(turnEnd).toMatchObject({ type: 'turn_end', terminalReason: 'error' });
    expect(projector.getStatus().lifecycle).toBe('error');
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

  // DOR-110: compaction members ride the replay stream with NO explicit
  // projector case (project() auto-appends non-status events to the turn), and
  // neither operation_progress nor compact_boundary touches the held status.
  it('projects compaction members into the stream without touching status', async () => {
    const projector = new SessionStateProjector('s6');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield {
        type: 'operation_progress',
        data: {
          operation: 'compaction',
          state: 'started',
          determinate: false,
          message: 'Compacting context…',
        },
      };
      yield {
        type: 'compact_boundary',
        data: { trigger: 'auto', preTokens: 90000, postTokens: 12000 },
      };
      yield { type: 'done', data: { sessionId: 's6' } };
    }

    await feedProjector(projector, turn());
    expect(projector.replayFrom(0).map((e) => e.type)).toEqual([
      'turn_start',
      'operation_progress',
      'compact_boundary',
      'turn_end',
    ]);
    // None of these are status deltas — the projection stays cold/idle.
    const status = projector.getStatus();
    expect(status.lifecycle).toBe('idle');
    expect(status.contextUsage).toBeNull();
  });

  // Failure mode: outputTokens clobbered to 0 at turn end via the real
  // normalizer→projector path — a streaming session_status reports outputTokens,
  // then a final session_status reports context/cache totals (no outputTokens).
  // The running count must survive into buildSnapshot's served status.
  it('preserves outputTokens across a streaming-then-final session_status', async () => {
    const projector = new SessionStateProjector('s4');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'session_status', data: { sessionId: 's4', outputTokens: 20 } };
      yield {
        type: 'session_status',
        data: { sessionId: 's4', contextTokens: 100, cacheReadTokens: 80 },
      };
      yield { type: 'done', data: { sessionId: 's4' } };
    }

    await feedProjector(projector, turn());
    const usage = projector.getStatus().contextUsage;
    expect(usage?.outputTokens).toBe(20); // survived the final event
    expect(usage?.totalTokens).toBe(100); // updated by the final event
    expect(usage?.cacheReadTokens).toBe(80); // updated by the final event
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

  // The ui_command rides `inProgressTurn` only WHILE the turn is live; a cold
  // snapshot taken after turn_end must not re-pop the canvas (it is imperative,
  // not durable state — cross-reconnect canvas state lives in client localStorage).
  it('clears the ui_command from a post-turn cold snapshot (no re-pop on reconnect)', async () => {
    const projector = new SessionStateProjector('s8');
    const command = { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } };

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'ui_command', data: { command } } as unknown as StreamEvent;
      yield { type: 'done', data: { sessionId: 's8' } };
    }

    await feedProjector(projector, turn());

    const snapshot = await projector.buildSnapshot(async () => []);
    expect(snapshot.inProgressTurn).toBeNull();
  });
});

describe('capability approval hold round-trip (DOR-939)', () => {
  // The ONLY code carrying approval/startedAt/capMs/approvalId across the
  // emitted-StreamEvent ({type,data:{...}}) -> RawSessionEvent bridge is
  // toCapabilityApprovalRequiredEvent / toCapabilityApprovalResolvedEvent. Neither
  // the hold test (asserts the PUSHED StreamEvent shape) nor the projector test
  // (ingests an already-normalized event) crosses it. A typo there
  // (`data.capMs` -> `data.capMS`) would fall back to the safe default and still
  // pass both suites while silently losing the hold's REAL cap. These feed the
  // EMITTED shape through and assert the values survive AND the projector pauses.
  const HELD_APPROVAL = {
    approvalId: 'appr-1',
    capabilityId: 'mcp.add',
    capabilityTitle: 'Add an MCP server',
    tier: 'destructive' as const,
    summary: 'Prober wants to run "Add an MCP server"',
    hasAgentPath: true,
    requestedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T02:00:00.000Z',
  };
  // Distinct from CAPABILITY_APPROVAL_HOLD_CAP_MS so a typo that falls back to
  // the default is CAUGHT by the value assertion, not masked by it.
  const EMITTED_CAP_MS = 30_000;
  const EMITTED_STARTED_AT = 1_234_000;

  it('carries approval/startedAt/capMs across the normalizer, then pauses the projector', () => {
    vi.useFakeTimers();
    vi.setSystemTime(EMITTED_STARTED_AT);
    try {
      const raw = toRawSessionEvent({
        type: 'capability_approval_required',
        data: { approval: HELD_APPROVAL, startedAt: EMITTED_STARTED_AT, capMs: EMITTED_CAP_MS },
      } as unknown as StreamEvent);

      // The bridge preserved every field the projector's pause math depends on.
      expect(raw).toEqual({
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: EMITTED_STARTED_AT,
        capMs: EMITTED_CAP_MS,
      });

      // …and the normalized event actually pauses the watchdog when ingested.
      const projector = new SessionStateProjector('s1');
      projector.ingest(raw as RawSessionEvent);
      expect(projector.hasPendingInteractions()).toBe(true);
      // One tick short of the EMITTED cap (not the default): still a live wait.
      vi.setSystemTime(EMITTED_STARTED_AT + EMITTED_CAP_MS - 1);
      expect(projector.hasPendingInteractions()).toBe(true);
      // Past the emitted cap AND its stall-pause grace, the hold is stale. (A
      // capMs typo would fall back to the much larger default and read true here;
      // the value assertion above is what catches it.)
      vi.setSystemTime(EMITTED_STARTED_AT + EMITTED_CAP_MS + CAPABILITY_HOLD_PAUSE_GRACE_MS);
      expect(projector.hasPendingInteractions()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries approvalId across the normalizer so the resolution untracks the hold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(EMITTED_STARTED_AT);
    try {
      const projector = new SessionStateProjector('s1');
      projector.ingest(
        toRawSessionEvent({
          type: 'capability_approval_required',
          data: { approval: HELD_APPROVAL, startedAt: EMITTED_STARTED_AT, capMs: EMITTED_CAP_MS },
        } as unknown as StreamEvent) as RawSessionEvent
      );
      expect(projector.hasPendingInteractions()).toBe(true);

      const resolved = toRawSessionEvent({
        type: 'capability_approval_resolved',
        data: { approvalId: 'appr-1', outcome: 'granted' },
      } as unknown as StreamEvent);
      expect(resolved).toEqual({
        type: 'capability_approval_resolved',
        approvalId: 'appr-1',
        outcome: 'granted',
      });

      // The approvalId survived the bridge, so the resolution found and dropped the
      // hold — the watchdog is armed again well before the cap would have expired.
      projector.ingest(resolved as RawSessionEvent);
      expect(projector.hasPendingInteractions()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('in-conversation MCP sign-in round-trip (DOR-1004)', () => {
  // The only code carrying the card's fields across the emitted-StreamEvent
  // ({type,data:{...}}) -> RawSessionEvent bridge is toMcpSigninRequiredEvent /
  // toMcpSigninResolvedEvent. A typo there (`data.authorizeUrl` ->
  // `data.authorizeURL`) would put an empty, un-clickable link on the card while
  // every other suite stayed green.
  const CARD = {
    serverName: 'granola',
    agentId: '01HV7KJZZZ0000000000000000',
    flowId: 'flow-1',
    authorizeUrl: 'https://mcp.test.local/authorize?code_challenge=abc',
    disclosure: 'DorkOS stores the token on this machine.',
  };

  it('carries every card field across the normalizer', () => {
    const raw = toRawSessionEvent({
      type: 'mcp_signin_required',
      data: CARD,
    } as unknown as StreamEvent);

    expect(raw).toEqual({ type: 'mcp_signin_required', ...CARD });
  });

  it('never blocks the session or pauses the stall watchdog', () => {
    // A sign-in card is not a hold: the tool call already returned and the turn
    // is free to end. Treating it as pending would park the session on a person
    // who may be minutes away in a browser, and steal the lock the whole time.
    const projector = new SessionStateProjector('s1');
    projector.ingest({ type: 'turn_start' } as RawSessionEvent);
    projector.ingest(
      toRawSessionEvent({
        type: 'mcp_signin_required',
        data: CARD,
      } as unknown as StreamEvent) as RawSessionEvent
    );

    expect(projector.hasPendingInteractions()).toBe(false);
    expect(projector.getStatus().lifecycle).toBe('streaming');
  });

  it('degrades a missing outcome to failed, never to connected', () => {
    // `connected` RETIRES the card. Guessing it on a malformed event would delete
    // a live sign-in surface out from under someone mid-flow; `failed` leaves a
    // visible note instead.
    expect(
      toRawSessionEvent({
        type: 'mcp_signin_resolved',
        data: { flowId: 'flow-1' },
      } as unknown as StreamEvent)
    ).toEqual({ type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'failed' });

    expect(
      toRawSessionEvent({
        type: 'mcp_signin_resolved',
        data: { flowId: 'flow-1', outcome: 'connected' },
      } as unknown as StreamEvent)
    ).toEqual({ type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected' });
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

  // The second `done` must not OVERWRITE the first close either: it carries a
  // reason that belongs to whatever the runtime did next, not to this turn.
  it('keeps the first close’s terminalReason when a second done carries another', async () => {
    const projector = new SessionStateProjector('win-2');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'session_status', data: { sessionId: 'win-2', terminalReason: 'completed' } };
      yield { type: 'done', data: { sessionId: 'win-2' } };
      yield { type: 'done', data: { sessionId: 'win-2', terminalReason: 'max_turns' } };
    }

    await feedProjector(projector, turn());

    const turnEnds = ingestSpy.mock.calls.map((c) => c[0]).filter((e) => e.type === 'turn_end');
    expect(turnEnds).toEqual([{ type: 'turn_end', terminalReason: 'completed' }]);
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

  // The reopened window is a real turn: while it runs the session reads
  // `streaming`, which is the whole point — the busy bar comes back to life.
  it('puts the lifecycle back to streaming while the reopened window runs', async () => {
    const projector = new SessionStateProjector('win-4');
    const seen: string[] = [];

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'done', data: { sessionId: 'win-4' } };
      seen.push(`after-done:${projector.getStatus().lifecycle}`);
      yield { type: 'text_delta', data: { text: 'awake again' } };
      seen.push(`after-reopen:${projector.getStatus().lifecycle}`);
    }

    await feedProjector(projector, turn());

    expect(seen).toEqual(['after-done:idle', 'after-reopen:streaming']);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  // A reopened window that the runtime never terminates is closed by the
  // `finally`, so a woken agent whose stream dies cannot strand the session at
  // `streaming` forever.
  it('closes a reopened window from the finally when the stream ends without a done', async () => {
    const projector = new SessionStateProjector('win-5');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'done', data: { sessionId: 'win-5' } };
      yield { type: 'text_delta', data: { text: 'awake' } };
    }

    await feedProjector(projector, turn());

    expect(ingestSpy.mock.calls.map((c) => c[0].type)).toEqual([
      'turn_start',
      'turn_end',
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  // The reopened window starts clean. The closed turn's failure belonged to the
  // closed turn; carrying it forward would settle brand-new work as an error
  // before it produced anything.
  it('does not carry the closed window’s error latch into the reopened one', async () => {
    const projector = new SessionStateProjector('win-6');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'error', data: { message: 'a tool blew up' } };
      yield { type: 'done', data: { sessionId: 'win-6' } };
      yield { type: 'text_delta', data: { text: 'recovered, carrying on' } };
      yield { type: 'done', data: { sessionId: 'win-6' } };
    }

    await feedProjector(projector, turn());

    const turnEnds = ingestSpy.mock.calls.map((c) => c[0]).filter((e) => e.type === 'turn_end');
    expect(turnEnds).toEqual([{ type: 'turn_end', terminalReason: 'error' }, { type: 'turn_end' }]);
    expect(projector.getStatus().lifecycle).toBe('idle');
  });

  // Only the FIRST window is the caller's turn. `trigger-turn`/the room runner
  // treat the reported seq as the identity of the turn they started, so a
  // runtime-initiated continuation must never re-announce over it.
  it('reports onTurnStart for the first window only', async () => {
    const projector = new SessionStateProjector('win-7');
    const reported: number[] = [];

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'done', data: { sessionId: 'win-7' } };
      yield { type: 'text_delta', data: { text: 'awake' } };
      yield { type: 'done', data: { sessionId: 'win-7' } };
    }

    await feedProjector(projector, turn(), { onTurnStart: (seq) => reported.push(seq) });

    expect(reported).toEqual([1]);
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

// A background task that is still running when the runtime's stream ends stops
// being VISIBLE: the subprocess it lived in exited, so its `task_notification`
// can never arrive. Nothing else in the system would ever clear it, so an
// uncleared count is a permanent on-screen lie (DOR-1100) — and the terminal
// update the sweep writes says `untracked`, not `stopped`, because a detached
// child outlives that process and DorkOS cannot tell the two apart (DOR-1108).
describe('feedProjector — stranded background children', () => {
  it('retires every still-running child when the stream ends', async () => {
    const projector = new SessionStateProjector('strand-1');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'background_task_started', data: { taskId: 'bt1', description: 'lint' } };
      yield { type: 'background_task_started', data: { taskId: 'bt2', description: 'tests' } };
      yield { type: 'background_task_done', data: { taskId: 'bt1', status: 'completed' } };
      yield { type: 'done', data: { sessionId: 'strand-1' } };
    }

    await feedProjector(projector, turn());

    expect(projector.getStatus().runningSubagentCount).toBe(0);
    // The one that never reported gets a terminal update of its own, so a
    // replay and a live client drain through the same event.
    // Every non-running update, so the child that DID report is pinned as
    // `complete` (its own word) beside the swept one's `untracked` (DorkOS's).
    const terminal = ingestSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'subagent_update' && e.status !== 'running');
    expect(terminal).toEqual([
      { type: 'subagent_update', taskId: 'bt1', status: 'complete' },
      { type: 'subagent_update', taskId: 'bt2', status: 'untracked' },
    ]);
  });

  // DOR-1108: the sweep knows the agent's process is gone. It does NOT know that
  // everything the agent started is gone with it — a child the agent detached
  // keeps running, and saying `stopped` would report a death nobody witnessed.
  // The one word that is true of every swept child is that DorkOS lost sight of
  // it.
  it('says it lost track of them, never that it stopped them', async () => {
    const projector = new SessionStateProjector('strand-5');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      // A `nohup`'d dev server: started as a background task, still serving long
      // after the turn — and the CLI — is over.
      yield { type: 'background_task_started', data: { taskId: 'dev-server' } };
      yield { type: 'done', data: { sessionId: 'strand-5' } };
    }

    await feedProjector(projector, turn());

    const terminal = ingestSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'subagent_update' && e.status !== 'running');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ status: 'untracked' });
    // The claim that was wrong: nothing on this stream may report a stop.
    expect(terminal.some((e) => e.type === 'subagent_update' && e.status === 'stopped')).toBe(
      false
    );
  });

  // The stop must land INSIDE the window, before it closes: outside it, the turn
  // would be persisted still claiming the child was running.
  it('retires them before the final turn_end, not after', async () => {
    const projector = new SessionStateProjector('strand-2');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'background_task_started', data: { taskId: 'bt1' } };
    }

    await feedProjector(projector, turn());

    expect(ingestSpy.mock.calls.map((c) => c[0].type)).toEqual([
      'turn_start',
      'subagent_update',
      'subagent_update',
      'turn_end',
    ]);
  });

  // A stream that ends with the agent mid-wake-up closes the reopened window
  // AND retires its children — one sweep at the end covers every terminal shape.
  it('retires them once across a stream that carried two windows', async () => {
    const projector = new SessionStateProjector('strand-3');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'background_task_started', data: { taskId: 'bt1' } };
      yield { type: 'done', data: { sessionId: 'strand-3' } };
      yield { type: 'text_delta', data: { text: 'awake' } };
      yield { type: 'done', data: { sessionId: 'strand-3' } };
    }

    await feedProjector(projector, turn());

    const swept = ingestSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'subagent_update' && e.status === 'untracked');
    expect(swept).toHaveLength(1);
    expect(projector.getStatus().runningSubagentCount).toBe(0);
  });

  // Nothing running, nothing swept: an ordinary turn gains no events at all.
  it('adds nothing to a turn that had no children', async () => {
    const projector = new SessionStateProjector('strand-4');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'hi' } };
      yield { type: 'done', data: { sessionId: 'strand-4' } };
    }

    await feedProjector(projector, turn());

    expect(ingestSpy.mock.calls.map((c) => c[0].type)).toEqual([
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
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

  // `mapResultEvent` puts `done` last within the result, and emits nothing that
  // normalizes into a reopening type. Those two facts are what make the reopen
  // rule safe, so they are pinned here directly: if the mapper ever reorders,
  // this fails and names the reason rather than leaving the window test to fail
  // for a cause nobody can see.
  it('pins done as the last event the result mapper yields, ahead of no reopeners', async () => {
    const emitted: StreamEvent[] = [];
    for await (const event of mapResultEvent(
      RESULT_MESSAGE,
      {} as unknown as Parameters<typeof mapResultEvent>[1],
      'normal-2'
    )) {
      emitted.push(event);
    }

    expect(emitted[emitted.length - 1]?.type).toBe('done');
    const reopeners = emitted.filter((event) => TURN_REOPENING_STREAM_EVENT_TYPES.has(event.type));
    expect(reopeners).toEqual([]);
  });
});
