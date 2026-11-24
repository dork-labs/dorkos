import { describe, it, expect } from 'vitest';
import {
  SessionStatusSchema,
  SessionEventSchema,
  SessionSnapshotSchema,
  SessionListEventSchema,
  BLOCKING_INTERACTION_EVENT_TYPES,
  isBlockingInteractionEventType,
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
  limit: null,
  accountUsage: null,
};

describe('SessionStatusSchema', () => {
  it('defaults lastError to null when omitted (version skew)', () => {
    // Purpose: snapshots serialized before lastError existed must keep parsing.
    const { lastError: _omitted, ...withoutError } = coldStatus;
    expect(SessionStatusSchema.parse(withoutError).lastError).toBeNull();
  });

  it('a status_change cannot carry accountUsage: it travels only on account_usage', () => {
    const parsed = SessionEventSchema.parse({
      type: 'status_change',
      seq: 1,
      status: { model: 'm', accountUsage: { runtime: 'codex' } },
    });
    expect(parsed.type === 'status_change' && 'accountUsage' in parsed.status).toBe(false);
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

  it('rejects a negative seq', () => {
    // Purpose: seq is the monotonic cursor — it can never go below zero.
    expect(() => SessionEventSchema.parse({ seq: -1, type: 'text_delta', text: 'x' })).toThrow();
  });
});

describe('SessionEventSchema — queue_update', () => {
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
});

describe("SessionEventSchema's canvas member", () => {
  it('REQUIRES a seq — the inverse of the room frame, which deliberately has none', () => {
    // The pair of these two assertions is what keeps the two streams' rules from
    // being copied into each other. A session event without a seq cannot be
    // replayed from the ring, so a reader that missed one would never learn it.
    expect(
      SessionEventSchema.safeParse({ type: 'canvas', documentId: 'doc-1', closed: true }).success
    ).toBe(false);
  });
});

describe('SessionSnapshotSchema', () => {
  it('hydrates a history whose question omits multiSelect and header (DOR-2075)', () => {
    // Purpose: a transcript records the model's raw AskUserQuestion input, and
    // the model does not always send every field. One such question used to
    // fail the WHOLE snapshot, so the session never loaded at all.
    const snapshot = {
      messages: [
        {
          id: 'a-1',
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            {
              toolCallId: 'toolu_q_1',
              toolName: 'AskUserQuestion',
              status: 'complete' as const,
              questions: [
                {
                  question: 'Which library should we use?',
                  options: [{ label: 'date-fns' }, { label: 'luxon' }],
                },
              ],
            },
          ],
        },
      ],
      inProgressTurn: null,
      status: coldStatus,
      pendingInteractions: [],
      queuedMessages: [],
      canvas: [],
      cursor: 0,
    };
    const parsed = SessionSnapshotSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    const question = parsed.data?.messages[0]?.toolCalls?.[0]?.questions?.[0];
    expect(question?.multiSelect).toBe(false);
    expect(question?.header).toBe('');
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
      canvas: [],
      cursor: 0,
    };
    expect(() => SessionSnapshotSchema.parse(withoutQueue)).toThrow();
  });
});

describe('SessionListEventSchema', () => {
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

it('preserves bounded relative recording reservations and both confirmation controls on the wire', () => {
  const event = {
    seq: 1,
    type: 'devtools_recording_request',
    requestId: 'request',
    targetClientId: 'host',
    documentId: 'doc',
    bridgeGeneration: 'gen',
    recordingId: 'film',
    action: 'start',
    reservationTimeoutMs: 8000,
    bounds: { longEdgePx: 800, frameMs: 500, maxBytes: 8 * 1024 * 1024 },
  };
  for (const action of ['start', 'stop', 'confirm-start', 'cancel-start']) {
    expect(SessionEventSchema.parse({ ...event, action })).toEqual({ ...event, action });
  }
  expect(SessionEventSchema.safeParse({ ...event, reservationTimeoutMs: 8001 }).success).toBe(
    false
  );
  expect(SessionEventSchema.safeParse({ ...event, reservationTimeoutMs: -1 }).success).toBe(false);
  const {
    reservationTimeoutMs: _legacyAbsent,
    bridgeGeneration: _legacyGeneration,
    ...legacy
  } = event;
  expect(SessionEventSchema.parse(legacy)).toEqual(legacy);
});
