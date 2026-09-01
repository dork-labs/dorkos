import { describe, it, expect } from 'vitest';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import type { ToolPart } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../config/constants.js';
import {
  createOpenCodeEventContext,
  extractOpenCodeSessionId,
  mapOpenCodeEvent,
  mapOpenCodeTurn,
  matchesOpenCodeSession,
  matchesOpenCodeSubagentSession,
  type OpenCodeEventContext,
  type OpenCodeWireEvent,
} from '../event-mapper.js';
import {
  COMPLETED_AT,
  CREATED_AT,
  DEFAULT_COST,
  DIRECTORY,
  OC_CHILD_SESSION,
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
  opencodeSubagentTurn,
  opencodeToolTurn,
  outputLengthError,
  partDelta,
  partUpdated,
  permissionAsked,
  permissionReplied,
  permissionRequest,
  providerAuthError,
  reasoningPart,
  serverConnected,
  sessionCompacted,
  sessionError,
  sessionIdle,
  sessionInfo,
  sessionUpdated,
  statusEvent,
  taskToolInput,
  taskToolMetadata,
  taskToolPart,
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

/**
 * A fresh turn context that has already seen the assistant `message.updated`
 * the sidecar opens every message with.
 *
 * Load-bearing, not ceremony: parts name only a `messageID`, so the mapper
 * learns who wrote a message from that announcement and drops parts it cannot
 * attribute to the assistant (`isAssistantMessage`). The wire always announces
 * first — a context that has not seen it is not a state OpenCode can produce —
 * and every part these fixtures build belongs to `msg_0001`, the id
 * {@link assistantMessage} defaults to.
 */
function makeContext(): OpenCodeEventContext {
  const ctx = createOpenCodeEventContext(SESSION_ID);
  mapOpenCodeEvent(messageUpdated(assistantMessage(OC)), ctx);
  return ctx;
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
    expect(extractOpenCodeSessionId(permissionAsked(permissionRequest(OC)))).toBe(OC);
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

describe('matchesOpenCodeSubagentSession — admitting a subagent child session', () => {
  it('admits nothing until a task tool part has revealed its child session', () => {
    const ctx = makeContext();
    const childEvent = globalEvent(
      DIRECTORY,
      partUpdated(toolPart(OC_CHILD_SESSION, 'child_1', 'grep', toolStateRunning({})))
    );
    expect(matchesOpenCodeSubagentSession(childEvent, DIRECTORY, ctx)).toBe(false);

    mapOpenCodeEvent(
      partUpdated(
        taskToolPart(OC, 'call_task', toolStateRunning(taskToolInput()), taskToolMetadata())
      ),
      ctx
    );
    expect(matchesOpenCodeSubagentSession(childEvent, DIRECTORY, ctx)).toBe(true);
    // A same-id event from another directory is still a different instance.
    expect(matchesOpenCodeSubagentSession(childEvent, OTHER_DIRECTORY, ctx)).toBe(false);
    // The parent's own events are the base filter's job, not this one's.
    expect(
      matchesOpenCodeSubagentSession(globalEvent(DIRECTORY, sessionIdle(OC)), DIRECTORY, ctx)
    ).toBe(false);
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

  /**
   * The turn must never speak its own prompt back (DOR-1659). OpenCode
   * publishes part events for the USER's message too, and DorkOS writes two
   * user parts per turn (`turn-input.ts`): the injected context as a
   * `synthetic` part, then the person's pristine text. Mapped, they opened
   * every room post, every task summary and the durable event log with ~13 KB
   * of `<gen_ui>`/`<room_context>` plus an echo of the trigger.
   */
  describe('whose message a part belongs to', () => {
    const USER_MESSAGE = 'msg_user01';

    /** A context that has seen the user message the fixtures' user parts belong to. */
    function contextWithUserMessage(): OpenCodeEventContext {
      const ctx = makeContext();
      mapOpenCodeEvent(messageUpdated(userMessage(OC, USER_MESSAGE)), ctx);
      return ctx;
    }

    it('drops the injected synthetic context part DorkOS wrote', () => {
      const ctx = contextWithUserMessage();
      const injected = textPart(OC, 'p_ctx', '<gen_ui>\nDorkOS generative UI…\n</gen_ui>', {
        messageID: USER_MESSAGE,
      });
      expect(mapOpenCodeEvent(partUpdated({ ...injected, synthetic: true }), ctx)).toEqual([]);
    });

    it("drops the person's own pristine text, which carries no synthetic flag", () => {
      const ctx = contextWithUserMessage();
      expect(
        mapOpenCodeEvent(
          partUpdated(textPart(OC, 'p_prompt', 'summarise the repo', { messageID: USER_MESSAGE })),
          ctx
        )
      ).toEqual([]);
    });

    it('drops the `<dork-kickoff>` birth turn, which is a user part like any other', () => {
      const ctx = contextWithUserMessage();
      expect(
        mapOpenCodeEvent(
          partUpdated(
            textPart(OC, 'p_kick', '<dork-kickoff>\nintroduce yourself\n</dork-kickoff>', {
              messageID: USER_MESSAGE,
            })
          ),
          ctx
        )
      ).toEqual([]);
    });

    it('drops deltas on a user part too, not just its snapshots', () => {
      const ctx = contextWithUserMessage();
      mapOpenCodeEvent(partUpdated(textPart(OC, 'p_prompt', '', { messageID: USER_MESSAGE })), ctx);
      expect(
        mapOpenCodeEvent(partDelta(OC, 'p_prompt', 'typed', { messageID: USER_MESSAGE }), ctx)
      ).toEqual([]);
    });

    it('still streams the assistant text of the very same turn', () => {
      const ctx = contextWithUserMessage();
      mapOpenCodeEvent(
        partUpdated(textPart(OC, 'p_prompt', 'summarise the repo', { messageID: USER_MESSAGE })),
        ctx
      );
      expect(
        mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', 'Here is the summary.')), ctx)
      ).toEqual([{ type: 'text_delta', data: { text: 'Here is the summary.' } }]);
    });

    /**
     * Fails closed. The wire announces a message before any of its parts (pinned
     * against the real capture in `live-capture-replay.test.ts`) and the runtime
     * subscribes before it triggers the turn, so an unattributable part should
     * not happen — and if it does, admitting it could leak someone else's words
     * into a shared room and into durable storage, while dropping it costs a
     * fragment of a bubble the canonical history restores at turn end.
     */
    it('drops a part whose message was never announced, rather than guessing', () => {
      const ctx = createOpenCodeEventContext(SESSION_ID);
      expect(
        mapOpenCodeEvent(
          partUpdated(textPart(OC, 'p1', 'unattributable', { messageID: 'msg_never_seen' })),
          ctx
        )
      ).toEqual([]);
    });

    it('learns the role from message.updated regardless of whether the message completed', () => {
      const ctx = createOpenCodeEventContext(SESSION_ID);
      // An in-flight assistant message maps to no StreamEvent of its own...
      expect(mapOpenCodeEvent(messageUpdated(assistantMessage(OC)), ctx)).toEqual([]);
      // ...but its role is recorded, so its parts stream from the first one.
      expect(mapOpenCodeEvent(partUpdated(textPart(OC, 'p1', 'Hi')), ctx)).toEqual([
        { type: 'text_delta', data: { text: 'Hi' } },
      ]);
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

  describe('`task` tool parts → subagent background-task events', () => {
    const input = taskToolInput();

    it('emits background_task_started alongside the tool call when the subagent starts', () => {
      const events = mapOpenCodeEvent(
        partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input))),
        makeContext()
      );
      expect(events.map((e) => e.type)).toEqual(['tool_call_start', 'background_task_started']);
      expect(events[1]!.data).toEqual({
        taskId: 'call_task',
        taskType: 'agent',
        startedAt: CREATED_AT,
        toolUseId: 'call_task',
        description: 'survey the routes',
      });
      expect(StreamEventSchema.safeParse(events[1]).success).toBe(true);
    });

    it('starts the subagent exactly once across repeated running snapshots', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input))), ctx);
      const second = mapOpenCodeEvent(
        partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input), taskToolMetadata())),
        ctx
      );
      expect(second.map((e) => e.type)).toEqual([]);
    });

    it('carries the child session id when the first snapshot already has metadata', () => {
      const events = mapOpenCodeEvent(
        partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input), taskToolMetadata())),
        makeContext()
      );
      expect(events[1]!.data).toMatchObject({ subagentSessionId: OC_CHILD_SESSION });
    });

    it('does not touch non-task tools', () => {
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateRunning({ command: 'ls' }))),
        makeContext()
      );
      expect(events.map((e) => e.type)).toEqual(['tool_call_start']);
    });

    describe('child-session activity', () => {
      function startedContext(): OpenCodeEventContext {
        const ctx = makeContext();
        mapOpenCodeEvent(
          partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input), taskToolMetadata())),
          ctx
        );
        return ctx;
      }

      it('reports each child tool call as background_task_progress on the parent task', () => {
        const ctx = startedContext();
        const first = mapOpenCodeEvent(
          partUpdated(
            toolPart(OC_CHILD_SESSION, 'child_1', 'grep', toolStateRunning({ pattern: 'router' }))
          ),
          ctx
        );
        expect(first).toEqual([
          {
            type: 'background_task_progress',
            data: { taskId: 'call_task', toolUses: 1, lastToolName: 'grep', durationMs: 0 },
          },
        ]);
        expect(StreamEventSchema.safeParse(first[0]).success).toBe(true);

        const second = mapOpenCodeEvent(
          partUpdated(
            toolPart(OC_CHILD_SESSION, 'child_2', 'read', toolStateCompleted({}, 'contents'))
          ),
          ctx
        );
        expect(second[0]!.data).toMatchObject({ toolUses: 2, lastToolName: 'read' });
      });

      it('counts each child tool call once across its state transitions', () => {
        const ctx = startedContext();
        mapOpenCodeEvent(
          partUpdated(toolPart(OC_CHILD_SESSION, 'child_1', 'grep', toolStateRunning({}))),
          ctx
        );
        expect(
          mapOpenCodeEvent(
            partUpdated(
              toolPart(OC_CHILD_SESSION, 'child_1', 'grep', toolStateCompleted({}, 'hit'))
            ),
            ctx
          )
        ).toEqual([]);
      });

      it('never leaks the child session into the parent transcript or ends the parent turn', () => {
        const ctx = startedContext();
        expect(
          mapOpenCodeEvent(partUpdated(textPart(OC_CHILD_SESSION, 'p_child', 'inner text')), ctx)
        ).toEqual([]);
        expect(mapOpenCodeEvent(sessionIdle(OC_CHILD_SESSION), ctx)).toEqual([]);
      });

      it('refuses a `sessionId` that names the parent session, whichever way it lies', () => {
        // Not reachable at 1.18.15 — but admitting the parent as its own child
        // would make the child path swallow the whole turn: text dropped,
        // completion misread as progress, `session.idle` dropped → never ends.
        for (const metadata of [
          { parentSessionId: OC, sessionId: OC },
          // A metadata bag whose `parentSessionId` lies: `part.sessionID` is the
          // structural truth and must still catch it.
          { parentSessionId: 'ses_elsewhere', sessionId: OC },
        ]) {
          const ctx = makeContext();
          mapOpenCodeEvent(
            partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input), metadata)),
            ctx
          );
          expect(
            matchesOpenCodeSubagentSession(globalEvent(DIRECTORY, sessionIdle(OC)), DIRECTORY, ctx)
          ).toBe(false);
          // The parent still speaks and still terminates.
          expect(mapOpenCodeEvent(partUpdated(textPart(OC, 'prt_1', 'parent text')), ctx)).toEqual([
            { type: 'text_delta', data: { text: 'parent text' } },
          ]);
          expect(mapOpenCodeEvent(sessionIdle(OC), ctx)).toEqual([
            { type: 'done', data: { sessionId: SESSION_ID } },
          ]);
        }
      });

      it('stops attributing child events once the subagent has finished', () => {
        const ctx = startedContext();
        mapOpenCodeEvent(
          partUpdated(
            taskToolPart(OC, 'call_task', toolStateCompleted(input, 'done'), taskToolMetadata())
          ),
          ctx
        );
        expect(
          mapOpenCodeEvent(
            partUpdated(toolPart(OC_CHILD_SESSION, 'child_9', 'grep', toolStateRunning({}))),
            ctx
          )
        ).toEqual([]);
      });
    });

    describe('terminal states', () => {
      function runningContext(): OpenCodeEventContext {
        const ctx = makeContext();
        mapOpenCodeEvent(
          partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input), taskToolMetadata())),
          ctx
        );
        mapOpenCodeEvent(
          partUpdated(toolPart(OC_CHILD_SESSION, 'child_1', 'grep', toolStateRunning({}))),
          ctx
        );
        return ctx;
      }

      it('maps completion to background_task_done with the observed tool count and duration', () => {
        const ctx = runningContext();
        const events = mapOpenCodeEvent(
          partUpdated(
            taskToolPart(OC, 'call_task', toolStateCompleted(input, 'result'), taskToolMetadata())
          ),
          ctx
        );
        const done = events.find((e) => e.type === 'background_task_done');
        expect(done!.data).toEqual({
          taskId: 'call_task',
          status: 'completed',
          toolUses: 1,
          durationMs: COMPLETED_AT - CREATED_AT,
        });
        expect(StreamEventSchema.safeParse(done).success).toBe(true);
      });

      it('maps a genuine failure to status failed', () => {
        const ctx = runningContext();
        const events = mapOpenCodeEvent(
          partUpdated(taskToolPart(OC, 'call_task', toolStateError(input, 'Agent not found'))),
          ctx
        );
        expect(events.find((e) => e.type === 'background_task_done')!.data).toMatchObject({
          status: 'failed',
        });
      });

      /** The `background_task_done` status a terminal task part is reported with. */
      function doneStatusFor(part: ToolPart): unknown {
        const events = mapOpenCodeEvent(partUpdated(part), runningContext());
        const done = events.find((e) => e.type === 'background_task_done');
        return (done!.data as { status: unknown }).status;
      }

      /**
       * Every stop-shape STRING the v1.18.15 wire actually carries. The first is
       * what a user pressing stop produces (`SessionProcessor.cleanup`); reading
       * it as a failure paints the feed red on an ordinary interrupt, which is
       * exactly what this mapping did when it anchored on the last one — the only
       * shape DorkOS cannot reach.
       */
      const STOP_SHAPES: Array<[string, string]> = [
        ['abort cleanup', 'Tool execution aborted'],
        ['failUnsettledTools', 'Tool execution interrupted'],
        ['wrapped TaskTool throw', 'Tool execution failed: Task cancelled'],
        // Live-captured when the stop lands while the subagent holds a
        // permission: the task tool settles its own part, so nothing wraps the
        // message and nothing stamps `interrupted` (DOR-1126).
        ['bare TaskTool throw', 'Task cancelled'],
        ['handleSubtask onInterrupt', 'Cancelled'],
      ];

      it.each(STOP_SHAPES)('maps the %s stop text to status stopped', (_name, error) => {
        const part = taskToolPart(
          OC,
          'call_task',
          toolStateError(input, error),
          taskToolMetadata()
        );
        expect(doneStatusFor(part)).toBe('stopped');
      });

      it('prefers the structural interrupted flag over unrecognized error text', () => {
        // The abort path stamps this flag; the text is deliberately one the
        // pattern does NOT match, so only the flag can produce `stopped`.
        const part = taskToolPart(OC, 'call_task', toolStateError(input, 'Provider exploded'), {
          ...taskToolMetadata(),
          interrupted: true,
        });
        expect(doneStatusFor(part)).toBe('stopped');
      });

      it('reads the interrupted flag off the part when the state metadata omits it', () => {
        // Upstream's own classifier falls back to part-level metadata.
        const part = taskToolPart(
          OC,
          'call_task',
          toolStateError(input, 'Provider exploded'),
          taskToolMetadata()
        );
        expect(doneStatusFor({ ...part, metadata: { interrupted: true } })).toBe('stopped');
      });

      it('does not read a falsy interrupted flag as a stop', () => {
        const part = taskToolPart(OC, 'call_task', toolStateError(input, 'Provider exploded'), {
          ...taskToolMetadata(),
          interrupted: false,
        });
        expect(doneStatusFor(part)).toBe('failed');
      });

      it('does not double-report a re-published completed task part', () => {
        const ctx = runningContext();
        const completed = partUpdated(
          taskToolPart(OC, 'call_task', toolStateCompleted(input, 'result'), taskToolMetadata())
        );
        mapOpenCodeEvent(completed, ctx);
        expect(mapOpenCodeEvent(completed, ctx)).toEqual([]);
      });

      it('reports a subagent that was never seen running (terminal-only snapshot)', () => {
        const events = mapOpenCodeEvent(
          partUpdated(taskToolPart(OC, 'call_task', toolStateCompleted(input, 'result'))),
          makeContext()
        );
        expect(events.map((e) => e.type)).toEqual([
          'tool_call_start',
          'tool_call_end',
          'tool_result',
          'background_task_started',
          'background_task_done',
        ]);
      });
    });
  });

  describe('permission.asked → approval_required', () => {
    it('maps the permission to a schema-valid approval keyed by the permission id', () => {
      const events = mapOpenCodeEvent(
        permissionAsked(
          permissionRequest(OC, {
            id: 'per_0001',
            permission: 'bash',
            patterns: ['rm *'],
            callID: 'call_1',
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
            input: '{"patterns":["rm *"],"command":"rm -rf dist"}',
            timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
            startedAt: expect.any(Number),
            hasSuggestions: false,
          },
        },
      ]);
      expect(StreamEventSchema.safeParse(events[0]).success).toBe(true);
    });

    it('omits patterns from input when the request carries none', () => {
      const events = mapOpenCodeEvent(
        permissionAsked(permissionRequest(OC, { patterns: [], metadata: { filePath: '/tmp/a' } })),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({ input: '{"filePath":"/tmp/a"}' });
    });

    it('maps permission.replied to interaction_cancelled so resolved-elsewhere cards clear', () => {
      const events = mapOpenCodeEvent(permissionReplied(OC, 'per_0001', 'once'), makeContext());
      expect(events).toEqual([
        { type: 'interaction_cancelled', data: { interactionId: 'per_0001', reason: 'approved' } },
      ]);
    });

    it('records where the answer must be sent — the session that asked', () => {
      const ctx = makeContext();
      mapOpenCodeEvent(permissionAsked(permissionRequest(OC, { id: 'per_0001' })), ctx);
      expect(ctx.pendingPermissionSessions.get('per_0001')).toBe(OC);
      mapOpenCodeEvent(permissionReplied(OC, 'per_0001', 'once'), ctx);
      expect(ctx.pendingPermissionSessions.has('per_0001')).toBe(false);
    });

    it('withdraws an ask nobody answered when the turn terminates', async () => {
      // The turn is over: `clearSession` has dropped the pending record, so the
      // card can no longer be answered. Leaving it on screen is a ghost.
      const events = await drain([
        permissionAsked(permissionRequest(OC, { id: 'per_0001' })),
        sessionIdle(OC),
      ]);
      expect(events.map((e) => e.type)).toEqual([
        'approval_required',
        'interaction_cancelled',
        'done',
      ]);
      expect(events[1]!.data).toEqual({ interactionId: 'per_0001' });
    });

    it('leaves an answered ask alone at the terminal — no second withdrawal', async () => {
      const events = await drain([
        permissionAsked(permissionRequest(OC, { id: 'per_0001' })),
        permissionReplied(OC, 'per_0001', 'once'),
        sessionIdle(OC),
      ]);
      expect(events.filter((e) => e.type === 'interaction_cancelled')).toHaveLength(1);
    });
  });

  describe("a subagent's permission prompts ride the parent's card (DOR-1126)", () => {
    const input = taskToolInput();

    /** A turn whose subagent is running, so its child session is admitted. */
    function startedContext(taskInput = input): OpenCodeEventContext {
      const ctx = makeContext();
      mapOpenCodeEvent(
        partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(taskInput), taskToolMetadata())),
        ctx
      );
      return ctx;
    }

    /** The child's `bash` ask, as the 1.18.15 wire raises it in the CHILD session. */
    function childAsk(id = 'per_child01'): OpenCodeWireEvent {
      return permissionAsked(
        permissionRequest(OC_CHILD_SESSION, {
          id,
          permission: 'bash',
          patterns: ['ls -F'],
          metadata: { command: 'ls -F' },
        })
      );
    }

    it('surfaces the ask on the parent turn, named for the subagent that raised it', () => {
      const ctx = startedContext();
      const events = mapOpenCodeEvent(childAsk(), ctx);
      expect(events).toEqual([
        {
          type: 'approval_required',
          data: {
            toolCallId: 'per_child01',
            toolName: 'bash',
            title: 'The explore subagent needs permission',
            input: '{"patterns":["ls -F"],"command":"ls -F"}',
            timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
            startedAt: expect.any(Number),
            hasSuggestions: false,
          },
        },
      ]);
      expect(StreamEventSchema.safeParse(events[0]).success).toBe(true);
    });

    it('routes the answer to the CHILD session, which is the only one that can take it', () => {
      const ctx = startedContext();
      mapOpenCodeEvent(childAsk(), ctx);
      expect(ctx.pendingPermissionSessions.get('per_child01')).toBe(OC_CHILD_SESSION);
    });

    it('still says a subagent is asking when the task named no agent type', () => {
      const ctx = startedContext({ prompt: 'go' });
      const events = mapOpenCodeEvent(childAsk(), ctx);
      expect(events[0]!.data).toMatchObject({ title: 'A subagent needs permission' });
    });

    it('falls back to the task description when the agent type is missing', () => {
      const ctx = startedContext({ prompt: 'go', description: 'survey the routes' });
      const events = mapOpenCodeEvent(childAsk(), ctx);
      expect(events[0]!.data).toMatchObject({
        title: 'The survey the routes subagent needs permission',
      });
    });

    it("clears the card when the child's ask is answered elsewhere", () => {
      const ctx = startedContext();
      mapOpenCodeEvent(childAsk(), ctx);
      expect(mapOpenCodeEvent(permissionReplied(OC_CHILD_SESSION, 'per_child01'), ctx)).toEqual([
        {
          type: 'interaction_cancelled',
          data: { interactionId: 'per_child01', reason: 'approved' },
        },
      ]);
    });

    it('ignores an ask from a child whose subagent already finished', () => {
      const ctx = startedContext();
      mapOpenCodeEvent(
        partUpdated(
          taskToolPart(OC, 'call_task', toolStateCompleted(input, 'done'), taskToolMetadata())
        ),
        ctx
      );
      expect(mapOpenCodeEvent(childAsk(), ctx)).toEqual([]);
    });

    it('withdraws an outstanding child ask when the user stops the turn', async () => {
      // The live stop ordering (fixtures/live-cancel.jsonl): the child dies
      // first, the parent's terminal lands next, and the `task` part's own
      // outcome arrives after it. Neither the ask nor the subagent may outlive
      // the turn — one would be an unanswerable card, the other a running
      // subagent nobody is watching (DOR-1146).
      const ctx = makeContext();
      const events = await drain(
        [
          partUpdated(taskToolPart(OC, 'call_task', toolStateRunning(input), taskToolMetadata())),
          childAsk(),
          sessionError(OC_CHILD_SESSION, abortedError()),
          sessionIdle(OC_CHILD_SESSION),
          sessionError(OC, abortedError()),
          sessionIdle(OC),
        ],
        ctx
      );
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'background_task_started',
        'approval_required',
        'interaction_cancelled',
        'background_task_done',
        'done',
      ]);
      expect(events[3]!.data).toEqual({ interactionId: 'per_child01' });
      expect(events[4]!.data).toMatchObject({ taskId: 'call_task', status: 'stopped' });
      expect(ctx.pendingPermissionSessions.size).toBe(0);
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

    it('answers a provider auth failure in DorkOS words naming OpenCode, keeping the provider text in details', () => {
      // DOR-1656: one voice for a dead sign-in across every runtime — and it
      // must name OPENCODE, never the runtime whose adapter the copy came from.
      const events = mapOpenCodeEvent(
        sessionError(OC, providerAuthError('anthropic', 'invalid api key')),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({
        message: 'Authentication failed. Re-authenticate OpenCode and try again.',
        code: 'ProviderAuthError',
        category: 'auth_error',
        details: 'invalid api key',
      });
    });

    it('tags a ProviderAuthError as auth_error via its name even when the message has no keyword', () => {
      // The provider message can be generic ("the provider ended the session"),
      // so classification must rely on the error NAME, not just message matching.
      const events = mapOpenCodeEvent(
        sessionError(OC, providerAuthError('anthropic', 'the provider ended the session')),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({
        message: 'Authentication failed. Re-authenticate OpenCode and try again.',
        code: 'ProviderAuthError',
        category: 'auth_error',
        details: 'the provider ended the session',
      });
    });

    it('keeps a non-auth session error as execution_error', () => {
      const events = mapOpenCodeEvent(
        sessionError(OC, unknownError('disk write failed')),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({ category: 'execution_error' });
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
    ['subagent delegation turn', () => opencodeSubagentTurn(OC)],
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

  it('maps a delegating turn to a subagent lifecycle without leaking the child session', async () => {
    const events = await drain(opencodeSubagentTurn(OC));
    expect(events.map((e) => e.type)).toEqual([
      'tool_call_start',
      'background_task_started',
      'background_task_progress',
      'background_task_progress',
      'tool_call_end',
      'tool_result',
      'background_task_done',
      'text_delta',
      'session_status',
      'done',
    ]);
    // The child's own text never reaches the transcript, and its session.idle
    // did not end the parent turn early (the single `done` is the parent's).
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    expect(text).toBe('The explorer found 3 routes.');
    expect(events.find((e) => e.type === 'background_task_done')!.data).toMatchObject({
      status: 'completed',
      toolUses: 2,
    });
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

  it('classifies a stream crash that is really a dead sign-in as auth_error (DOR-1656)', async () => {
    // A credential failure can surface as a THROW rather than a session.error,
    // and a hardcoded execution_error here leaves a person with no way back in.
    const vendorText = 'AuthenticationError: 401 invalid x-api-key';
    async function* crashing(): AsyncGenerator<OpenCodeWireEvent> {
      yield statusEvent(OC, { type: 'busy' });
      throw new Error(vendorText);
    }
    const events = await drain(crashing());
    expect(events[0]!.data).toMatchObject({
      message: 'Authentication failed. Re-authenticate OpenCode and try again.',
      code: 'stream_error',
      category: 'auth_error',
      details: vendorText,
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

  /**
   * The live wire delivers an aborted `task` part AFTER the parent's
   * `session.idle` — past the terminal the mapper returns on — so a stopped
   * subagent's only outcome event is never read (DOR-1146). The end-to-end
   * proof is `live-capture-replay.test.ts`, which replays the captured stop;
   * these pin the rule that fix turns on.
   */
  describe('closing subagents the wire left open', () => {
    const input = taskToolInput();

    /** A turn that opens `count` subagents and then hits the given tail. */
    function delegating(count: number, ...tail: OpenCodeWireEvent[]): OpenCodeWireEvent[] {
      const opens = Array.from({ length: count }, (_, index) =>
        partUpdated(
          taskToolPart(
            OC,
            `call_task_${index}`,
            toolStateRunning(input),
            taskToolMetadata(`ses_child000${index}`)
          )
        )
      );
      return [...opens, ...tail];
    }

    it('reports a subagent still open at session.idle as stopped, before the done', async () => {
      const events = await drain(delegating(1, sessionIdle(OC)));
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'background_task_started',
        'background_task_done',
        'done',
      ]);
      expect(events[2]!.data).toEqual({ taskId: 'call_task_0', status: 'stopped' });
      expect(StreamEventSchema.safeParse(events[2]).success).toBe(true);
    });

    it('closes every open subagent, carrying the tool count each one reported', async () => {
      const ctx = makeContext();
      const events = await drain(
        [
          ...delegating(2),
          partUpdated(toolPart('ses_child0001', 'child_1', 'grep', toolStateRunning({}))),
          sessionIdle(OC),
        ],
        ctx
      );
      const closed = events.filter((e) => e.type === 'background_task_done').map((e) => e.data);
      expect(closed).toEqual([
        { taskId: 'call_task_0', status: 'stopped' },
        { taskId: 'call_task_1', status: 'stopped', toolUses: 1 },
      ]);
    });

    it('leaves a subagent that already terminated alone', async () => {
      const events = await drain(opencodeSubagentTurn(OC));
      expect(events.filter((e) => e.type === 'background_task_done')).toHaveLength(1);
      expect(events.find((e) => e.type === 'background_task_done')!.data).toMatchObject({
        status: 'completed',
      });
    });

    it('claims nothing when the stream ends without a session.idle', async () => {
      // No turn terminal means DorkOS stopped watching, not that the turn ended
      // — the child may still be working, so the normalizer's end-of-stream
      // sweep gets to call it `untracked` (DOR-1108) instead of `stopped`.
      const events = await drain(delegating(1));
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'background_task_started',
        'done',
      ]);
    });

    it('claims nothing when the sidecar dies mid-turn', async () => {
      const ctx = makeContext();
      async function* crashing(): AsyncGenerator<OpenCodeWireEvent> {
        for (const event of delegating(1)) yield event;
        throw new Error('sidecar exited unexpectedly');
      }
      const events = await drain(crashing(), ctx);
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'background_task_started',
        'error',
        'done',
      ]);
    });

    it('claims nothing when the subscription is torn down (AbortError)', async () => {
      async function* aborting(): AsyncGenerator<OpenCodeWireEvent> {
        for (const event of delegating(1)) yield event;
        throw new DOMException('Aborted', 'AbortError');
      }
      const events = await drain(aborting());
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'background_task_started',
        'done',
      ]);
    });
  });
});
