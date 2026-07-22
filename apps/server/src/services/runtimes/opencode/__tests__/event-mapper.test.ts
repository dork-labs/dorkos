import { describe, it, expect } from 'vitest';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../config/constants.js';
import {
  createOpenCodeEventContext,
  extractOpenCodeSessionId,
  mapOpenCodeEvent,
  mapOpenCodeTurn,
  matchesOpenCodeSession,
  type OpenCodeEventContext,
  type OpenCodeWireEvent,
} from '../event-mapper.js';
import {
  CREATED_AT,
  DEFAULT_COST,
  DIRECTORY,
  OC_SESSION_A,
  OC_SESSION_B,
  OTHER_DIRECTORY,
  abortedError,
  assistantMessage,
  fakeGlobalEventStream,
  fileEdited,
  globalEvent,
  interleavedGlobalStream,
  messageUpdated,
  opencodeAbortedTurn,
  opencodeApprovalTurn,
  opencodeErrorTurn,
  opencodeSimpleTurn,
  opencodeToolTurn,
  outputLengthError,
  partDelta,
  partUpdated,
  permission,
  permissionReplied,
  permissionUpdated,
  providerAuthError,
  reasoningPart,
  serverConnected,
  sessionCompacted,
  sessionError,
  sessionIdle,
  sessionInfo,
  sessionUpdated,
  statusEvent,
  textPart,
  todo,
  todoUpdated,
  toEventStream,
  toolPart,
  toolStateCompleted,
  toolStateError,
  toolStatePending,
  toolStateRunning,
  unknownError,
  userMessage,
  wireHeartbeat,
} from './opencode-sse-fixtures.js';

/** DorkOS session id — deliberately NOT the OpenCode `ses_*` id (different namespaces). */
const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';
const OC = OC_SESSION_A;

function makeContext(): OpenCodeEventContext {
  return createOpenCodeEventContext(SESSION_ID);
}

async function drain(
  events: OpenCodeWireEvent[] | AsyncGenerator<OpenCodeWireEvent>,
  ctx = makeContext()
): Promise<StreamEvent[]> {
  const stream = Array.isArray(events) ? toEventStream(events) : events;
  const out: StreamEvent[] = [];
  for await (const event of mapOpenCodeTurn(stream, ctx)) out.push(event);
  return out;
}

describe('extractOpenCodeSessionId', () => {
  it('keys part updates by the part sessionID and messages by the info sessionID', () => {
    expect(extractOpenCodeSessionId(partUpdated(textPart(OC, 'p1', 'hi')))).toBe(OC);
    expect(extractOpenCodeSessionId(messageUpdated(assistantMessage(OC)))).toBe(OC);
    expect(extractOpenCodeSessionId(messageUpdated(userMessage(OC)))).toBe(OC);
  });

  it('keys deltas, permissions, status, idle, error, and todos by properties.sessionID', () => {
    expect(extractOpenCodeSessionId(partDelta(OC, 'p1', 'x'))).toBe(OC);
    expect(extractOpenCodeSessionId(permissionUpdated(permission(OC)))).toBe(OC);
    expect(extractOpenCodeSessionId(permissionReplied(OC, 'per_0001'))).toBe(OC);
    expect(extractOpenCodeSessionId(statusEvent(OC, { type: 'busy' }))).toBe(OC);
    expect(extractOpenCodeSessionId(sessionIdle(OC))).toBe(OC);
    expect(extractOpenCodeSessionId(sessionError(OC, unknownError('x')))).toBe(OC);
    expect(extractOpenCodeSessionId(todoUpdated(OC, []))).toBe(OC);
  });

  it('keys session bookkeeping events by info.id and non-session events as undefined', () => {
    expect(extractOpenCodeSessionId(sessionUpdated(sessionInfo(OC)))).toBe(OC);
    expect(extractOpenCodeSessionId(fileEdited('/tmp/a.ts'))).toBeUndefined();
    expect(extractOpenCodeSessionId(serverConnected())).toBeUndefined();
    expect(extractOpenCodeSessionId(wireHeartbeat())).toBeUndefined();
    expect(extractOpenCodeSessionId(sessionError(undefined))).toBeUndefined();
  });
});

describe('matchesOpenCodeSession — demux on one multiplexed stream', () => {
  it('matches only when BOTH directory and OpenCode sessionID agree', () => {
    const event = globalEvent(DIRECTORY, partDelta(OC, 'p1', 'x'));
    expect(matchesOpenCodeSession(event, DIRECTORY, OC)).toBe(true);
    expect(matchesOpenCodeSession(event, OTHER_DIRECTORY, OC)).toBe(false);
    expect(matchesOpenCodeSession(event, DIRECTORY, OC_SESSION_B)).toBe(false);
  });

  it('demuxes two interleaved sessions into clean, independently terminated turns', async () => {
    const stream = interleavedGlobalStream();

    async function turnFor(ocSessionId: string, dorkosId: string): Promise<StreamEvent[]> {
      const ctx = createOpenCodeEventContext(dorkosId);
      const filtered = (async function* () {
        for await (const event of fakeGlobalEventStream(stream)) {
          if (!matchesOpenCodeSession(event, DIRECTORY, ocSessionId)) continue;
          yield event.payload as OpenCodeWireEvent;
        }
      })();
      return drain(filtered, ctx);
    }

    const dorkosA = 'a0000000-0000-4000-8000-00000000000a';
    const dorkosB = 'b0000000-0000-4000-8000-00000000000b';
    const [eventsA, eventsB] = await Promise.all([
      turnFor(OC_SESSION_A, dorkosA),
      turnFor(OC_SESSION_B, dorkosB),
    ]);

    const textOf = (events: StreamEvent[]) =>
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e.data as { text: string }).text)
        .join('');

    expect(textOf(eventsA)).toBe('Alpha says hi');
    expect(textOf(eventsB)).toBe('Beta says yo');
    // The same-sessionID-other-directory intruder never leaked into A.
    expect(textOf(eventsA)).not.toContain('INTRUDER');

    for (const [events, dorkosId] of [
      [eventsA, dorkosA],
      [eventsB, dorkosB],
    ] as const) {
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events[events.length - 1]).toEqual({ type: 'done', data: { sessionId: dorkosId } });
    }
  });
});

describe('mapOpenCodeEvent', () => {
  describe('text streaming', () => {
    it('emits text_delta for each message.part.delta increment', () => {
      const ctx = makeContext();
      expect(mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', '')), ctx)).toEqual([]);
      expect(mapOpenCodeEvent(partDelta(OC, 'p1', 'Hel'), ctx)).toEqual([
        { type: 'text_delta', data: { text: 'Hel' } },
      ]);
      expect(mapOpenCodeEvent(partDelta(OC, 'p1', 'lo'), ctx)).toEqual([
        { type: 'text_delta', data: { text: 'lo' } },
      ]);
    });

    it('does NOT re-emit already-streamed text when the final cumulative snapshot arrives', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', '')), ctx);
      mapOpenCodeEvent(partDelta(OC, 'p1', 'Hello'), ctx);
      expect(
        mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', 'Hello', { end: true })), ctx)
      ).toEqual([]);
    });

    it('emits the unseen suffix when only cumulative snapshots arrive (no deltas)', () => {
      const ctx = makeContext();
      expect(mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', '')), ctx)).toEqual([]);
      expect(
        mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', 'All at once', { end: true })), ctx)
      ).toEqual([{ type: 'text_delta', data: { text: 'All at once' } }]);
    });

    it('emits the full new text when a snapshot is not a prefix extension', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', 'Hello')), ctx);
      expect(mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', 'Goodbye')), ctx)).toEqual([
        { type: 'text_delta', data: { text: 'Goodbye' } },
      ]);
    });

    it('maps reasoning parts and their deltas to thinking_delta', () => {
      const ctx = makeContext();
      expect(mapOpenCodeEvent(partUpdated(reasoningPart(OC, 'r1', '')), ctx)).toEqual([]);
      expect(mapOpenCodeEvent(partDelta(OC, 'r1', 'Think'), ctx)).toEqual([
        { type: 'thinking_delta', data: { text: 'Think' } },
      ]);
      expect(
        mapOpenCodeEvent(partUpdated(reasoningPart(OC, 'r1', 'Thinking...', { end: true })), ctx)
      ).toEqual([{ type: 'thinking_delta', data: { text: 'ing...' } }]);
    });

    it('drops orphan deltas for unknown parts — the final snapshot covers them', () => {
      const ctx = makeContext();
      expect(mapOpenCodeEvent(partDelta(OC, 'p_unknown', 'orphan'), ctx)).toEqual([]);
    });

    it('drops deltas for non-text fields', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', '')), ctx);
      expect(mapOpenCodeEvent(partDelta(OC, 'p1', 'x', { field: 'metadata' }), ctx)).toEqual([]);
    });

    it('skips text parts flagged ignored', () => {
      const ctx = makeContext();
      expect(
        mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', 'hidden', { ignored: true })), ctx)
      ).toEqual([]);
    });
  });

  describe('tool parts → tool events', () => {
    const input = { command: 'ls -la' };

    it('emits nothing while input is still streaming (pending)', () => {
      expect(
        mapOpenCodeEvent(
          partUpdated(toolPart(OC, 'call_1', 'bash', toolStatePending(input))),
          makeContext()
        )
      ).toEqual([]);
    });

    it('maps running to tool_call_start keyed by callID with the tool name and JSON input', () => {
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateRunning(input))),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'tool_call_start',
          data: {
            toolCallId: 'call_1',
            toolName: 'bash',
            input: '{"command":"ls -la"}',
            status: 'running',
          },
        },
      ]);
    });

    it('maps completion to tool_call_end + tool_result', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(toolPart(OC, 'call_1', 'bash', toolStateRunning(input))), ctx);
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateCompleted(input, 'file1\n'))),
        ctx
      );
      expect(events).toEqual([
        {
          type: 'tool_call_end',
          data: { toolCallId: 'call_1', toolName: 'bash', status: 'complete' },
        },
        {
          type: 'tool_result',
          data: { toolCallId: 'call_1', toolName: 'bash', result: 'file1\n', status: 'complete' },
        },
      ]);
    });

    it('synthesizes tool_call_start when completion arrives without a running snapshot', () => {
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateCompleted(input, 'ok'))),
        makeContext()
      );
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'tool_call_end',
        'tool_result',
      ]);
    });

    it('never populates the MCP App `ui` field (SEP-1865 is claude-code-only in v1)', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(toolPart(OC, 'call_1', 'bash', toolStateRunning(input))), ctx);
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateCompleted(input, 'ui://not-detected'))),
        ctx
      );
      const result = events.find((e) => e.type === 'tool_result');
      expect((result!.data as { ui?: unknown }).ui).toBeUndefined();
    });

    it('skips tool_result when completion output is empty', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(toolPart(OC, 'call_1', 'bash', toolStateRunning(input))), ctx);
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateCompleted(input, ''))),
        ctx
      );
      expect(events.map((e) => e.type)).toEqual(['tool_call_end']);
    });

    it('maps tool errors to error-status end + result carrying the message', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(toolPart(OC, 'call_1', 'bash', toolStateRunning(input))), ctx);
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateError(input, 'command not found'))),
        ctx
      );
      expect(events.map((e) => e.type)).toEqual(['tool_call_end', 'tool_result']);
      expect(events[0]!.data).toMatchObject({ status: 'error' });
      expect(events[1]!.data).toMatchObject({ status: 'error', result: 'command not found' });
    });

    it('does not duplicate terminal tool events when a completed part is re-published', () => {
      const ctx = makeContext();
      const completed = partUpdated(
        toolPart(OC, 'call_1', 'bash', toolStateCompleted(input, 'ok'))
      );
      mapOpenCodeEvent(completed, ctx);
      // Compaction re-saves completed tool parts (time.compacted) → re-publication.
      expect(mapOpenCodeEvent(completed, ctx)).toEqual([]);
    });
  });

  describe('permission.updated → approval_required', () => {
    it('maps the permission to a schema-valid approval keyed by the permission id', () => {
      const events = mapOpenCodeEvent(
        permissionUpdated(
          permission(OC, {
            id: 'per_0001',
            type: 'bash',
            pattern: 'rm *',
            callID: 'call_1',
            title: 'Run command: rm -rf dist',
            metadata: { command: 'rm -rf dist' },
          })
        ),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'approval_required',
          data: {
            toolCallId: 'per_0001',
            toolName: 'bash',
            input: '{"pattern":"rm *","command":"rm -rf dist"}',
            timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
            startedAt: CREATED_AT,
            title: 'Run command: rm -rf dist',
            hasSuggestions: false,
          },
        },
      ]);
      expect(StreamEventSchema.safeParse(events[0]).success).toBe(true);
    });

    it('omits pattern from input when the permission has none', () => {
      const events = mapOpenCodeEvent(
        permissionUpdated(permission(OC, { metadata: { filePath: '/tmp/a' } })),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({ input: '{"filePath":"/tmp/a"}' });
    });

    it('maps permission.replied to interaction_cancelled so resolved-elsewhere cards clear', () => {
      const events = mapOpenCodeEvent(permissionReplied(OC, 'per_0001', 'once'), makeContext());
      expect(events).toEqual([
        { type: 'interaction_cancelled', data: { interactionId: 'per_0001' } },
      ]);
    });
  });

  describe('errors and status', () => {
    it('maps session.error to a typed non-terminal error event', () => {
      const events = mapOpenCodeEvent(
        sessionError(OC, unknownError('model exploded')),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'error',
          data: { message: 'model exploded', code: 'UnknownError', category: 'execution_error' },
        },
      ]);
    });

    it('maps an unavailable-model failure to friendly copy pointing at the model menu', () => {
      // The honest Ollama shape for a tag that is not installed (spec §11).
      const events = mapOpenCodeEvent(
        sessionError(OC, unknownError('model "deepseek-r1:32b" not found, try pulling it first')),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'error',
          data: {
            message: "That model isn't available. Pick another one from the model menu.",
            code: 'model_unavailable',
            category: 'execution_error',
          },
        },
      ]);
    });

    it('maps the OpenRouter no-endpoints shape to the same friendly model-menu error', () => {
      const events = mapOpenCodeEvent(
        sessionError(OC, unknownError('No endpoints found for deepseek/deepseek-r1')),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({ code: 'model_unavailable' });
    });

    it('leaves an unrelated failure as a generic execution error', () => {
      const events = mapOpenCodeEvent(sessionError(OC, unknownError('disk full')), makeContext());
      expect(events[0]!.data).toMatchObject({ message: 'disk full', code: 'UnknownError' });
    });

    it('does not treat a transient-outage message as an unavailable model', () => {
      // "temporarily not available" reads as an outage a retry could clear —
      // telling the user to pick another model would be wrong (spec §11).
      const events = mapOpenCodeEvent(
        sessionError(OC, unknownError('The model is temporarily not available, please retry')),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({ code: 'UnknownError' });
      expect((events[0]!.data as { message: string }).message).toContain(
        'temporarily not available'
      );
    });

    it('carries provider auth failures with their error name as the code', () => {
      const events = mapOpenCodeEvent(
        sessionError(OC, providerAuthError('anthropic', 'invalid api key')),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({
        message: 'invalid api key',
        code: 'ProviderAuthError',
      });
    });

    it('falls back to the error name when data carries no message', () => {
      const events = mapOpenCodeEvent(sessionError(OC, outputLengthError()), makeContext());
      expect(events[0]!.data).toMatchObject({ code: 'MessageOutputLengthError' });
      expect((events[0]!.data as { message: string }).message.length).toBeGreaterThan(0);
    });

    it('suppresses MessageAbortedError — the abort shape is a user interrupt, not a failure', () => {
      expect(mapOpenCodeEvent(sessionError(OC, abortedError()), makeContext())).toEqual([]);
    });

    it('emits a generic error for a payload-less session.error', () => {
      const events = mapOpenCodeEvent(sessionError(OC), makeContext());
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('error');
      expect(events[0]!.data).toMatchObject({ code: 'session_error' });
    });

    it('maps retry status to a non-terminal system_status diagnostic', () => {
      const events = mapOpenCodeEvent(
        statusEvent(OC, {
          type: 'retry',
          attempt: 2,
          message: 'overloaded',
          next: CREATED_AT + 500,
        }),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'system_status',
          data: { message: 'Retrying after error (attempt 2): overloaded' },
        },
      ]);
    });

    it('emits nothing for busy and idle status transitions (session.idle is the terminal)', () => {
      expect(mapOpenCodeEvent(statusEvent(OC, { type: 'busy' }), makeContext())).toEqual([]);
      expect(mapOpenCodeEvent(statusEvent(OC, { type: 'idle' }), makeContext())).toEqual([]);
    });
  });

  describe('turn end and session bookkeeping', () => {
    it('maps session.idle to the terminal done stamped with the DORKOS session id', () => {
      expect(mapOpenCodeEvent(sessionIdle(OC), makeContext())).toEqual([
        { type: 'done', data: { sessionId: SESSION_ID } },
      ]);
    });

    it('maps a completed assistant message to a usage session_status', () => {
      const events = mapOpenCodeEvent(
        messageUpdated(assistantMessage(OC, { completed: true })),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'session_status',
          data: {
            sessionId: SESSION_ID,
            model: 'claude-sonnet-4-5',
            costUsd: DEFAULT_COST,
            contextTokens: 120,
            outputTokens: 45,
            cacheReadTokens: 80,
            cacheCreationTokens: 12,
            usage: {
              kind: 'pay-as-you-go',
              costUsd: DEFAULT_COST,
              detail: 'anthropic/claude-sonnet-4-5',
            },
          },
        },
      ]);
    });

    it('emits nothing for in-flight assistant updates and user messages', () => {
      expect(mapOpenCodeEvent(messageUpdated(assistantMessage(OC)), makeContext())).toEqual([]);
      expect(mapOpenCodeEvent(messageUpdated(userMessage(OC)), makeContext())).toEqual([]);
    });

    it('maps session.compacted to operation_progress done + a compact_boundary marker (DOR-110)', () => {
      // OpenCode reports compaction as a single post-hoc completion — honest
      // degradation is a lone operation_progress `done` (no start/percent) plus
      // the durable boundary row.
      expect(mapOpenCodeEvent(sessionCompacted(OC), makeContext())).toEqual([
        {
          type: 'operation_progress',
          data: { operation: 'compaction', state: 'done', determinate: false },
        },
        { type: 'compact_boundary', data: {} },
      ]);
    });
  });

  describe('todo.updated → task_update', () => {
    it('maps todos to a task snapshot, dropping cancelled entries', () => {
      const events = mapOpenCodeEvent(
        todoUpdated(OC, [
          todo('1', 'step 1', 'completed'),
          todo('2', 'step 2', 'in_progress'),
          todo('3', 'step 3', 'cancelled'),
          todo('4', 'step 4', 'pending'),
        ]),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'task_update',
          data: {
            action: 'snapshot',
            task: { id: '1', subject: 'step 1', status: 'completed' },
            tasks: [
              { id: '1', subject: 'step 1', status: 'completed' },
              { id: '2', subject: 'step 2', status: 'in_progress' },
              { id: '4', subject: 'step 4', status: 'pending' },
            ],
          },
        },
      ]);
    });

    it('emits nothing when the list is empty or all entries are cancelled', () => {
      expect(mapOpenCodeEvent(todoUpdated(OC, []), makeContext())).toEqual([]);
      expect(
        mapOpenCodeEvent(todoUpdated(OC, [todo('1', 'gone', 'cancelled')]), makeContext())
      ).toEqual([]);
    });
  });

  describe('ignore list', () => {
    it('emits nothing for session bookkeeping and non-turn events', () => {
      const ctx = makeContext();
      const ignored: OpenCodeWireEvent[] = [
        sessionUpdated(sessionInfo(OC)),
        fileEdited('/tmp/a.ts'),
        serverConnected(),
        wireHeartbeat(), // wire-only type absent from the SDK union
      ];
      for (const event of ignored) {
        expect(mapOpenCodeEvent(event, ctx), `expected ${event.type} to be ignored`).toEqual([]);
      }
    });
  });
});

describe('mapOpenCodeTurn', () => {
  const FULL_TURNS: Array<[string, () => OpenCodeWireEvent[]]> = [
    ['simple text turn', () => opencodeSimpleTurn(OC, 'Hello world')],
    ['tool execution turn', () => opencodeToolTurn(OC)],
    ['tool approval turn', () => opencodeApprovalTurn(OC)],
    ['failed turn', () => opencodeErrorTurn(OC, 'boom')],
    ['aborted (interrupted) turn', () => opencodeAbortedTurn(OC, 'partial answer')],
  ];

  it.each(FULL_TURNS)(
    '%s: every event is schema-valid and exactly one terminal done ends the stream',
    async (_name, makeTurn) => {
      const events = await drain(makeTurn());

      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const parsed = StreamEventSchema.safeParse(event);
        expect(
          parsed.success,
          `malformed StreamEvent (type '${event.type}'): ${
            parsed.success ? '' : parsed.error.message
          }`
        ).toBe(true);
      }
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events[events.length - 1]!.type).toBe('done');
    }
  );

  it('maps a simple turn to text deltas, usage, and done', async () => {
    const events = await drain(opencodeSimpleTurn(OC, 'Hello world'));
    expect(events.map((e) => e.type)).toEqual([
      'text_delta',
      'text_delta',
      'session_status',
      'done',
    ]);
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(text).toBe('Hello world');
  });

  it('surfaces the approval flow mid-turn and resolves it before the tool events', async () => {
    const events = await drain(opencodeApprovalTurn(OC));
    expect(events.map((e) => e.type)).toEqual([
      'approval_required',
      'interaction_cancelled',
      'tool_call_start',
      'tool_call_end',
      'text_delta',
      'session_status',
      'done',
    ]);
  });

  it('maps a failed turn to a typed error followed by the session.idle done', async () => {
    const events = await drain(opencodeErrorTurn(OC, 'boom'));
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]!.data).toMatchObject({ message: 'boom', code: 'UnknownError' });
  });

  it('ends an aborted turn with done and NO error event', async () => {
    const events = await drain(opencodeAbortedTurn(OC, 'partial answer'));
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
    expect(events[events.length - 1]!.data).toEqual({ sessionId: SESSION_ID });
  });

  it('stops consuming the stream after the terminal done', async () => {
    let pulledPastIdle = false;
    async function* endless(): AsyncGenerator<OpenCodeWireEvent> {
      yield sessionIdle(OC);
      pulledPastIdle = true;
      yield partDelta(OC, 'p1', 'never');
    }
    const events = await drain(endless());
    expect(events.map((e) => e.type)).toEqual(['done']);
    expect(pulledPastIdle).toBe(false);
  });

  it('appends terminal done when the stream ends without session.idle', async () => {
    const ctx = makeContext();
    const events = await drain(
      [partUpdated(textPart(OC, 'p1', 'half a')), statusEvent(OC, { type: 'busy' })],
      ctx
    );
    expect(events[events.length - 1]).toEqual({ type: 'done', data: { sessionId: SESSION_ID } });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('converts a non-abort stream crash into a typed error followed by done', async () => {
    async function* crashing(): AsyncGenerator<OpenCodeWireEvent> {
      yield statusEvent(OC, { type: 'busy' });
      throw new Error('sidecar exited unexpectedly');
    }
    const events = await drain(crashing());
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]!.data).toMatchObject({
      message: 'sidecar exited unexpectedly',
      code: 'stream_error',
    });
  });

  it('ends with a plain done when the subscription is aborted (AbortError)', async () => {
    async function* aborting(): AsyncGenerator<OpenCodeWireEvent> {
      yield statusEvent(OC, { type: 'busy' });
      throw new DOMException('Aborted', 'AbortError');
    }
    const events = await drain(aborting());
    expect(events.map((e) => e.type)).toEqual(['done']);
  });
});
