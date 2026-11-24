/**
 * sdk-event-mapper: system messages. Shared setup lives in `./sdk-event-mapper.fixtures.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import { logger } from '../../../../../lib/logger.js';
import type {
  ErrorEvent,
  HookStartedEvent,
  HookResponseEvent,
  PermissionDeniedEvent,
} from '@dorkos/shared/types';
import {
  collectEvents,
  makeSession,
  makeToolState,
  sdkHookStarted,
  sdkHookResponse,
} from './sdk-event-mapper.fixtures.js';

describe('sdk-event-mapper hook lifecycle events', () => {
  const session = makeSession();
  const sessionId = 'test-session';

  it('hook_started (tool-contextual) yields hook_started event', async () => {
    const toolState = makeToolState();
    toolState.currentToolId = 'tool-123';
    const msg = sdkHookStarted('hook-1', 'pre-commit', 'PreToolUse');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hook_started');
    const data = events[0].data as HookStartedEvent;
    expect(data).toEqual({
      hookId: 'hook-1',
      hookName: 'pre-commit',
      hookEvent: 'PreToolUse',
      toolCallId: 'tool-123',
    });
  });

  it('hook_response (tool-contextual, success) yields hook_response', async () => {
    const toolState = makeToolState();
    const msg = sdkHookResponse(
      'hook-1',
      'pre-commit',
      'PostToolUse',
      'success',
      0,
      'all good',
      ''
    );
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('hook_response');
    const data = events[0].data as HookResponseEvent;
    expect(data).toEqual({
      hookId: 'hook-1',
      hookName: 'pre-commit',
      exitCode: 0,
      outcome: 'success',
      stdout: 'all good',
      stderr: '',
    });
  });

  it('hook_response (session-level, error) yields error event', async () => {
    const toolState = makeToolState();
    const msg = sdkHookResponse(
      'hook-3',
      'env-check',
      'SessionStart',
      'error',
      1,
      '',
      'missing env var'
    );
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    const data = events[0].data as ErrorEvent;
    expect(data.code).toBe('hook_failure');
    expect(data.category).toBe('execution_error');
    expect(data.message).toBe('Hook "env-check" failed (SessionStart)');
    expect(data.details).toBe('missing env var');
  });
});

describe('system.memory_recall events (SDK 0.2.105+)', () => {
  const sessionId = 'test-session';

  // Purpose: system/memory_recall forwards to a memory_recall StreamEvent with mode + memories
  it('emits memory_recall event and aggregates paths onto the session', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'system',
      subtype: 'memory_recall',
      mode: 'select',
      memories: [
        { path: '/foo/bar.md', scope: 'personal' },
        { path: '/baz.md', scope: 'team' },
      ],
      session_id: sessionId,
      uuid: 'uuid-1',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('memory_recall');
    expect(events[0].data).toMatchObject({
      mode: 'select',
      memories: [
        { path: '/foo/bar.md', scope: 'personal' },
        { path: '/baz.md', scope: 'team' },
      ],
    });
    expect(session.memoryPaths).toEqual(['/foo/bar.md', '/baz.md']);
  });
});

describe('system.status with status field (SDK 0.2.108+)', () => {
  const sessionId = 'test-session';

  // Purpose: requesting status with no body yields system_status with a synthesized message + raw status
  it('emits system_status with status and synthetic message when only status is set', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'system',
      subtype: 'status',
      status: 'requesting',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    const data = events[0].data as { message: string; status?: string };
    expect(data.status).toBe('requesting');
    expect(data.message).toMatch(/requesting/i);
  });
});

describe('sdk-event-mapper refusal (SDK 0.3.162)', () => {
  const sessionId = 'test-session';

  // Purpose: a model refusal surfaces as a visible system_status, not a silent empty turn
  it('maps stop_reason "refusal" to a system_status with the detail hint', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_details: { message: 'unsafe content' } },
      },
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect((events[0].data as { message: string }).message).toBe(
      'The model declined to respond: unsafe content'
    );
  });
});

describe('sdk-event-mapper assistant error (SDK 0.3.144)', () => {
  const sessionId = 'test-session';

  // Purpose: an unavailable model surfaces a clear, actionable error instead of a generic failure
  it('maps assistant error "model_not_found" to an error event', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'assistant',
      error: 'model_not_found',
      message: { content: [] },
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    const data = events[0].data as ErrorEvent;
    expect(data.code).toBe('model_not_found');
    expect(data.category).toBe('execution_error');
    expect(data.message).toMatch(/model is unavailable/i);
  });

  // Purpose: a hard usage limit used to be dropped here, so the session just
  // stopped. It now surfaces, in the CLI's words and uncategorised (no Retry on
  // a limit that holds until its reset), with the session's limit beside it
  // (spec claude-account-fleet D4).
  it('surfaces a rate_limit error in the CLI’s words, uncategorised, with the session limit', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const notice = "You've hit your weekly limit · resets Sep 28 at 8pm";
    const msg = {
      type: 'assistant',
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: notice }] },
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events.map((e) => e.type)).toEqual(['error', 'session_status']);
    expect(events[0]!.data).toEqual({ message: notice, code: 'rate_limit' });
    expect((events[1]!.data as { limit?: { window: string } }).limit?.window).toBe('unknown');
  });
});

describe('sdk-event-mapper permission_denied messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps an auto-mode classifier denial to a permission_denied event', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const msg = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_denied_1',
      decision_reason_type: 'classifier',
      decision_reason: 'Command flagged as potentially destructive',
      message: 'This command was blocked by the auto-mode safety classifier.',
      uuid: '00000000-0000-4000-8000-0000000000aa',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission_denied');
    expect(events[0].data as PermissionDeniedEvent).toEqual({
      toolCallId: 'toolu_denied_1',
      toolName: 'Bash',
      reasonType: 'classifier',
      reason: 'Command flagged as potentially destructive',
      message: 'This command was blocked by the auto-mode safety classifier.',
    });

    // It must NOT fall through to the catch-all unknown-subtype log.
    expect(debugSpy).not.toHaveBeenCalled();
  });

  // Purpose: the case DOR-795 was filed for — a BACKGROUNDED subagent's tool call
  // is auto-denied by the CLI (it never reaches canUseTool), and the chip can
  // only say WHICH child lost WHAT if agent_id survives the mapper.
  it('carries agent_id and asyncAgent through a backgrounded subagent auto-denial', async () => {
    const msg = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_async_1',
      agent_id: 'agent_child_7',
      decision_reason_type: 'asyncAgent',
      decision_reason: 'Async agent tool calls are auto-denied.',
      message: 'Backgrounded agents cannot request permission.',
      uuid: '00000000-0000-4000-8000-0000000000ac',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission_denied');
    expect(events[0].data as PermissionDeniedEvent).toEqual({
      toolCallId: 'toolu_async_1',
      toolName: 'Bash',
      reasonType: 'asyncAgent',
      reason: 'Async agent tool calls are auto-denied.',
      message: 'Backgrounded agents cannot request permission.',
      agentId: 'agent_child_7',
    });
  });
});
