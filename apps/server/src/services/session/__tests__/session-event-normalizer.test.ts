import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RawSessionEvent } from '../index.js';
import { toRawSessionEvent, feedProjector } from '../session-event-normalizer.js';
import { SessionStateProjector, CAPABILITY_HOLD_PAUSE_GRACE_MS } from '../index.js';

describe('toRawSessionEvent — fidelity, interactions, errors and devtools', () => {
  const cases: Array<{ name: string; input: StreamEvent; expected: RawSessionEvent | null }> = [
    {
      name: 'memory_recall → memory_recall (entries pass through)',
      input: {
        type: 'memory_recall',
        data: { mode: 'select', memories: [{ path: '/m/a.md', scope: 'personal' }] },
      },
      expected: {
        type: 'memory_recall',
        mode: 'select',
        memories: [{ path: '/m/a.md', scope: 'personal' }],
      },
    },
    {
      name: 'compact_boundary → compact_boundary (camelCased metadata passes through, DOR-118)',
      input: {
        type: 'compact_boundary',
        data: { trigger: 'manual', preTokens: 52000, postTokens: 8000, durationMs: 1200 },
      },
      expected: {
        type: 'compact_boundary',
        trigger: 'manual',
        preTokens: 52000,
        postTokens: 8000,
        durationMs: 1200,
      },
    },
    {
      name: 'system_status → system_status (hook flash)',
      input: {
        type: 'system_status',
        data: { message: 'Running hook "format"…' },
      },
      expected: { type: 'system_status', message: 'Running hook "format"…' },
    },
    {
      name: 'operation_progress → operation_progress (compaction started, DOR-110)',
      input: {
        type: 'operation_progress',
        data: {
          operation: 'compaction',
          state: 'started',
          determinate: false,
          message: 'Compacting context…',
        },
      },
      expected: {
        type: 'operation_progress',
        operation: 'compaction',
        state: 'started',
        determinate: false,
        message: 'Compacting context…',
      },
    },
    {
      name: 'interaction_cancelled (aborted) → interaction_resolved with cancelled resolution (F5)',
      input: {
        type: 'interaction_cancelled',
        data: { interactionId: 'toolu_q1', reason: 'aborted' },
      },
      expected: {
        type: 'interaction_resolved',
        id: 'toolu_q1',
        resolution: 'cancelled',
        at: expect.any(Number),
      },
    },
    // Typed turn errors ride the durable stream (adapter-yielded or injected by
    // guardTurnErrors): live clients render them inline and the projector
    // latches SessionStatus.lastError. Pre-fix these default-dropped to null,
    // so OpenCode/Codex failures were invisible on /events.
    {
      name: 'error → error (all four fields carried)',
      input: {
        type: 'error',
        data: {
          message: 'SDK exploded',
          code: 'turn_exception',
          category: 'execution_error',
          details: 'stack trace',
        },
      },
      expected: {
        type: 'error',
        message: 'SDK exploded',
        code: 'turn_exception',
        category: 'execution_error',
        details: 'stack trace',
      },
    },
    // Events with no durable session-stream projection map to null.
    {
      name: 'done → null (turn boundary handled by feedProjector)',
      input: { type: 'done', data: { sessionId: 's1' } },
      expected: null,
    },
    // A refusal is NOT dropped (DOR-795): for a backgrounded subagent it is the
    // only place the loss is ever stated, so it rides the durable stream.
    {
      name: 'permission_denied → permission_denied (lean denial stays lean)',
      input: {
        type: 'permission_denied',
        data: { toolCallId: 't', toolName: 'Bash', message: 'no' },
      },
      expected: { type: 'permission_denied', toolCallId: 't', toolName: 'Bash', message: 'no' },
    },
    {
      // DOR-2101: the run-outcome rule reads `askKind` to tell a run that lost
      // a TOOL from one that only asked a question, and the denial's schema
      // says the record reaches the transcript. A whitelist that dropped the
      // field made that claim false for every replayed event.
      name: 'permission_denied → permission_denied (carries askKind onto the durable stream)',
      input: {
        type: 'permission_denied',
        data: {
          toolCallId: 'toolu_1',
          toolName: 'Bash',
          message: 'Nobody is available to approve this on a scheduled run.',
          reasonType: 'no_approval_surface',
          askKind: 'tool',
        },
      },
      expected: {
        type: 'permission_denied',
        toolCallId: 'toolu_1',
        toolName: 'Bash',
        message: 'Nobody is available to approve this on a scheduled run.',
        reasonType: 'no_approval_surface',
        askKind: 'tool',
      },
    },
    {
      name: 'ui_command → ui_command (carries the command whole)',
      input: {
        type: 'ui_command',
        data: {
          command: { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } },
        },
      } as unknown as StreamEvent,
      expected: {
        type: 'ui_command',
        command: { action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } },
      },
    },
    {
      name: 'devtools_capture_request → devtools_capture_request (carries the requestId)',
      input: {
        type: 'devtools_capture_request',
        data: { requestId: 'req-123' },
      } as unknown as StreamEvent,
      expected: { type: 'devtools_capture_request', requestId: 'req-123' },
    },
    {
      // The `capture` flag is what makes an action keep a recording frame (spec
      // `canvas-agent-seat` §3.2), and this hop is where it would be lost: the
      // recording would keep running with every frame missing, and nothing
      // anywhere would fail to say so.
      name: 'devtools_action_request carries the recording capture flag through',
      input: {
        type: 'devtools_action_request',
        data: {
          requestId: 'req-1',
          targetClientId: 'win-1',
          documentId: 'doc-1',
          command: { action: 'click', target: { text: 'Pay' } },
          capture: true,
        },
      } as unknown as StreamEvent,
      expected: {
        type: 'devtools_action_request',
        requestId: 'req-1',
        targetClientId: 'win-1',
        documentId: 'doc-1',
        command: { action: 'click', target: { text: 'Pay' } },
        capture: true,
      },
    },
    {
      name: 'devtools_recording_request → devtools_recording_request (carries the bounds)',
      input: {
        type: 'devtools_recording_request',
        data: {
          requestId: 'rec-req-1',
          targetClientId: 'win-1',
          documentId: 'doc-1',
          action: 'start',
          recordingId: '01JRECORDING',
          bounds: { longEdgePx: 800, frameMs: 500, maxBytes: 8_388_608 },
        },
      } as unknown as StreamEvent,
      expected: {
        type: 'devtools_recording_request',
        requestId: 'rec-req-1',
        targetClientId: 'win-1',
        documentId: 'doc-1',
        action: 'start',
        recordingId: '01JRECORDING',
        bounds: { longEdgePx: 800, frameMs: 500, maxBytes: 8_388_608 },
      },
    },
    {
      // The scope drives the sentence beside "Always Allow", so it has to
      // survive the lossy hop the way the SDK's other card context does
      // (DOR-1462).
      name: 'approval_required carries the always-allow scope through',
      input: {
        type: 'approval_required',
        data: {
          toolCallId: 'a2',
          toolName: 'Bash',
          input: '{}',
          startedAt: 1000,
          timeoutMs: 600000,
          hasSuggestions: true,
          alwaysAllowScope: 'user',
        },
      } as unknown as StreamEvent,
      expected: {
        type: 'approval_required',
        id: 'a2',
        startedAt: 1000,
        remainingMs: 600000,
        timeoutMs: 600000,
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: true,
        alwaysAllowScope: 'user',
      },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(toRawSessionEvent(input)).toEqual(expected);
    });
  }
});

describe('capability approval hold round-trip (DOR-939)', () => {
  // The ONLY code carrying approval/startedAt/capMs/approvalId across the
  // emitted-StreamEvent ({type,data:{...}}) -> RawSessionEvent bridge is
  // toCapabilityApprovalRequiredEvent / toCapabilityApprovalResolvedEvent. Neither
  // the hold test (asserts the PUSHED StreamEvent shape) nor the projector test
  // (ingests an already-normalized event) crosses it. A typo there
  // (`data.capMs` -> `data.capMS`) would fall back to the safe default and still
  // pass both suites while silently losing the hold's REAL cap. These feed the
  // EMITTED shape through and assert the values survive AND the projector pauses.
  const HELD_APPROVAL = {
    approvalId: 'appr-1',
    capabilityId: 'mcp.add',
    capabilityTitle: 'Add an MCP server',
    tier: 'destructive' as const,
    summary: 'Prober wants to run "Add an MCP server"',
    hasAgentPath: true,
    requestedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-06T02:00:00.000Z',
  };
  // Distinct from CAPABILITY_APPROVAL_HOLD_CAP_MS so a typo that falls back to
  // the default is CAUGHT by the value assertion, not masked by it.
  const EMITTED_CAP_MS = 30_000;
  const EMITTED_STARTED_AT = 1_234_000;

  it('carries approval/startedAt/capMs across the normalizer, then pauses the projector', () => {
    vi.useFakeTimers();
    vi.setSystemTime(EMITTED_STARTED_AT);
    try {
      const raw = toRawSessionEvent({
        type: 'capability_approval_required',
        data: { approval: HELD_APPROVAL, startedAt: EMITTED_STARTED_AT, capMs: EMITTED_CAP_MS },
      } as unknown as StreamEvent);

      // The bridge preserved every field the projector's pause math depends on.
      expect(raw).toEqual({
        type: 'capability_approval_required',
        approval: HELD_APPROVAL,
        startedAt: EMITTED_STARTED_AT,
        capMs: EMITTED_CAP_MS,
      });

      // …and the normalized event actually pauses the watchdog when ingested.
      const projector = new SessionStateProjector('s1');
      projector.ingest(raw as RawSessionEvent);
      expect(projector.hasPendingInteractions()).toBe(true);
      // One tick short of the EMITTED cap (not the default): still a live wait.
      vi.setSystemTime(EMITTED_STARTED_AT + EMITTED_CAP_MS - 1);
      expect(projector.hasPendingInteractions()).toBe(true);
      // Past the emitted cap AND its stall-pause grace, the hold is stale. (A
      // capMs typo would fall back to the much larger default and read true here;
      // the value assertion above is what catches it.)
      vi.setSystemTime(EMITTED_STARTED_AT + EMITTED_CAP_MS + CAPABILITY_HOLD_PAUSE_GRACE_MS);
      expect(projector.hasPendingInteractions()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('in-conversation MCP sign-in round-trip (DOR-1004)', () => {
  // The only code carrying the card's fields across the emitted-StreamEvent
  // ({type,data:{...}}) -> RawSessionEvent bridge is toMcpSigninRequiredEvent /
  // toMcpSigninResolvedEvent. A typo there (`data.authorizeUrl` ->
  // `data.authorizeURL`) would put an empty, un-clickable link on the card while
  // every other suite stayed green.
  const CARD = {
    serverName: 'granola',
    agentId: '01HV7KJZZZ0000000000000000',
    flowId: 'flow-1',
    authorizeUrl: 'https://mcp.test.local/authorize?code_challenge=abc',
    disclosure: 'DorkOS stores the token on this machine.',
  };

  it('carries every card field across the normalizer', () => {
    const raw = toRawSessionEvent({
      type: 'mcp_signin_required',
      data: CARD,
    } as unknown as StreamEvent);

    expect(raw).toEqual({ type: 'mcp_signin_required', ...CARD });
  });
});

// A background task that is still running when the runtime's stream ends stops
// being VISIBLE: the subprocess it lived in exited, so its `task_notification`
// can never arrive. Nothing else in the system would ever clear it, so an
// uncleared count is a permanent on-screen lie (DOR-1100) — and the terminal
// update the sweep writes says `untracked`, not `stopped`, because a detached
// child outlives that process and DorkOS cannot tell the two apart (DOR-1108).
describe('feedProjector — stranded background children', () => {
  it('retires every still-running child when the stream ends', async () => {
    const projector = new SessionStateProjector('strand-1');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'background_task_started', data: { taskId: 'bt1', description: 'lint' } };
      yield { type: 'background_task_started', data: { taskId: 'bt2', description: 'tests' } };
      yield { type: 'background_task_done', data: { taskId: 'bt1', status: 'completed' } };
      yield { type: 'done', data: { sessionId: 'strand-1' } };
    }

    await feedProjector(projector, turn());

    expect(projector.getStatus().runningSubagentCount).toBe(0);
    // The one that never reported gets a terminal update of its own, so a
    // replay and a live client drain through the same event.
    // Every non-running update, so the child that DID report is pinned as
    // `complete` (its own word) beside the swept one's `untracked` (DorkOS's).
    const terminal = ingestSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'subagent_update' && e.status !== 'running');
    expect(terminal).toEqual([
      { type: 'subagent_update', taskId: 'bt1', status: 'complete' },
      { type: 'subagent_update', taskId: 'bt2', status: 'untracked' },
    ]);
  });

  // FB-18: on a warm process the stream is one turn's window, so a helper that
  // outlives the reply is still running when it ends. Calling it lost made the
  // helper strip go blank while the helper kept working.
  it('spares the children the runtime still names as running', async () => {
    const projector = new SessionStateProjector('strand-6');
    const ingestSpy = vi.spyOn(projector, 'ingest');

    async function* turn(): AsyncIterable<StreamEvent> {
      yield { type: 'background_task_started', data: { taskId: 'helper', description: 'sleep' } };
      yield { type: 'background_task_started', data: { taskId: 'gone', description: 'lint' } };
      yield { type: 'done', data: { sessionId: 'strand-6' } };
    }

    await feedProjector(projector, turn(), { stillLive: () => ['helper'] });

    const terminal = ingestSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'subagent_update' && e.status !== 'running');
    // Only the child the runtime no longer sees is called lost.
    expect(terminal).toEqual([{ type: 'subagent_update', taskId: 'gone', status: 'untracked' }]);
    expect(projector.listRunningSubagents()).toEqual(['helper']);
  });
});
