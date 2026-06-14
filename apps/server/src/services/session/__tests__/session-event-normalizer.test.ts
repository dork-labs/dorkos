import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RawSessionEvent } from '../index.js';
import { toRawSessionEvent, feedProjector } from '../session-event-normalizer.js';
import { SessionStateProjector } from '../index.js';

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
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: true,
        title: 'Run command?',
      },
    },
    {
      name: 'question_prompt → question_prompt (id from toolCallId)',
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
        serverName: 'srv',
        message: 'fill this',
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
        },
      },
      expected: {
        type: 'status_change',
        status: {
          model: 'claude-test',
          cost: 0.5,
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
      name: 'system_status → system_status (in-flight compacting, DOR-118)',
      input: {
        type: 'system_status',
        data: { message: 'Compacting context…', status: 'compacting' },
      },
      expected: { type: 'system_status', message: 'Compacting context…', status: 'compacting' },
    },
    {
      name: 'system_status → system_status (failed compaction carries compactError, DOR-118)',
      input: {
        type: 'system_status',
        data: { message: 'Status: compacting', compactResult: 'failed', compactError: 'boom' },
      },
      expected: {
        type: 'system_status',
        message: 'Status: compacting',
        compactResult: 'failed',
        compactError: 'boom',
      },
    },
    {
      name: 'interaction_cancelled → interaction_resolved with cancelled resolution (F5)',
      input: {
        type: 'interaction_cancelled',
        data: { interactionId: 'toolu_q1', reason: 'aborted' },
      },
      expected: { type: 'interaction_resolved', id: 'toolu_q1', resolution: 'cancelled' },
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

  // DOR-118: compaction + local-command members ride the replay stream with NO
  // explicit projector case (project() auto-appends non-status events to the
  // turn), and system_status leaves the held status projection untouched.
  it('projects compaction members into the stream without touching status', async () => {
    const projector = new SessionStateProjector('s6');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield {
        type: 'system_status',
        data: { message: 'Compacting context…', status: 'compacting' },
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
      'system_status',
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
