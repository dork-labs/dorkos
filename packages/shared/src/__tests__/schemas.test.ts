import { describe, it, expect } from 'vitest';
import {
  ApprovalEventSchema,
  CompactBoundaryPartSchema,
  CompactMetadataSchema,
  MemoryRecallPartSchema,
  MessagePartSchema,
  PendingInteractionDTOSchema,
  SessionSchema,
  SessionStatusEventSchema,
  UsageStatusSchema,
  UiActionRequestSchema,
  UI_ACTION_ID_MAX_LENGTH,
  UI_ACTION_TITLE_MAX_LENGTH,
  UI_ACTION_PAYLOAD_MAX_LENGTH,
} from '../schemas.js';

describe('SessionSchema', () => {
  const baseSession = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Test Session',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
  };

  it('parses a session and preserves the runtime field', () => {
    const result = SessionSchema.parse(baseSession);
    expect(result.runtime).toBe('claude-code');
  });

  it('requires runtime — parse of a session without it throws', () => {
    const { runtime: _runtime, ...withoutRuntime } = baseSession;
    expect(() => SessionSchema.parse(withoutRuntime)).toThrow();
  });
});

describe('MemoryRecallPartSchema', () => {
  it('accepts a valid select-mode part', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/.claude/CLAUDE.md', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid synthesize-mode part with content', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'synthesize',
      memories: [{ path: '<synthesis:~/.claude>', scope: 'team', content: 'A summary…' }],
      isStreaming: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a part with an unknown mode', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'invalid',
      memories: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a memory row with an unknown scope', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'org' }],
    });
    expect(result.success).toBe(false);
  });

  it('treats content as optional on select rows', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });

  it('treats isStreaming as optional', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty memories array at the schema level (defense-in-depth tolerates it)', () => {
    const result = MemoryRecallPartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [],
    });
    expect(result.success).toBe(true);
  });

  it('integrates into MessagePartSchema discriminated union', () => {
    const result = MessagePartSchema.safeParse({
      type: 'memory_recall',
      mode: 'select',
      memories: [{ path: '~/foo', scope: 'personal' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('CompactBoundaryPartSchema (DOR-118)', () => {
  it('accepts a success row carrying the SDK compact_metadata', () => {
    const result = CompactBoundaryPartSchema.safeParse({
      type: 'compact_boundary',
      trigger: 'manual',
      preTokens: 52000,
      postTokens: 8000,
      durationMs: 1200,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a failed row carrying the error detail', () => {
    const result = CompactBoundaryPartSchema.safeParse({
      type: 'compact_boundary',
      failed: true,
      error: 'summarization failed',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a bare boundary (all metadata optional)', () => {
    expect(CompactBoundaryPartSchema.safeParse({ type: 'compact_boundary' }).success).toBe(true);
  });

  it('rejects an unknown trigger', () => {
    const result = CompactBoundaryPartSchema.safeParse({
      type: 'compact_boundary',
      trigger: 'scheduled',
    });
    expect(result.success).toBe(false);
  });

  it('integrates into MessagePartSchema discriminated union', () => {
    const result = MessagePartSchema.safeParse({ type: 'compact_boundary', trigger: 'auto' });
    expect(result.success).toBe(true);
  });
});

describe('CompactMetadataSchema (DOR-118)', () => {
  it('accepts full boundary metadata', () => {
    const result = CompactMetadataSchema.safeParse({
      trigger: 'manual',
      preTokens: 50115,
      durationMs: 35623,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object (all fields optional)', () => {
    expect(CompactMetadataSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an unknown trigger', () => {
    expect(CompactMetadataSchema.safeParse({ trigger: 'scheduled' }).success).toBe(false);
  });
});

describe('PendingInteractionDTOSchema', () => {
  it('accepts an approval interaction', () => {
    // Purpose: approval DTO valid.
    expect(() =>
      PendingInteractionDTOSchema.parse({
        type: 'approval',
        id: 'x',
        startedAt: 1,
        remainingMs: 2,
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: false,
      })
    ).not.toThrow();
  });

  it('accepts a question interaction', () => {
    // Purpose: all three branches valid (question branch).
    const result = PendingInteractionDTOSchema.safeParse({
      type: 'question',
      id: 'q1',
      startedAt: 10,
      remainingMs: 5000,
      questions: [
        {
          header: 'Pick one',
          question: 'Which option?',
          options: [{ label: 'A' }],
          multiSelect: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an elicitation interaction', () => {
    // Purpose: all three branches valid (elicitation branch).
    const result = PendingInteractionDTOSchema.safeParse({
      type: 'elicitation',
      id: 'e1',
      startedAt: 20,
      remainingMs: 8000,
      serverName: 'github',
      message: 'Authorize access',
      mode: 'url',
      url: 'https://example.com/auth',
      elicitationId: 'elic-1',
      requestedSchema: { kind: 'object' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an interaction with an unknown type', () => {
    // Purpose: discriminated union rejects out-of-set types.
    const result = PendingInteractionDTOSchema.safeParse({
      type: 'unknown',
      id: 'z',
      startedAt: 1,
      remainingMs: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('ApprovalEventSchema remainingMs', () => {
  const base = {
    toolCallId: 'tc1',
    toolName: 'Bash',
    input: '{}',
    timeoutMs: 30000,
    startedAt: 1,
    hasSuggestions: false,
  };

  it('parses with remainingMs present', () => {
    // Purpose: additive/optional, back-compatible (recovery re-emit case).
    const result = ApprovalEventSchema.safeParse({ ...base, remainingMs: 1234 });
    expect(result.success).toBe(true);
  });

  it('parses without remainingMs', () => {
    // Purpose: additive/optional, back-compatible (originating in-band emit case).
    const result = ApprovalEventSchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});

describe('UsageStatusSchema', () => {
  it('parses a subscription usage with utilization, window, and state', () => {
    const result = UsageStatusSchema.safeParse({
      kind: 'subscription',
      utilization: 0.47,
      windowLabel: '5-hour window',
      resetsAt: '2026-07-07T12:00:00.000Z',
      costUsd: 1.23,
      state: 'warning',
      detail: 'Using overage capacity',
    });
    expect(result.success).toBe(true);
  });

  it('parses a pay-as-you-go usage with only cost', () => {
    const result = UsageStatusSchema.safeParse({ kind: 'pay-as-you-go', costUsd: 0.42 });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    const result = UsageStatusSchema.safeParse({ kind: 'none', costUsd: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative utilization', () => {
    const result = UsageStatusSchema.safeParse({ kind: 'subscription', utilization: -0.1 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative cost', () => {
    const result = UsageStatusSchema.safeParse({ kind: 'pay-as-you-go', costUsd: -1 });
    expect(result.success).toBe(false);
  });
});

describe('SessionStatusEventSchema — usage carrier', () => {
  it('accepts a session_status carrying only usage', () => {
    const result = SessionStatusEventSchema.safeParse({
      sessionId: 's1',
      usage: { kind: 'subscription', utilization: 0.5, state: 'ok' },
    });
    expect(result.success).toBe(true);
  });

  it('parses a session_status with no usage (optional)', () => {
    const result = SessionStatusEventSchema.safeParse({ sessionId: 's1', costUsd: 0.1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.usage).toBeUndefined();
  });
});

describe('UiActionRequestSchema — prompt-bound field caps', () => {
  it('accepts a request at the field caps', () => {
    const result = UiActionRequestSchema.safeParse({
      actionId: 'a'.repeat(UI_ACTION_ID_MAX_LENGTH),
      widgetId: 'w'.repeat(UI_ACTION_ID_MAX_LENGTH),
      widgetTitle: 't'.repeat(UI_ACTION_TITLE_MAX_LENGTH),
      payload: { note: 'ok' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an over-long actionId', () => {
    const result = UiActionRequestSchema.safeParse({
      actionId: 'a'.repeat(UI_ACTION_ID_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-long widgetId', () => {
    const result = UiActionRequestSchema.safeParse({
      actionId: 'ok',
      widgetId: 'w'.repeat(UI_ACTION_ID_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-long widgetTitle', () => {
    const result = UiActionRequestSchema.safeParse({
      actionId: 'ok',
      widgetTitle: 't'.repeat(UI_ACTION_TITLE_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload whose serialized size exceeds the cap, naming the cap', () => {
    const result = UiActionRequestSchema.safeParse({
      actionId: 'ok',
      payload: { blob: 'x'.repeat(UI_ACTION_PAYLOAD_MAX_LENGTH) },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(String(UI_ACTION_PAYLOAD_MAX_LENGTH));
    }
  });

  it('accepts an absent payload', () => {
    expect(UiActionRequestSchema.safeParse({ actionId: 'ok' }).success).toBe(true);
  });
});
