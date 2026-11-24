/**
 * event-mapper: subagents. Shared setup lives in `./event-mapper.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import { SESSIONS } from '../../../../../config/constants.js';
import {
  mapOpenCodeEvent,
  matchesOpenCodeSubagentSession,
  type OpenCodeEventContext,
  type OpenCodeWireEvent,
} from '../../events/event-mapper.js';
import {
  COMPLETED_AT,
  CREATED_AT,
  DIRECTORY,
  OC_CHILD_SESSION,
  abortedError,
  globalEvent,
  partUpdated,
  permissionAsked,
  permissionReplied,
  permissionRequest,
  sessionError,
  sessionIdle,
  taskToolInput,
  taskToolMetadata,
  taskToolPart,
  textPart,
  toolPart,
  toolStateCompleted,
  toolStateRunning,
} from '../opencode-sse-fixtures.js';
import { SESSION_ID, OC, makeContext, drain } from './event-mapper.fixtures.js';

describe('mapOpenCodeEvent', () => {
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

      it('refuses a `sessionId` that names the parent session, whichever way it lies', () => {
        // Still unreachable at v1.18.30 — the task tool creates the child with
        // `parentID: ctx.sessionID` and then publishes
        // `{parentSessionId: ctx.sessionID, sessionId: nextSession.id}`
        // (`packages/opencode/src/tool/task.ts:159,185-190`), so the two ids
        // cannot be equal. Re-checked because 1.18.20 invalidated exactly this
        // class of claim elsewhere in this file. Admitting the parent as its own child
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
    });
  });
});

describe('mapOpenCodeEvent', () => {
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
});
