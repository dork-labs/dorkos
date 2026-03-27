import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  HookPart,
  MessagePart,
  SessionStatusEvent,
  TaskUpdateEvent,
} from '@dorkos/shared/types';
import { createStreamEventHandler } from '../stream-event-handler';

function createDeps() {
  const currentPartsRef = { current: [] as MessagePart[] };
  const orphanHooksRef = { current: new Map<string, HookPart[]>() };
  const assistantCreatedRef = { current: true }; // pre-set so ensureAssistantMessage is a no-op
  const sessionStatusRef = { current: null as SessionStatusEvent | null };
  const streamStartTimeRef = { current: null as number | null };
  const estimatedTokensRef = { current: 0 };
  const textStreamingTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const isTextStreamingRef = { current: false };
  const thinkingStartRef = { current: null as number | null };
  const setMessages = vi.fn();
  const setError = vi.fn();
  const setStatus = vi.fn();
  const setSessionStatus = vi.fn();
  const setEstimatedTokens = vi.fn();
  const setStreamStartTime = vi.fn();
  const setIsTextStreaming = vi.fn();
  const setRateLimitRetryAfter = vi.fn();
  const setIsRateLimited = vi.fn();
  const setSystemStatus = vi.fn();
  const setPromptSuggestions = vi.fn();
  const rateLimitClearRef = { current: null };
  const onTaskEventRef = { current: undefined as ((event: TaskUpdateEvent) => void) | undefined };
  const onSessionIdChangeRef = {
    current: undefined as ((newSessionId: string) => void) | undefined,
  };
  const onStreamingDoneRef = { current: undefined as (() => void) | undefined };

  const handler = createStreamEventHandler({
    currentPartsRef,
    orphanHooksRef,
    assistantCreatedRef,
    sessionStatusRef,
    streamStartTimeRef,
    estimatedTokensRef,
    textStreamingTimerRef,
    isTextStreamingRef,
    thinkingStartRef,
    setMessages,
    setError,
    setStatus,
    setSessionStatus,
    setEstimatedTokens,
    setStreamStartTime,
    setIsTextStreaming,
    setRateLimitRetryAfter,
    setIsRateLimited,
    setSystemStatus,
    setPromptSuggestions,
    rateLimitClearRef,
    sessionId: 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
    isRemappingRef: { current: false },
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return {
    handler,
    currentPartsRef,
    orphanHooksRef,
    setMessages,
  };
}

/** Push a tool_call part directly onto currentPartsRef (bypasses handler for test setup). */
function addToolCallPart(
  currentPartsRef: { current: MessagePart[] },
  toolCallId: string,
  toolName = 'Bash'
): void {
  currentPartsRef.current.push({
    type: 'tool_call',
    toolCallId,
    toolName,
    input: '',
    status: 'running',
  } as MessagePart);
}

describe('stream-event-handler — hook_started', () => {
  it('appends a new hook to an existing tool call hooks array', () => {
    // Purpose: When hook_started arrives with a toolCallId that matches a buffered
    // tool_call part, the hook is added directly to that part's hooks array.
    const { handler, currentPartsRef, setMessages } = createDeps();

    addToolCallPart(currentPartsRef, 'tc-1');

    handler(
      'hook_started',
      { hookId: 'h-1', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-1' },
      'asst-1'
    );

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-1'
    );
    expect(tcPart).toBeDefined();
    if (tcPart?.type === 'tool_call') {
      expect(tcPart.hooks).toHaveLength(1);
      expect(tcPart.hooks![0]).toMatchObject({
        hookId: 'h-1',
        hookName: 'pre-tool',
        hookEvent: 'PreToolUse',
        status: 'running',
        stdout: '',
        stderr: '',
      });
    }

    // UI must be updated so the hook renders immediately
    expect(setMessages).toHaveBeenCalled();
  });

  it('buffers into orphanHooksRef when no matching tool call exists', () => {
    // Purpose: Hook events can arrive before their owning tool_call_start.
    // When this happens the hook is stored in the orphan Map keyed by toolCallId
    // so tool_call_start can drain it.
    const { handler, currentPartsRef, orphanHooksRef, setMessages } = createDeps();

    handler(
      'hook_started',
      { hookId: 'h-2', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-orphan' },
      'asst-1'
    );

    // No tool call part should have been created
    expect(currentPartsRef.current).toHaveLength(0);

    // Hook should be waiting in the orphan Map
    expect(orphanHooksRef.current.has('tc-orphan')).toBe(true);
    const buffered = orphanHooksRef.current.get('tc-orphan');
    expect(buffered).toHaveLength(1);
    expect(buffered![0]).toMatchObject({
      hookId: 'h-2',
      status: 'running',
    });

    // setMessages must NOT have been called — nothing to render yet
    expect(setMessages).not.toHaveBeenCalled();
  });

  it('is a no-op when toolCallId is null', () => {
    // Purpose: Session-level hooks (toolCallId: null) are routed by the server as
    // system_status or error events. The client ignores them at the hook_started level.
    const { handler, currentPartsRef, orphanHooksRef, setMessages } = createDeps();

    handler(
      'hook_started',
      { hookId: 'h-3', hookName: 'session-hook', hookEvent: 'PreToolUse', toolCallId: null },
      'asst-1'
    );

    expect(currentPartsRef.current).toHaveLength(0);
    expect(orphanHooksRef.current.size).toBe(0);
    expect(setMessages).not.toHaveBeenCalled();
  });

  it('accumulates multiple orphan hooks for the same toolCallId', () => {
    // Purpose: If more than one hook fires before tool_call_start they should all
    // be queued in the same Map entry so none are lost.
    const { handler, orphanHooksRef } = createDeps();

    handler(
      'hook_started',
      { hookId: 'h-a', hookName: 'hook-a', hookEvent: 'PreToolUse', toolCallId: 'tc-multi' },
      'asst-1'
    );
    handler(
      'hook_started',
      { hookId: 'h-b', hookName: 'hook-b', hookEvent: 'PreToolUse', toolCallId: 'tc-multi' },
      'asst-1'
    );

    const buffered = orphanHooksRef.current.get('tc-multi');
    expect(buffered).toHaveLength(2);
    expect(buffered![0].hookId).toBe('h-a');
    expect(buffered![1].hookId).toBe('h-b');
  });
});

describe('stream-event-handler — hook_progress', () => {
  it('updates stdout and stderr on the matching hook', () => {
    // Purpose: Intermediate output from a running hook script must be reflected on
    // the correct HookPart so the UI can show live output.
    const { handler, currentPartsRef, setMessages } = createDeps();

    addToolCallPart(currentPartsRef, 'tc-2');

    // Attach a hook via hook_started
    handler(
      'hook_started',
      { hookId: 'h-4', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-2' },
      'asst-1'
    );

    // Now send progress
    handler('hook_progress', { hookId: 'h-4', stdout: 'Running checks...', stderr: '' }, 'asst-1');

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-2'
    );
    expect(tcPart?.type).toBe('tool_call');
    if (tcPart?.type === 'tool_call') {
      const hook = tcPart.hooks?.find((h) => h.hookId === 'h-4');
      expect(hook).toBeDefined();
      expect(hook!.stdout).toBe('Running checks...');
      expect(hook!.stderr).toBe('');
    }

    expect(setMessages).toHaveBeenCalled();
  });

  it('updates both stdout and stderr independently', () => {
    // Purpose: Stderr output must not overwrite stdout — both channels are tracked.
    const { handler, currentPartsRef } = createDeps();

    addToolCallPart(currentPartsRef, 'tc-3');
    handler(
      'hook_started',
      { hookId: 'h-5', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-3' },
      'asst-1'
    );
    handler(
      'hook_progress',
      { hookId: 'h-5', stdout: 'stdout line', stderr: 'stderr line' },
      'asst-1'
    );

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-3'
    );
    if (tcPart?.type === 'tool_call') {
      const hook = tcPart.hooks?.find((h) => h.hookId === 'h-5');
      expect(hook!.stdout).toBe('stdout line');
      expect(hook!.stderr).toBe('stderr line');
    }
  });
});

describe('stream-event-handler — hook_response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps "error" outcome to status "error" and records exitCode and output', () => {
    // Purpose: A hook that exits non-zero must surface as status: 'error' with the
    // exit code and output captured so the UI can show the failure details.
    const { handler, currentPartsRef, setMessages } = createDeps();

    addToolCallPart(currentPartsRef, 'tc-4');
    handler(
      'hook_started',
      { hookId: 'h-6', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-4' },
      'asst-1'
    );
    handler(
      'hook_response',
      {
        hookId: 'h-6',
        hookName: 'pre-tool',
        outcome: 'error',
        exitCode: 1,
        stdout: 'output before crash',
        stderr: 'fatal: something went wrong',
      },
      'asst-1'
    );

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-4'
    );
    if (tcPart?.type === 'tool_call') {
      const hook = tcPart.hooks?.find((h) => h.hookId === 'h-6');
      expect(hook!.status).toBe('error');
      expect(hook!.exitCode).toBe(1);
      expect(hook!.stdout).toBe('output before crash');
      expect(hook!.stderr).toBe('fatal: something went wrong');
    }

    expect(setMessages).toHaveBeenCalled();
  });

  it('maps "success" outcome to status "success"', () => {
    // Purpose: A hook that completes cleanly must set status: 'success' so the
    // UI can display a green/complete indicator.
    const { handler, currentPartsRef } = createDeps();

    addToolCallPart(currentPartsRef, 'tc-5');
    handler(
      'hook_started',
      { hookId: 'h-7', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-5' },
      'asst-1'
    );
    handler(
      'hook_response',
      {
        hookId: 'h-7',
        hookName: 'pre-tool',
        outcome: 'success',
        exitCode: 0,
        stdout: 'All checks passed',
        stderr: '',
      },
      'asst-1'
    );

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-5'
    );
    if (tcPart?.type === 'tool_call') {
      const hook = tcPart.hooks?.find((h) => h.hookId === 'h-7');
      expect(hook!.status).toBe('success');
      expect(hook!.stdout).toBe('All checks passed');
    }
  });

  it('maps "cancelled" outcome to status "cancelled"', () => {
    // Purpose: Hooks cancelled by the SDK (e.g., timeout or user abort) should be
    // visually distinguishable from errors in the UI.
    const { handler, currentPartsRef } = createDeps();

    addToolCallPart(currentPartsRef, 'tc-6');
    handler(
      'hook_started',
      { hookId: 'h-8', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-6' },
      'asst-1'
    );
    handler(
      'hook_response',
      {
        hookId: 'h-8',
        hookName: 'pre-tool',
        outcome: 'cancelled',
        stdout: '',
        stderr: '',
      },
      'asst-1'
    );

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-6'
    );
    if (tcPart?.type === 'tool_call') {
      const hook = tcPart.hooks?.find((h) => h.hookId === 'h-8');
      expect(hook!.status).toBe('cancelled');
    }
  });
});

describe('stream-event-handler — orphan hook drain on tool_call_start', () => {
  it('attaches buffered hooks when the matching tool_call_start arrives', () => {
    // Purpose: Verifies the end-to-end orphan lifecycle: hooks buffered before
    // tool_call_start are drained into the new part's hooks array on arrival.
    const { handler, currentPartsRef, orphanHooksRef } = createDeps();

    // Hook arrives before the tool call
    handler(
      'hook_started',
      { hookId: 'h-9', hookName: 'pre-tool', hookEvent: 'PreToolUse', toolCallId: 'tc-late' },
      'asst-1'
    );

    // Confirm it's buffered, not on any tool call part
    expect(orphanHooksRef.current.has('tc-late')).toBe(true);
    expect(currentPartsRef.current).toHaveLength(0);

    // Now the tool call starts
    handler('tool_call_start', { toolCallId: 'tc-late', toolName: 'Bash', input: '' }, 'asst-1');

    // Tool call part exists with the hook already attached
    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-late'
    );
    expect(tcPart).toBeDefined();
    if (tcPart?.type === 'tool_call') {
      expect(tcPart.hooks).toHaveLength(1);
      expect(tcPart.hooks![0].hookId).toBe('h-9');
    }

    // The Map entry must be removed after draining to prevent memory leaks
    expect(orphanHooksRef.current.has('tc-late')).toBe(false);
  });

  it('drains all orphan hooks for the same toolCallId', () => {
    // Purpose: Multiple hooks buffered for one tool call must all be drained
    // at once — none should remain orphaned after tool_call_start.
    const { handler, currentPartsRef, orphanHooksRef } = createDeps();

    handler(
      'hook_started',
      { hookId: 'h-10', hookName: 'hook-x', hookEvent: 'PreToolUse', toolCallId: 'tc-multi2' },
      'asst-1'
    );
    handler(
      'hook_started',
      { hookId: 'h-11', hookName: 'hook-y', hookEvent: 'PreToolUse', toolCallId: 'tc-multi2' },
      'asst-1'
    );

    handler('tool_call_start', { toolCallId: 'tc-multi2', toolName: 'Bash', input: '' }, 'asst-1');

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-multi2'
    );
    if (tcPart?.type === 'tool_call') {
      expect(tcPart.hooks).toHaveLength(2);
      expect(tcPart.hooks![0].hookId).toBe('h-10');
      expect(tcPart.hooks![1].hookId).toBe('h-11');
    }

    expect(orphanHooksRef.current.has('tc-multi2')).toBe(false);
  });

  it('creates a tool call part with no hooks when there are no orphans', () => {
    // Purpose: tool_call_start must work normally even when there are no buffered
    // hooks — the hooks field should be absent rather than an empty array.
    const { handler, currentPartsRef } = createDeps();

    handler('tool_call_start', { toolCallId: 'tc-clean', toolName: 'Read', input: '' }, 'asst-1');

    const tcPart = currentPartsRef.current.find(
      (p) => p.type === 'tool_call' && p.toolCallId === 'tc-clean'
    );
    expect(tcPart).toBeDefined();
    if (tcPart?.type === 'tool_call') {
      // hooks should be absent — not an empty array — to keep serialization clean
      expect(tcPart.hooks).toBeUndefined();
    }
  });
});
