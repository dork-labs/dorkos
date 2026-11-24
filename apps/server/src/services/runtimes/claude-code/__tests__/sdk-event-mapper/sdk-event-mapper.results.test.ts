/**
 * sdk-event-mapper: results. Shared setup lives in `./sdk-event-mapper.fixtures.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import type { ErrorEvent, ApiRetryEvent, PromptSuggestionEvent } from '@dorkos/shared/types';
import { collectEvents, makeSession, makeToolState } from './sdk-event-mapper.fixtures.js';

describe('sdk-event-mapper context usage capture', () => {
  const sessionId = 'test-session';

  function assistantWithUsage(
    parentToolUseId: string | null,
    usage?: Record<string, number>,
    model?: string
  ): Parameters<typeof mapSdkMessage>[0] {
    return {
      type: 'assistant',
      parent_tool_use_id: parentToolUseId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        ...(usage ? { usage } : {}),
        ...(model ? { model } : {}),
      },
      session_id: 's',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
  }

  it('surfaces an authentication_failed assistant error as auth_error with a human message', async () => {
    const msg = {
      type: 'assistant',
      parent_tool_use_id: null,
      error: 'authentication_failed',
      message: { role: 'assistant', content: [] },
      session_id: 's',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, makeSession(), sessionId, makeToolState());

    const error = events.find((e) => e.type === 'error');
    const data = error?.data as ErrorEvent | undefined;
    expect(data?.category).toBe('auth_error');
    expect(data?.code).toBe('authentication_failed');
    // The EXACT sentence, not a keyword: it is the same one the result channel
    // now says for the same expiry, and only equality can catch the two drifting
    // apart again (DOR-1656).
    expect(data?.message).toBe(
      'Your Claude Code sign-in stopped working. Sign in again to keep going.'
    );
  });

  it('does not classify assistant content that merely discusses oauth tokens as an error', async () => {
    // The classifier is deliberately bounded to the error CHANNEL (the terminal
    // `error` field), never assistant content. This text would match the auth
    // regex if it were ever fed to detectAuthError, so a passing assertion here
    // proves ordinary content that talks about OAuth/access tokens stays clean.
    const msg = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'To fix this, refresh your oauth access token — the credential expired and 401 Unauthorized means it was revoked.',
          },
        ],
      },
      session_id: 's',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, makeSession(), sessionId, makeToolState());

    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('RT-COST-01: captures the last main-thread request usage from an assistant message', async () => {
    const session = makeSession();
    await collectEvents(
      assistantWithUsage(null, {
        input_tokens: 1355,
        cache_read_input_tokens: 65904,
        cache_creation_input_tokens: 23482,
      }),
      session,
      sessionId,
      makeToolState()
    );

    expect(session.lastRequestUsage).toEqual({
      inputTokens: 1355,
      cacheReadTokens: 65904,
      cacheCreationTokens: 23482,
    });
  });

  it('records the main-thread model, never a subagent one, to pick the right window', async () => {
    const session = makeSession();
    await collectEvents(
      assistantWithUsage(null, { input_tokens: 1 }, 'claude-opus-5-5'),
      session,
      sessionId,
      makeToolState()
    );
    await collectEvents(
      assistantWithUsage('toolu_parent_1', { input_tokens: 1 }, 'claude-haiku-4-5-20251001'),
      session,
      sessionId,
      makeToolState()
    );
    expect(session.lastRequestModel).toBe('claude-opus-5-5');
  });
});

describe('sdk-event-mapper result messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  // Context/cache figures come from the last main-thread request captured during
  // streaming (session.lastRequestUsage), not the result message's cumulative
  // modelUsage. Seed a simple default; individual tests override as needed.
  beforeEach(() => {
    session.lastRequestUsage = { inputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    session.contextBreakdown = undefined;
  });

  function makeResultMessage(
    subtype: string,
    errors?: string[]
  ): Parameters<typeof mapSdkMessage>[0] {
    return {
      type: 'result',
      subtype,
      model: 'claude-sonnet-4-20250514',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: { 'claude-sonnet-4-20250514': { contextWindow: 200000 } },
      ...(errors ? { errors } : {}),
    } as unknown as Parameters<typeof mapSdkMessage>[0];
  }

  it('success result yields session_status + context_usage + done (3 events)', async () => {
    const msg = makeResultMessage('success');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('session_status');
    expect(events[1].type).toBe('context_usage');
    expect(events[2].type).toBe('done');
    expect(events[2].data).toEqual({ sessionId: 'test-session' });
  });

  it('prefers the SDK context breakdown (with categories) when available', async () => {
    // message-sender stashes getContextUsage() on the session; when present it is
    // authoritative and carries the per-category breakdown for the tooltip.
    session.contextBreakdown = {
      totalTokens: 28471,
      maxTokens: 1000000,
      percentage: 3,
      model: 'claude-opus-4-8',
      categories: [{ name: 'Messages', tokens: 11247, color: '#4' }],
    };
    const msg = makeResultMessage('success');
    const events = await collectEvents(msg, session, sessionId, toolState);

    const usage = events.find((e) => e.type === 'context_usage')!.data as Record<string, unknown>;
    expect(usage.totalTokens).toBe(28471);
    expect(usage.maxTokens).toBe(1000000);
    expect(usage.categories).toEqual([{ name: 'Messages', tokens: 11247, color: '#4' }]);
  });

  it('error_max_turns yields session_status + context_usage + error + done (4 events)', async () => {
    const msg = makeResultMessage('error_max_turns', ['Reached 10 turn limit']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('session_status');
    expect(events[1].type).toBe('context_usage');
    expect(events[2].type).toBe('error');
    expect(events[3].type).toBe('done');

    const err = events[2].data as ErrorEvent;
    expect(err.category).toBe('max_turns');
    expect(err.message).toBe('Reached 10 turn limit');
    expect(err.code).toBe('error_max_turns');
  });

  it('reclassifies a revoked-OAuth result as auth_error and speaks DorkOS words', async () => {
    const vendorText =
      'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.';
    const msg = makeResultMessage('error_during_execution', [vendorText]);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[2].data as ErrorEvent;
    expect(err.category).toBe('auth_error');
    // The same sentence the assistant channel says for the same expiry
    // (DOR-1656) — the raw CLI line survives in `details`.
    expect(err.message).toBe(
      'Your Claude Code sign-in stopped working. Sign in again to keep going.'
    );
    expect(err.details).toBe(vendorText);
  });
});

describe('result message terminal_reason (SDK 0.2.91+)', () => {
  const sessionId = 'test-session';

  // Purpose: terminal_reason forwards to session_status when set on the SDK result
  it('includes terminalReason on session_status when terminal_reason is set', async () => {
    const session = makeSession();
    const toolState = makeToolState();
    const msg = {
      type: 'result',
      subtype: 'success',
      terminal_reason: 'max_turns',
      total_cost_usd: 0.01,
      usage: { input_tokens: 100 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200000 } },
      model: 'claude-opus-4-7',
    } as unknown as Parameters<typeof mapSdkMessage>[0];

    const events = await collectEvents(msg, session, sessionId, toolState);
    const sessionStatus = events.find((e) => e.type === 'session_status');
    expect(sessionStatus).toBeDefined();
    expect((sessionStatus?.data as Record<string, unknown>).terminalReason).toBe('max_turns');
  });
});

describe('sdk-event-mapper prompt suggestion messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  it('maps singular suggestion field to suggestions array', async () => {
    const msg = {
      type: 'prompt_suggestion',
      suggestion: 'What files were changed?',
      uuid: 'uuid-suggestion-1',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('prompt_suggestion');
    const data = events[0].data as PromptSuggestionEvent;
    expect(data.suggestions).toEqual(['What files were changed?']);
  });
});

describe('sdk-event-mapper api_retry messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  it('maps api_retry system subtype to api_retry event', async () => {
    const msg = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 3000,
      error_status: 429,
      error: { type: 'overloaded_error', message: 'Overloaded' },
      uuid: 'uuid-retry-1',
      session_id: 'test-session',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('api_retry');
    const data = events[0].data as ApiRetryEvent;
    expect(data).toEqual({
      attempt: 2,
      maxRetries: 5,
      retryDelayMs: 3000,
      errorStatus: 429,
    });
  });
});
