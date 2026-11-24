/**
 * event-mapper: routing. Shared setup lives in `./event-mapper.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  createOpenCodeEventContext,
  extractOpenCodeSessionId,
  mapOpenCodeEvent,
  matchesOpenCodeSession,
  matchesOpenCodeSubagentSession,
  type OpenCodeEventContext,
  type OpenCodeWireEvent,
} from '../../events/event-mapper.js';
import {
  DIRECTORY,
  OC_CHILD_SESSION,
  OC_SESSION_A,
  OC_SESSION_B,
  OTHER_DIRECTORY,
  assistantMessage,
  fakeGlobalEventStream,
  globalEvent,
  interleavedGlobalStream,
  messageUpdated,
  partDelta,
  partUpdated,
  reasoningPart,
  sessionIdle,
  taskToolInput,
  taskToolMetadata,
  taskToolPart,
  textPart,
  toolPart,
  toolStateCompleted,
  toolStateError,
  toolStateRunning,
  userMessage,
} from '../opencode-sse-fixtures.js';
import { OC, makeContext, drain } from './event-mapper.fixtures.js';

describe('extractOpenCodeSessionId', () => {
  it('keys part updates by the part sessionID and messages by the info sessionID', () => {
    expect(extractOpenCodeSessionId(partUpdated(textPart(OC, 'p1', 'hi')))).toBe(OC);
    expect(extractOpenCodeSessionId(messageUpdated(assistantMessage(OC)))).toBe(OC);
    expect(extractOpenCodeSessionId(messageUpdated(userMessage(OC)))).toBe(OC);
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
      expect(mapOpenCodeEvent(partDelta(OC, 'p1', 'Hel'), ctx)).toMatchObject([
        { type: 'model_request', data: { phase: 'first_token', firstTokenAt: expect.any(Number) } },
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

    it('maps reasoning parts and their deltas to thinking_delta', () => {
      const ctx = makeContext();
      expect(mapOpenCodeEvent(partUpdated(reasoningPart(OC, 'r1', '')), ctx)).toEqual([]);
      expect(mapOpenCodeEvent(partDelta(OC, 'r1', 'Think'), ctx)).toMatchObject([
        { type: 'model_request', data: { phase: 'first_token', firstTokenAt: expect.any(Number) } },
        { type: 'thinking_delta', data: { text: 'Think' } },
      ]);
      expect(
        mapOpenCodeEvent(partUpdated(reasoningPart(OC, 'r1', 'Thinking...', { end: true })), ctx)
      ).toEqual([{ type: 'thinking_delta', data: { text: 'ing...' } }]);
    });
  });
});

describe('mapOpenCodeEvent', () => {
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
  });
});

describe('mapOpenCodeEvent', () => {
  describe('tool parts → tool events', () => {
    const input = { command: 'ls -la' };

    it('maps running to tool_call_start keyed by callID with the tool name and JSON input', () => {
      const events = mapOpenCodeEvent(
        partUpdated(toolPart(OC, 'call_1', 'bash', toolStateRunning(input))),
        makeContext()
      );
      expect(events).toMatchObject([
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
      expect(events).toMatchObject([
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
  });
});
