import { describe, it, expect } from 'vitest';
import {
  SessionStatusSchema,
  SessionEventSchema,
  SessionSnapshotSchema,
  SessionListEventSchema,
  BLOCKING_INTERACTION_EVENT_TYPES,
  isBlockingInteractionEventType,
  isBlockingInteractionEvent,
  approvalOutcomeOf,
  questionOutcomeOf,
  type ToolApprovalOutcome,
  type QuestionOutcome,
  type SessionEvent,
} from '../session-stream.js';

const coldStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default' as const,
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle' as const,
  lastError: null,
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

  it('defaults lastError to null when omitted (version skew)', () => {
    // Purpose: snapshots serialized before lastError existed must keep parsing.
    const { lastError: _omitted, ...withoutError } = coldStatus;
    expect(SessionStatusSchema.parse(withoutError).lastError).toBeNull();
  });

  it('defaults usage to null when omitted (version skew)', () => {
    // Purpose: snapshots serialized before the usage field existed (a client on
    // an older server, or a replayed pre-usage snapshot) must keep parsing and
    // resolve to null usage rather than throwing.
    const { usage: _omitted, ...withoutUsage } = coldStatus;
    expect(SessionStatusSchema.parse(withoutUsage).usage).toBeNull();
  });

  it('accepts a populated subscription usage on the durable snapshot', () => {
    // Purpose: the status projection carries a whole UsageStatus through to the client.
    const withUsage = {
      ...coldStatus,
      usage: {
        kind: 'subscription' as const,
        utilization: 0.42,
        windowLabel: '5-hour',
        costUsd: 0.13,
        state: 'ok' as const,
      },
    };
    expect(SessionStatusSchema.parse(withUsage).usage).toEqual(withUsage.usage);
  });

  it('accepts a populated lastError carrying the failure details', () => {
    // Purpose: the status projection surfaces the most recent turn failure.
    const failed = {
      ...coldStatus,
      lifecycle: 'error' as const,
      lastError: { message: 'boom', code: 'turn_exception', category: 'execution_error' as const },
    };
    expect(SessionStatusSchema.parse(failed).lastError).toEqual(failed.lastError);
  });

  it('parses a status carrying what the session is doing right now', () => {
    // Purpose: the fleet-wide activity reading rides the status projection, so a
    // sidebar can say "Editing lane-state.ts" without opening the session.
    const working = {
      ...coldStatus,
      lifecycle: 'streaming' as const,
      activity: { toolName: 'Edit', target: 'lane-state.ts' },
    };
    expect(SessionStatusSchema.parse(working).activity).toEqual(working.activity);
  });

  it('parses a status whose activity carries only a tool name', () => {
    // Purpose: `target` is the one human-relevant argument and plenty of tools
    // have none. The wire must not require one to be invented.
    const working = { ...coldStatus, activity: { toolName: 'TodoWrite' } };
    expect(SessionStatusSchema.parse(working).activity).toEqual({ toolName: 'TodoWrite' });
  });

  it('parses a status with no activity at all (an older server, or an idle session)', () => {
    // Purpose: the field is additive. A `session_status` minted before it
    // existed must still parse, and absent must read as "nothing known" rather
    // than as a value.
    expect(SessionStatusSchema.parse(coldStatus).activity).toBeUndefined();
  });

  it('accepts a permission-mode id outside the shared enum (DOR-851)', () => {
    // Purpose: `permissionMode` here is the id the session's OWN runtime
    // reports. `always-allow` is the real default `test-mode` declares
    // (`TEST_MODE_CAPABILITIES` in
    // `apps/server/src/services/runtimes/test-mode/runtime-constants.ts`),
    // named here — not an arbitrary string — so this test fails the moment
    // that runtime's actual shipped id stops parsing. Before this fix, a
    // `status_change`/`session_status` carrying it failed
    // `SessionListEventSchema` and was silently dropped by
    // `SessionListBroadcaster`, emptying the live session list.
    const testModeStatus = { ...coldStatus, permissionMode: 'always-allow' as const };
    expect(SessionStatusSchema.parse(testModeStatus).permissionMode).toBe('always-allow');
  });
});

describe('SessionEventSchema', () => {
  it('parses a valid text_delta event with a non-negative seq', () => {
    // Purpose: the simplest streamed member carries seq + reused TextDelta shape.
    const event = { seq: 0, type: 'text_delta', text: 'hello' };
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it('parses an approval_required event retaining startedAt + remainingMs', () => {
    // Purpose: interaction members must preserve the server-assigned countdown (ADR-0264).
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

  it('drops an activity smuggled onto a status_change — the projector owns that field', () => {
    // Purpose: `status_change` carries a PARTIAL SessionStatus, so every field
    // added to the status becomes a field a runtime's delta could set. Every
    // other one is something a runtime reports about itself; `activity` is
    // derived by the projector from the tool calls it has actually seen. Left
    // in the partial, a runtime could name a tool the session never started and
    // it would fan out fleet-wide looking exactly like a real reading. The
    // member omits it, so the key cannot survive the parse.
    const smuggled = {
      seq: 7,
      type: 'status_change',
      status: { model: 'claude-opus-4-6', activity: { toolName: 'InjectedTool' } },
    };
    const parsed = SessionEventSchema.parse(smuggled) as Extract<
      SessionEvent,
      { type: 'status_change' }
    >;
    // The delta it legitimately carried survives; the one it may not, does not.
    // (`.partial()` still applies the defaulted keys, so this is a subset match
    // rather than an equality one.)
    expect(parsed.status).toMatchObject({ model: 'claude-opus-4-6' });
    expect('activity' in parsed.status).toBe(false);
  });

  it('parses the compaction fidelity members (DOR-110)', () => {
    // Purpose: the compaction members reuse the StreamEvent shapes and ride the
    // seq stream like any other fidelity member — the durable `compact_boundary`
    // row and the runtime-agnostic `operation_progress` lifecycle.
    const boundary = {
      seq: 4,
      type: 'compact_boundary',
      trigger: 'auto',
      preTokens: 90_000,
      postTokens: 12_000,
    };
    expect(SessionEventSchema.parse(boundary)).toEqual(boundary);

    const progress = {
      seq: 6,
      type: 'operation_progress',
      operation: 'compaction',
      state: 'failed',
      determinate: false,
      error: 'boom',
    };
    expect(SessionEventSchema.parse(progress)).toEqual(progress);
  });

  it('parses an error event with optional code/category/details', () => {
    // Purpose: the typed turn-error member carries the ErrorEvent shape whole.
    const event = {
      seq: 7,
      type: 'error',
      message: 'SDK exploded',
      code: 'turn_exception',
      category: 'execution_error',
      details: 'stack…',
    };
    expect(SessionEventSchema.parse(event)).toEqual(event);

    const lean = { seq: 8, type: 'error', message: 'boom' };
    expect(SessionEventSchema.parse(lean)).toEqual(lean);
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

describe('SessionEventSchema — queue_update', () => {
  const queued = {
    id: 'msg-1',
    content: 'and check the migration too',
    disposition: 'queue' as const,
    enqueuedAt: 1_700_000_000_000,
    enqueuedBy: 'client-a',
  };

  it('carries the whole queue and, when a message caused it, the delivery outcome', () => {
    // Purpose: the frame the cockpit reads to say "queued instead of steered".
    // Both halves have to survive the wire — a queue with no outcome cannot
    // explain a downgrade, and an outcome with no queue cannot draw the list.
    const event = {
      type: 'queue_update',
      seq: 9,
      queue: [queued],
      outcome: {
        messageId: 'msg-1',
        requested: 'steer',
        applied: 'queue',
        degradedBecause: 'unsupported',
      },
    };
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it('accepts an empty queue with no outcome (a dispatch drained the last message)', () => {
    // Purpose: `outcome` is optional because most updates are not caused by an
    // accepted message. An emptied queue is the ordinary end of every session.
    const event = { type: 'queue_update', seq: 10, queue: [] };
    expect(SessionEventSchema.parse(event)).toEqual(event);
  });

  it('rejects a frame with no queue — full replacement, never a diff', () => {
    // Purpose: the whole point of this member is that every frame REPLACES the
    // queue. An omitted `queue` would read as "no change" to a permissive
    // parser and as "empty" to a strict one, and those are opposite meanings.
    expect(() =>
      SessionEventSchema.parse({
        type: 'queue_update',
        seq: 11,
        outcome: { messageId: 'msg-1', requested: 'queue', applied: 'queue' },
      })
    ).toThrow();
  });

  it('rejects a disposition the contract does not name', () => {
    // Purpose: `stringly-typed` dispositions are how a typo becomes a silent
    // "run it now". Only the three the ladder resolves are accepted.
    expect(() =>
      SessionEventSchema.parse({
        type: 'queue_update',
        seq: 12,
        queue: [{ ...queued, disposition: 'interrupt' }],
      })
    ).toThrow();
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
      queuedMessages: [],
      cursor: 0,
    };
    expect(SessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('requires queuedMessages — hydration must say what is waiting', () => {
    // Purpose: a snapshot is a reconnecting window's WHOLE picture of the
    // session. If the queue were optional, a producer that forgot it would be
    // indistinguishable from a session with nothing queued, and the messages a
    // person typed would stay invisible until something else changed them.
    const withoutQueue = {
      messages: [],
      inProgressTurn: null,
      status: coldStatus,
      pendingInteractions: [],
      cursor: 0,
    };
    expect(() => SessionSnapshotSchema.parse(withoutQueue)).toThrow();
  });

  it('accepts the highest seq as the cursor', () => {
    // Purpose: cursor is the max seq reflected; it must accept a large in-progress seq.
    const snapshot = {
      messages: [],
      inProgressTurn: [{ seq: 42, type: 'text_delta', text: 'mid-turn' }],
      status: coldStatus,
      pendingInteractions: [],
      queuedMessages: [],
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
      queuedMessages: [],
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

  it('parses a session_status event for a runtime-declared mode outside the shared enum (DOR-851)', () => {
    // Purpose: pins the exact failure mode DOR-851 fixed. Before the fix,
    // `SessionListBroadcaster.broadcast()` fed every `test-mode` session's
    // `session_status`/`session_upserted` event through this schema, its
    // `status.permissionMode`/`session.permissionMode` failed against the
    // narrower `PermissionModeSchema`, and the event was silently dropped —
    // so the sidebar's live session list never showed that session.
    // `always-allow` is `test-mode`'s real declared default
    // (`TEST_MODE_CAPABILITIES` in
    // `apps/server/src/services/runtimes/test-mode/runtime-constants.ts`),
    // not an arbitrary string, so this regresses the moment that id changes.
    const event = {
      type: 'session_status',
      sessionId: 'abc',
      status: { ...coldStatus, permissionMode: 'always-allow' },
    };
    expect(SessionListEventSchema.parse(event)).toEqual(event);
  });

  it('parses a session_upserted event for a runtime-declared mode outside the shared enum (DOR-851)', () => {
    // Purpose: same regression as above, on the `session_upserted` member —
    // this is the one that carries the full `Session` (`SessionSchema`), so
    // it is the one the sidebar's initial row and every later refresh rely on.
    const event = {
      type: 'session_upserted',
      session: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        title: 'Test session',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        permissionMode: 'always-allow',
        runtime: 'test-mode',
      },
    };
    expect(SessionListEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an unknown list-event type', () => {
    // Purpose: the discriminated union must reject members outside its closed set.
    expect(() => SessionListEventSchema.parse({ type: 'session_unknown' })).toThrow();
  });
});

describe('blocking interaction predicates', () => {
  // Purpose: these two are the shared answer to "is the agent working, or is it
  // waiting on me?" — the session projector, the Telegram typing loop and the
  // Slack working indicator all read them, and a wrong answer shows a person a
  // working signal for a turn that is stalled on a question they never saw.
  it('answers true for exactly the three blocking interactions', () => {
    for (const type of BLOCKING_INTERACTION_EVENT_TYPES) {
      expect(isBlockingInteractionEventType(type)).toBe(true);
    }
    expect(BLOCKING_INTERACTION_EVENT_TYPES).toEqual([
      'approval_required',
      'question_prompt',
      'elicitation_prompt',
    ]);
  });

  it('answers false for the events of a turn that is running or done', () => {
    for (const type of ['turn_start', 'text_delta', 'tool_use', 'done', 'error', 'turn_end']) {
      expect(isBlockingInteractionEventType(type)).toBe(false);
    }
  });

  it('narrows an event by its own type, so callers reach the interaction fields', () => {
    const blocking = { type: 'question_prompt' as const, id: 'q-1' };
    const running = { type: 'text_delta' as const, id: 'd-1' };

    expect(isBlockingInteractionEvent(blocking)).toBe(true);
    expect(isBlockingInteractionEvent(running)).toBe(false);
    if (isBlockingInteractionEvent(blocking)) {
      // Compile-time half of the assertion: the narrowed union keeps `id`.
      expect(blocking.id).toBe('q-1');
    }
  });
});

/**
 * The full (kind × resolution) matrix for the one definition of what a resolved
 * interaction earns.
 *
 * Enumerated rather than sampled because the two rules are independent and each
 * has a history of being read out of the other. The KIND gate exists because a
 * timed-out question resolves `expired` exactly as a timed-out permission
 * prompt does — and AskUserQuestion is an ordinary tool_use block, so it lands
 * on a real tool call — which printed "Expired — denied" over questions nobody
 * was asked to approve. The RESOLUTION gate exists because `cancelled` means
 * the ask was withdrawn before anyone could answer it, and recording that as a
 * decision puts an answer in the transcript that no one gave.
 */
describe('approvalOutcomeOf', () => {
  const kinds = ['approval', 'question', 'elicitation', undefined] as const;
  const resolutions = [
    'approved',
    'denied',
    'answered',
    'expired',
    'cancelled',
    undefined,
  ] as const;

  /** Only these three (kind, resolution) pairs earn a permanent record. */
  const EARNED: Record<string, ToolApprovalOutcome> = {
    'approval/approved': 'allowed',
    'approval/denied': 'denied',
    'approval/expired': 'expired',
  };

  for (const kind of kinds) {
    for (const resolution of resolutions) {
      const key = `${String(kind)}/${String(resolution)}`;
      const expected = EARNED[key];
      it(`${key} → ${expected ?? 'no receipt'}`, () => {
        expect(approvalOutcomeOf({ kind, resolution })).toBe(expected);
      });
    }
  }
});

/**
 * The question-shaped twin, swept the same way and for the same reason.
 *
 * It differs from its twin in two places, and both are deliberate. It KEEPS
 * `cancelled`: a withdrawn approval leaves nothing behind because the tool it
 * gated says the rest, while a withdrawn question is already drawn in the
 * transcript, so leaving it unmarked is exactly what let it keep reading as
 * answered (DOR-1293). And it drops `approved`, which is not a thing that
 * happens to a question.
 */
describe('questionOutcomeOf', () => {
  const kinds = ['approval', 'question', 'elicitation', undefined] as const;
  const resolutions = [
    'approved',
    'denied',
    'answered',
    'expired',
    'cancelled',
    undefined,
  ] as const;

  const EARNED: Record<string, QuestionOutcome> = {
    'question/answered': 'answered',
    'question/denied': 'denied',
    'question/expired': 'expired',
    'question/cancelled': 'cancelled',
  };

  for (const kind of kinds) {
    for (const resolution of resolutions) {
      const key = `${String(kind)}/${String(resolution)}`;
      const expected = EARNED[key];
      it(`${key} → ${expected ?? 'nothing recorded'}`, () => {
        expect(questionOutcomeOf({ kind, resolution })).toBe(expected);
      });
    }
  }
});
