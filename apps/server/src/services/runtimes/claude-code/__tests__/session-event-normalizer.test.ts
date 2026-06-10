import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RawSessionEvent } from '../../../session/index.js';
import { toRawSessionEvent, feedProjector } from '../sessions/session-event-normalizer.js';
import { SessionStateProjector } from '../../../session/index.js';

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
    // Events with no durable session-stream projection map to null.
    {
      name: 'thinking_delta → null',
      input: { type: 'thinking_delta', data: { text: 't' } },
      expected: null,
    },
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
});
