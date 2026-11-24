/**
 * event-mapper: permissions and errors. Shared setup lives in `./event-mapper.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import { SESSIONS } from '../../../../../config/constants.js';
import { mapOpenCodeEvent } from '../../events/event-mapper.js';
import {
  COMPLETED_AT,
  CREATED_AT,
  DEFAULT_COST,
  assistantMessage,
  messageUpdated,
  permissionAsked,
  permissionReplied,
  permissionRequest,
  providerAuthError,
  sessionCompacted,
  sessionError,
  sessionIdle,
  todo,
  todoUpdated,
  unknownError,
} from '../opencode-sse-fixtures.js';
import { SESSION_ID, OC, makeContext, drain } from './event-mapper.fixtures.js';

describe('mapOpenCodeEvent', () => {
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

    it('maps permission.replied to interaction_cancelled so resolved-elsewhere cards clear', () => {
      const events = mapOpenCodeEvent(permissionReplied(OC, 'per_0001', 'once'), makeContext());
      expect(events).toEqual([
        { type: 'interaction_cancelled', data: { interactionId: 'per_0001', reason: 'approved' } },
      ]);
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
  });
});

describe('mapOpenCodeEvent', () => {
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

    it('answers a provider auth failure in DorkOS words naming OpenCode, keeping the provider text in details', () => {
      // DOR-1656: one voice for a dead sign-in across every runtime — and it
      // must name OPENCODE, never the runtime whose adapter the copy came from.
      const events = mapOpenCodeEvent(
        sessionError(OC, providerAuthError('anthropic', 'invalid api key')),
        makeContext()
      );
      expect(events[0]!.data).toMatchObject({
        message:
          "OpenCode's model provider stopped accepting its sign-in. Choose a model provider to keep going.",
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
        message:
          "OpenCode's model provider stopped accepting its sign-in. Choose a model provider to keep going.",
        code: 'ProviderAuthError',
        category: 'auth_error',
        details: 'the provider ended the session',
      });
    });
  });
});

describe('mapOpenCodeEvent', () => {
  describe('turn end and session bookkeeping', () => {
    it('maps session.idle to the terminal done stamped with the DORKOS session id', () => {
      expect(mapOpenCodeEvent(sessionIdle(OC), makeContext())).toEqual([
        { type: 'done', data: { sessionId: SESSION_ID } },
      ]);
    });

    it('RT-COST-01: maps a completed assistant message to a usage session_status', () => {
      const events = mapOpenCodeEvent(
        messageUpdated(assistantMessage(OC, { completed: true })),
        makeContext()
      );
      expect(events).toMatchObject([
        {
          type: 'model_request',
          data: { phase: 'end', startedAt: CREATED_AT, endedAt: COMPLETED_AT },
        },
        {
          type: 'session_status',
          data: {
            sessionId: SESSION_ID,
            model: 'claude-sonnet-4-5',
            costUsd: DEFAULT_COST,
            // input 120 + cache read 80 + cache write 12: the whole prompt.
            contextTokens: 212,
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

    it('maps session.compacted to operation_progress done + a compact_boundary marker (DOR-110)', () => {
      // OpenCode reports compaction as a single post-hoc completion — honest
      // degradation is a lone operation_progress `done` (no start/percent) plus
      // the durable boundary row.
      expect(mapOpenCodeEvent(sessionCompacted(OC), makeContext())).toMatchObject([
        {
          type: 'operation_progress',
          data: { operation: 'compaction', state: 'done', determinate: false },
        },
        { type: 'compact_boundary', data: {} },
      ]);
    });
  });
});

describe('mapOpenCodeEvent', () => {
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
  });
});
