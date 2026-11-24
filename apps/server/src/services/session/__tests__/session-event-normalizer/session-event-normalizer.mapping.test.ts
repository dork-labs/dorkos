import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { toRawSessionEvent } from '../../session-event-normalizer.js';

describe('toRawSessionEvent — tools, prompts, status and background work', () => {
  // Each StreamEvent kind maps to the right session-stream union member (or null).
  const cases: Array<{ name: string; input: StreamEvent; expected: unknown }> = [
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
            // A live context reading is dated when it is taken (spec §6 U).
            observedAt: expect.any(String),
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
      expected: {
        type: 'subagent_update',
        taskId: 'bt1',
        status: 'running',
        description: 'sub',
        taskType: 'agent',
        startedAt: 1,
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
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(toRawSessionEvent(input)).toEqual(expected);
    });
  }
});
