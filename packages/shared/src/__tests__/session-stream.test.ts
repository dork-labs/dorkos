import { describe, it, expect } from 'vitest';
import {
  SessionStatusSchema,
  SessionEventSchema,
  SessionSnapshotSchema,
  SessionListEventSchema,
} from '../session-stream.js';

const coldStatus = {
  contextUsage: null,
  cost: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default' as const,
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle' as const,
};

describe('SessionStatusSchema', () => {
  it('accepts a cold snapshot with all usage fields null', () => {
    // Purpose: a session with no completed turn must parse with null usage/cost.
    expect(SessionStatusSchema.parse(coldStatus)).toEqual(coldStatus);
  });

  it('defaults runningSubagentCount to 0 when omitted', () => {
    // Purpose: the count is a default, not a required field.
    const { runningSubagentCount: _omitted, ...withoutCount } = coldStatus;
    expect(SessionStatusSchema.parse(withoutCount).runningSubagentCount).toBe(0);
  });
});

describe('SessionEventSchema', () => {
  it('parses a valid text_delta event with a non-negative seq', () => {
    // Purpose: the simplest streamed member carries seq + reused TextDelta shape.
    const event = { seq: 0, type: 'text_delta', text: 'hello' };
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it('parses an approval_required event retaining startedAt + remainingMs', () => {
    // Purpose: interaction members must preserve the server-assigned countdown (ADR-0262).
    const event = {
      seq: 3,
      type: 'approval_required',
      startedAt: 1_700_000_000_000,
      remainingMs: 25_000,
      id: 'tc_1',
      toolName: 'Bash',
      input: 'ls',
      hasSuggestions: false,
    };
    const parsed = SessionEventSchema.parse(event);
    expect(parsed).toMatchObject({ startedAt: 1_700_000_000_000, remainingMs: 25_000 });
  });

  it('parses the compaction/local-command fidelity members (DOR-118)', () => {
    // Purpose: the three DOR-118 members reuse the StreamEvent shapes and ride
    // the seq stream like any other fidelity member.
    const boundary = {
      seq: 4,
      type: 'compact_boundary',
      trigger: 'auto',
      preTokens: 90_000,
      postTokens: 12_000,
    };
    expect(SessionEventSchema.parse(boundary)).toEqual(boundary);

    const output = { seq: 5, type: 'local_command_output', content: '/context output' };
    expect(SessionEventSchema.parse(output)).toEqual(output);

    const status = {
      seq: 6,
      type: 'system_status',
      message: 'Status: compacting',
      compactResult: 'failed',
      compactError: 'boom',
    };
    expect(SessionEventSchema.parse(status)).toEqual(status);
  });

  it('rejects a negative seq', () => {
    // Purpose: seq is the monotonic cursor — it can never go below zero.
    expect(() => SessionEventSchema.parse({ seq: -1, type: 'text_delta', text: 'x' })).toThrow();
  });

  it('rejects a non-integer seq', () => {
    // Purpose: seq is a discrete sequence number, not a fractional value.
    expect(() => SessionEventSchema.parse({ seq: 1.5, type: 'text_delta', text: 'x' })).toThrow();
  });

  it('rejects an unknown event type', () => {
    // Purpose: the discriminated union must reject members outside its closed set.
    expect(() => SessionEventSchema.parse({ seq: 0, type: 'not_a_real_event' })).toThrow();
  });

  it('parses a status_change whose contextUsage carries only outputTokens', () => {
    // Purpose: a streaming session_status delta carries only outputTokens, so the
    // status_change member's contextUsage must accept a PARTIAL usage object
    // (the projector merges it field-wise) — fabricating absent fields would
    // later zero them. The other token fields must NOT be filled with defaults.
    const event = { seq: 5, type: 'status_change', status: { contextUsage: { outputTokens: 20 } } };
    const parsed = SessionEventSchema.parse(event);
    expect(parsed).toMatchObject({ seq: 5, type: 'status_change' });
    const status = (parsed as { status: { contextUsage?: Record<string, number> } }).status;
    expect(status.contextUsage).toEqual({ outputTokens: 20 });
  });

  it('parses a status_change whose contextUsage omits outputTokens', () => {
    // Purpose: the final result session_status carries context/cache totals but
    // NO outputTokens — the partial usage must accept that subset and must not
    // fabricate outputTokens.
    const event = {
      seq: 6,
      type: 'status_change',
      status: { contextUsage: { totalTokens: 100, cacheReadTokens: 80 } },
    };
    const parsed = SessionEventSchema.parse(event);
    const status = (parsed as { status: { contextUsage?: Record<string, number> } }).status;
    expect(status.contextUsage).toEqual({ totalTokens: 100, cacheReadTokens: 80 });
  });
});

describe('SessionSnapshotSchema', () => {
  it('parses a valid cold snapshot', () => {
    // Purpose: a freshly hydrated, idle session must parse with an empty history.
    const snapshot = {
      messages: [],
      inProgressTurn: null,
      status: coldStatus,
      pendingInteractions: [],
      cursor: 0,
    };
    expect(SessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('accepts the highest seq as the cursor', () => {
    // Purpose: cursor is the max seq reflected; it must accept a large in-progress seq.
    const snapshot = {
      messages: [],
      inProgressTurn: [{ seq: 42, type: 'text_delta', text: 'mid-turn' }],
      status: coldStatus,
      pendingInteractions: [],
      cursor: 42,
    };
    expect(SessionSnapshotSchema.parse(snapshot).cursor).toBe(42);
  });

  it("resolves the snapshot status's contextUsage to the FULL (non-partial) shape", () => {
    // Purpose: while the status_change DELTA carries a partial contextUsage, the
    // snapshot's RESOLVED status must remain the complete object so consumers are
    // not surprised by missing token fields. A partial usage here must be rejected.
    const fullUsage = {
      totalTokens: 100,
      maxTokens: 200000,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheCreationTokens: 5,
    };
    const snapshot = {
      messages: [],
      inProgressTurn: null,
      status: { ...coldStatus, contextUsage: fullUsage },
      pendingInteractions: [],
      cursor: 0,
    };
    expect(SessionSnapshotSchema.parse(snapshot).status.contextUsage).toEqual(fullUsage);

    const partialUsageSnapshot = {
      ...snapshot,
      status: { ...coldStatus, contextUsage: { outputTokens: 20 } },
    };
    expect(() => SessionSnapshotSchema.parse(partialUsageSnapshot)).toThrow();
  });
});

describe('SessionListEventSchema', () => {
  it('parses a session_removed event', () => {
    // Purpose: the global stream removal member carries only the session id.
    const event = { type: 'session_removed', sessionId: 'abc' };
    expect(SessionListEventSchema.parse(event)).toEqual(event);
  });

  it('parses a session_status event carrying a full SessionStatus', () => {
    // Purpose: the status member feeds the fleet-wide status view with a projection.
    const event = { type: 'session_status', sessionId: 'abc', status: coldStatus };
    expect(SessionListEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an unknown list-event type', () => {
    // Purpose: the discriminated union must reject members outside its closed set.
    expect(() => SessionListEventSchema.parse({ type: 'session_unknown' })).toThrow();
  });
});
