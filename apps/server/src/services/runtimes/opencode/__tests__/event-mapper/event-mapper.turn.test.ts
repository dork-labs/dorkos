/**
 * event-mapper: turn. Shared setup lives in `./event-mapper.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import { type OpenCodeWireEvent } from '../../events/event-mapper.js';
import {
  opencodeAbortedTurn,
  opencodeApprovalTurn,
  opencodeErrorTurn,
  opencodeSimpleTurn,
  opencodeSubagentTurn,
  opencodeToolTurn,
  partUpdated,
  sessionIdle,
  statusEvent,
  taskToolInput,
  taskToolMetadata,
  taskToolPart,
  toolStateRunning,
} from '../opencode-sse-fixtures.js';
import { OpenCodeStreamLostError } from '../../events/global-event-hub.js';
import { OC, drain } from './event-mapper.fixtures.js';

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
      'model_request',
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

  it('RT-TOOL-01: surfaces the approval flow mid-turn and resolves it before the tool events', async () => {
    const events = await drain(opencodeApprovalTurn(OC));
    expect(events.map((e) => e.type)).toEqual([
      'approval_required',
      'interaction_cancelled',
      'tool_call_start',
      'tool_call_end',
      'text_delta',
      'model_request',
      'session_status',
      'done',
    ]);
  });

  it('maps a failed turn to a typed error followed by the session.idle done', async () => {
    const events = await drain(opencodeErrorTurn(OC, 'boom'));
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]!.data).toMatchObject({ message: 'boom', code: 'UnknownError' });
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
      message:
        "OpenCode's model provider stopped accepting its sign-in. Choose a model provider to keep going.",
      code: 'stream_error',
      category: 'auth_error',
      details: vendorText,
    });
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
  });

  it('keeps the sign-in copy when a lost stream was really a dead sign-in (DOR-2717)', async () => {
    // The plain "stopped responding" notice is for a lost sidecar only; a
    // sign-in failure keeps the copy that says how to get back in.
    const vendorText = 'AuthenticationError: 401 invalid x-api-key';
    async function* crashing(): AsyncGenerator<OpenCodeWireEvent> {
      yield statusEvent(OC, { type: 'busy' });
      throw new OpenCodeStreamLostError(new Error(vendorText));
    }
    const events = await drain(crashing());
    expect(events[0]!.data).toMatchObject({ category: 'auth_error', details: vendorText });
  });
});
