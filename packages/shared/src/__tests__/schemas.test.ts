import { describe, it, expect } from 'vitest';
import {
  ApprovalEventSchema,
  CompactBoundaryPartSchema,
  CompactMetadataSchema,
  MemoryRecallPartSchema,
  MessagePartSchema,
  OperationProgressEventSchema,
  PendingInteractionDTOSchema,
  SessionSchema,
  SessionSettingsSchema,
  SessionStatusEventSchema,
  UsageStatusSchema,
  UiActionRequestSchema,
  UpdateSessionRequestSchema,
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

  it('accepts a permission-mode id outside the shared enum (DOR-851)', () => {
    // Purpose: `permissionMode` here is the id the session's OWN runtime
    // reports, not a member of the narrower `PermissionModeSchema` — the
    // request side already accepted this (DOR-811), and the read side must
    // too or a runtime's own reported state is unparseable. `always-allow` is
    // the real default `test-mode` declares (`TEST_MODE_CAPABILITIES` in
    // `apps/server/src/services/runtimes/test-mode/runtime-constants.ts`),
    // named here rather than an arbitrary string so this test fails the moment
    // that runtime's actual shipped id stops parsing — the exact defect that
    // silently emptied the session list before this fix (DOR-851).
    const testModeSession = {
      ...baseSession,
      runtime: 'test-mode',
      permissionMode: 'always-allow',
    };
    const result = SessionSchema.parse(testModeSession);
    expect(result.permissionMode).toBe('always-allow');
  });
});

describe('SessionSettingsSchema', () => {
  it('parses a permission-mode id outside the shared enum (DOR-885)', () => {
    // Purpose: this schema describes what a PATCH asks for, what
    // `session_metadata.permission_mode` holds, and what a runtime is handed
    // back — all three of which carry the id the owning runtime declared, not a
    // member of `PermissionModeSchema`. `always-allow` is the real default
    // `test-mode` declares (`TEST_MODE_CAPABILITIES` in
    // `apps/server/src/services/runtimes/test-mode/runtime-constants.ts`), so a
    // row for one of its sessions already holds a value this schema rejected.
    // Named rather than invented, so the test fails the moment that runtime's
    // actual shipped id stops parsing.
    const result = SessionSettingsSchema.parse({ permissionMode: 'always-allow' });
    expect(result.permissionMode).toBe('always-allow');
  });

  it('still refuses a mode id no runtime could declare', () => {
    // The shape bound survives the widening: what stopped being the authority
    // is the LIST of names, not the check that an id is a well-formed one. The
    // owning runtime refuses ids it does not declare (`PATCH /api/sessions/:id`);
    // this keeps a value no runtime could ever name out of a persisted row.
    expect(SessionSettingsSchema.safeParse({ permissionMode: 'not a mode' }).success).toBe(false);
    expect(SessionSettingsSchema.safeParse({ permissionMode: '' }).success).toBe(false);
  });

  it('is the whole shape UpdateSessionRequestSchema widens nothing back out of', () => {
    // The request schema used to re-declare `permissionMode` purely to widen the
    // narrow parent (DOR-885). With the parent already wide the override is
    // gone, and this pins that removing it changed nothing about what a request
    // may carry.
    const result = UpdateSessionRequestSchema.parse({
      permissionMode: 'always-allow',
      title: 'A renamed session',
    });
    expect(result.permissionMode).toBe('always-allow');
    expect(UpdateSessionRequestSchema.safeParse({ permissionMode: 'not a mode' }).success).toBe(
      false
    );
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

describe('OperationProgressEventSchema invariants (DOR-110)', () => {
  const base = { operation: 'compaction' as const };

  // --- Valid shapes ---
  it('accepts an indeterminate started phase with no percent', () => {
    const result = OperationProgressEventSchema.safeParse({
      ...base,
      state: 'started',
      determinate: false,
      message: 'Compacting context…',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a determinate phase carrying a percent', () => {
    const result = OperationProgressEventSchema.safeParse({
      ...base,
      state: 'started',
      determinate: true,
      percent: 65,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a failed phase carrying an error', () => {
    const result = OperationProgressEventSchema.safeParse({
      ...base,
      state: 'failed',
      determinate: false,
      error: 'context too large to summarize',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a done phase with no error', () => {
    const result = OperationProgressEventSchema.safeParse({
      ...base,
      state: 'done',
      determinate: false,
    });
    expect(result.success).toBe(true);
  });

  // --- Enforced invariants (the docstring is now the contract) ---
  it('rejects percent on an indeterminate phase', () => {
    const result = OperationProgressEventSchema.safeParse({
      ...base,
      state: 'started',
      determinate: false,
      percent: 50,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['percent']);
    }
  });

  it('rejects a determinate phase with no percent', () => {
    const result = OperationProgressEventSchema.safeParse({
      ...base,
      state: 'started',
      determinate: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['percent']);
    }
  });

  it('rejects error on a non-failed phase', () => {
    const result = OperationProgressEventSchema.safeParse({
      ...base,
      state: 'done',
      determinate: false,
      error: 'should not be here',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['error']);
    }
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
