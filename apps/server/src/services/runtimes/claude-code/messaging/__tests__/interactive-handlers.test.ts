import { describe, it, expect, vi } from 'vitest';
import {
  createCanUseTool,
  handleAskUserQuestion,
  handleElicitation,
  handleToolApproval,
  type InteractiveSession,
  type PendingInteraction,
  type ToolApprovalContext,
} from '../interactive-handlers.js';
import type { StreamEvent, QuestionItem } from '@dorkos/shared/types';
import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';

/** Build a minimal interactive session with a configurable permission mode. */
function makeSession(permissionMode: string): InteractiveSession & { permissionMode: string } {
  return {
    permissionMode,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
  };
}

/** Minimal SDK approval context — an unaborted signal is all the gate needs. */
function makeContext(toolUseID: string): ToolApprovalContext {
  return {
    signal: new AbortController().signal,
    toolUseID,
  };
}

const noopLog = () => {};

describe('createCanUseTool — approval gate', () => {
  const NON_SAFE_TOOL = 'Bash';

  it('routes a non-safe tool to approval (not auto-allow) in default mode', async () => {
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, noopLog);

    // handleToolApproval never resolves until the user responds, so we race the
    // pending promise against a microtask and assert it stayed pending while
    // pushing an approval_required event to the queue.
    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-1'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('tool-1')).toBe(true);
  });

  it('routes a non-safe tool to approval (not auto-allow) in auto mode', async () => {
    const session = makeSession('auto');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-2'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('tool-2')).toBe(true);
  });

  it('auto-allows a non-safe tool in acceptEdits mode', async () => {
    const session = makeSession('acceptEdits');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-3'));

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(session.eventQueue).toHaveLength(0);
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('auto-allows a non-safe tool in bypassPermissions mode', async () => {
    const session = makeSession('bypassPermissions');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-4'));

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(session.eventQueue).toHaveLength(0);
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('auto-allows read-only tools even in auto mode', async () => {
    const session = makeSession('auto');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool('Read', { file_path: '/tmp/x' }, makeContext('tool-5'));

    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/x' } });
    expect(session.eventQueue).toHaveLength(0);
  });
});

/** A bare session literal — no SDK mock, just the map + queue the handlers touch. */
function makeBareSession(): InteractiveSession {
  return {
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
  };
}

describe('pending interaction snapshots', () => {
  it('captures an approval snapshot at registration', () => {
    // Purpose: snapshot captured at registration carries the serializable
    // approval payload (toolName, JSON-stringified input, hasSuggestions).
    const session = makeBareSession();
    const context: ToolApprovalContext = {
      signal: new AbortController().signal,
      toolUseID: 'tool-approval-1',
    };

    // Fire-and-forget: the returned promise stays pending until the user responds.
    void handleToolApproval(session, 'tool-approval-1', 'Bash', { command: 'ls' }, context);

    const pending = session.pendingInteractions.get('tool-approval-1');
    expect(pending?.type).toBe('approval');
    expect(typeof pending?.startedAt).toBe('number');
    expect(pending?.snapshot).toMatchObject({
      toolName: 'Bash',
      input: JSON.stringify({ command: 'ls' }),
      hasSuggestions: false,
    });
  });

  it('captures a question snapshot deep-equal to the input questions', () => {
    // Purpose: question snapshot fidelity — the stored questions match input.
    const session = makeBareSession();
    const questions: QuestionItem[] = [
      {
        header: 'Pick',
        question: 'Which one?',
        multiSelect: false,
        options: [{ label: 'A', description: 'first' }],
      },
    ];

    void handleAskUserQuestion(session, 'question-1', { questions });

    const pending = session.pendingInteractions.get('question-1');
    expect(pending?.type).toBe('question');
    expect(typeof pending?.startedAt).toBe('number');
    expect(pending?.snapshot).toEqual({ questions });
  });

  it('cancels a pending question when the SDK aborts it (F5 — steer/interrupt)', async () => {
    // Acceptance run 20260610-173202, F5: a mid-turn steered message cancels a
    // pending AskUserQuestion SDK-side. This handler had NO abort wiring, so
    // the record lingered for the full 10-minute expiry and a refresh
    // resurrected an answerable ghost card. The abort must clear the record,
    // deny the SDK promise, and push an interaction_cancelled event so every
    // projection drops the card.
    const session = makeBareSession();
    const abort = new AbortController();
    const questions: QuestionItem[] = [
      { header: 'Pick', question: 'Which?', multiSelect: false, options: [{ label: 'A' }] },
    ];

    const result = handleAskUserQuestion(session, 'question-abort-1', { questions }, abort.signal);
    expect(session.pendingInteractions.has('question-abort-1')).toBe(true);

    abort.abort();

    await expect(result).resolves.toEqual({ behavior: 'deny', message: 'Question cancelled' });
    expect(session.pendingInteractions.has('question-abort-1')).toBe(false);
    expect(session.eventQueue.map((e) => e.type)).toEqual([
      'question_prompt',
      'interaction_cancelled',
    ]);
    expect(session.eventQueue[1].data).toEqual({
      interactionId: 'question-abort-1',
      reason: 'aborted',
    });
  });

  it('pushes interaction_cancelled when an approval is aborted (F5)', async () => {
    const session = makeBareSession();
    const abort = new AbortController();
    const context: ToolApprovalContext = { signal: abort.signal, toolUseID: 'tool-abort-1' };

    const result = handleToolApproval(session, 'tool-abort-1', 'Bash', { command: 'ls' }, context);
    abort.abort();

    await expect(result).resolves.toEqual({
      behavior: 'deny',
      message: 'Tool approval aborted',
    });
    expect(session.pendingInteractions.has('tool-abort-1')).toBe(false);
    expect(session.eventQueue.map((e) => e.type)).toEqual([
      'approval_required',
      'interaction_cancelled',
    ]);
    expect(session.eventQueue[1].data).toEqual({
      interactionId: 'tool-abort-1',
      reason: 'aborted',
    });
  });

  it('pushes interaction_cancelled when an approval times out (F5)', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const context: ToolApprovalContext = {
        signal: new AbortController().signal,
        toolUseID: 'tool-timeout-1',
      };

      const result = handleToolApproval(
        session,
        'tool-timeout-1',
        'Bash',
        { command: 'ls' },
        context
      );
      vi.advanceTimersByTime(10 * 60 * 1000);

      await expect(result).resolves.toMatchObject({ behavior: 'deny' });
      expect(session.pendingInteractions.has('tool-timeout-1')).toBe(false);
      expect(session.eventQueue.map((e) => e.type)).toEqual([
        'approval_required',
        'interaction_cancelled',
      ]);
      expect(session.eventQueue[1].data).toEqual({
        interactionId: 'tool-timeout-1',
        reason: 'timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures an elicitation snapshot matching the request', () => {
    // Purpose: elicitation snapshot fidelity — serverName/message match request.
    const session = makeBareSession();
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Please authenticate',
      mode: 'url',
      url: 'https://auth.example.com',
      elicitationId: 'elicit-snap-1',
    };

    void handleElicitation(session, request, new AbortController().signal);

    const pending = session.pendingInteractions.get('elicit-snap-1');
    expect(pending?.type).toBe('elicitation');
    expect(typeof pending?.startedAt).toBe('number');
    expect(pending?.snapshot).toMatchObject({
      serverName: 'test-mcp',
      message: 'Please authenticate',
    });
  });
});
