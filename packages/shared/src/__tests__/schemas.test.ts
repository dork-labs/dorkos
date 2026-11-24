import { describe, it, expect } from 'vitest';
import {
  CompactBoundaryPartSchema,
  OperationProgressEventSchema,
  SessionSchema,
  SessionSettingsSchema,
  UsageStatusSchema,
  UiActionRequestSchema,
  UpdateTaskRequestSchema,
  UpdateSessionRequestSchema,
  UI_ACTION_ID_MAX_LENGTH,
  UI_ACTION_PAYLOAD_MAX_LENGTH,
} from '../schemas.js';

describe('task permission requests', () => {
  it.each([
    '',
    '   ',
    'Bash',
    'Bash(*)',
    'Bash( * )',
    'Bash(**)',
    'Bash(:*)',
    'Bash(* *)',
    'Bash()',
    'Read(/**)',
    'Edit(//**)',
    'WebFetch(domain:*)',
    'WebFetch',
    'mcp__dorkos__*',
    'mcp__dorkos__*(x)',
    'Bash(ls)\nBash(*)',
    // Security Should D-2: the home folder, any wildcard domain, interpreters.
    'Read(~/**)',
    'Edit(~/**)',
    'Read(~)',
    'Read($HOME/**)',
    'Edit(${HOME}/**)',
    'WebFetch(domain:*.com)',
    'WebFetch(domain:*.example.com)',
    'Bash(python3:*)',
    'Bash(node:*)',
    'Bash(sh -c:*)',
    'Bash(bash -c:*)',
    'Bash(bash -c *)',
    'Bash(python3 *)',
    'Bash(env:*)',
    'Bash(env *)',
    'Bash(xargs:*)',
    'Bash(perl:*)',
    'Bash(perl -e *)',
    'Bash(ruby:*)',
    'Bash(ruby -e *)',
    'Bash(npx:*)',
  ])('refuses unsafe requested rules: %j', (rule) => {
    expect(UpdateTaskRequestSchema.safeParse({ requestedAllow: [rule] }).success).toBe(false);
  });

  it('caps requested rules at twenty and three hundred characters each', () => {
    expect(
      UpdateTaskRequestSchema.safeParse({
        requestedAllow: Array.from({ length: 21 }, (_, i) => `Read(/abs/notes/${i}.md)`),
      }).success
    ).toBe(false);
    expect(
      UpdateTaskRequestSchema.safeParse({ requestedAllow: [`Read(${'.'.repeat(301)})`] }).success
    ).toBe(false);
  });
});

describe('SessionSchema', () => {
  const baseSession = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Test Session',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
  };

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
});

describe('OperationProgressEventSchema invariants (DOR-110)', () => {
  const base = { operation: 'compaction' as const };

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

describe('UsageStatusSchema', () => {
  it('rejects a negative utilization', () => {
    const result = UsageStatusSchema.safeParse({ kind: 'subscription', utilization: -0.1 });
    expect(result.success).toBe(false);
  });
});

describe('UiActionRequestSchema — prompt-bound field caps', () => {
  it('rejects an over-long actionId', () => {
    const result = UiActionRequestSchema.safeParse({
      actionId: 'a'.repeat(UI_ACTION_ID_MAX_LENGTH + 1),
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
});

describe('host recording admission schema', () => {
  it('bounds and distinguishes reserved/started outcomes without a page-message tag', async () => {
    const { DevtoolsIngestSchema } = await import('../schemas.js');
    const envelope = {
      hostOutcome: 'host',
      documentId: 'doc',
      bridgeGeneration: 'gen',
      seq: 0,
      console: [],
      network: [],
      recordingStart: { requestId: 'request', recordingId: 'film', phase: 'reserved', ok: true },
    };
    expect(DevtoolsIngestSchema.safeParse(envelope).success).toBe(true);
    for (const patch of [
      { phase: 'unknown' },
      { requestId: '' },
      { recordingId: 'x'.repeat(129) },
      { error: 'x'.repeat(2049) },
      { __dorkosDevtools: 'recordingStart' },
    ]) {
      expect(
        DevtoolsIngestSchema.safeParse({
          ...envelope,
          recordingStart: { ...envelope.recordingStart, ...patch },
        }).success
      ).toBe(false);
    }
  });
});
