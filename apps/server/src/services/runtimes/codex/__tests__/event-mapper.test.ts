import { describe, it, expect, vi } from 'vitest';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ThreadEvent } from '@openai/codex-sdk';
import {
  createCodexEventContext,
  mapCodexEvent,
  mapCodexThread,
  type CodexEventContext,
} from '../event-mapper.js';
import {
  DEFAULT_USAGE,
  agentMessageItem,
  codexCommandTurn,
  codexFailedTurn,
  codexFailedTurnWithErrorItem,
  codexItemCompleted,
  codexItemStarted,
  codexItemUpdated,
  codexMcpTurn,
  codexRecoveredTurn,
  codexSimpleTurn,
  codexStreamErrorTurn,
  codexThreadStarted,
  codexTurnCompleted,
  codexTurnFailed,
  commandExecutionItem,
  fileChangeItem,
  mcpToolCallItem,
  reasoningItem,
  todoListItem,
  toEventStream,
} from './codex-scenarios.js';

const SESSION_ID = 'session-1';
const CODEX_UPDATE_ERROR =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}';
const CHATGPT_MODEL_ERROR =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}}';

function makeContext(): CodexEventContext {
  return createCodexEventContext(SESSION_ID);
}

async function drain(
  events: ThreadEvent[] | AsyncGenerator<ThreadEvent>,
  ctx = makeContext()
): Promise<StreamEvent[]> {
  const stream = Array.isArray(events) ? toEventStream(events) : events;
  const out: StreamEvent[] = [];
  for await (const event of mapCodexThread(stream, ctx)) out.push(event);
  return out;
}

describe('mapCodexEvent', () => {
  describe('thread lifecycle', () => {
    it('records the thread id from thread.started and emits nothing', () => {
      const ctx = makeContext();
      const events = mapCodexEvent(codexThreadStarted('t-9'), ctx);
      expect(events).toEqual([]);
      expect(ctx.threadId).toBe('t-9');
    });
  });

  describe('agent_message → text_delta', () => {
    it('emits suffix deltas for cumulative text snapshots', () => {
      const ctx = makeContext();
      expect(mapCodexEvent(codexItemStarted(agentMessageItem('m1', '')), ctx)).toEqual([]);
      expect(mapCodexEvent(codexItemUpdated(agentMessageItem('m1', 'Hel')), ctx)).toEqual([
        { type: 'text_delta', data: { text: 'Hel' } },
      ]);
      expect(mapCodexEvent(codexItemUpdated(agentMessageItem('m1', 'Hello wor')), ctx)).toEqual([
        { type: 'text_delta', data: { text: 'lo wor' } },
      ]);
      expect(mapCodexEvent(codexItemCompleted(agentMessageItem('m1', 'Hello world')), ctx)).toEqual(
        [{ type: 'text_delta', data: { text: 'ld' } }]
      );
    });
  });

  describe('reasoning → thinking_delta', () => {
    it('emits suffix deltas as thinking_delta events', () => {
      const ctx = makeContext();
      expect(mapCodexEvent(codexItemUpdated(reasoningItem('r1', 'Think')), ctx)).toEqual([
        { type: 'thinking_delta', data: { text: 'Think' } },
      ]);
      expect(mapCodexEvent(codexItemCompleted(reasoningItem('r1', 'Thinking...')), ctx)).toEqual([
        { type: 'thinking_delta', data: { text: 'ing...' } },
      ]);
    });
  });

  describe('command_execution → tool events', () => {
    it('maps started to tool_call_start with the command as input', () => {
      const ctx = makeContext();
      const events = mapCodexEvent(
        codexItemStarted(commandExecutionItem('c1', { command: 'ls -la' })),
        ctx
      );
      expect(events).toMatchObject([
        {
          type: 'tool_call_start',
          data: {
            toolCallId: 'c1',
            toolName: 'Shell',
            input: '{"command":"ls -la"}',
            status: 'running',
          },
        },
      ]);
    });

    it('maps successful completion to tool_call_end + tool_result', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemStarted(commandExecutionItem('c1', { command: 'ls' })), ctx);
      const events = mapCodexEvent(
        codexItemCompleted(
          commandExecutionItem('c1', {
            command: 'ls',
            output: 'file1\n',
            status: 'completed',
            exitCode: 0,
          })
        ),
        ctx
      );
      expect(events).toMatchObject([
        {
          type: 'tool_call_end',
          data: { toolCallId: 'c1', toolName: 'Shell', status: 'complete' },
        },
        {
          type: 'tool_result',
          data: { toolCallId: 'c1', toolName: 'Shell', result: 'file1\n', status: 'complete' },
        },
      ]);
    });

    it('maps failed completion to error-status tool events, not a silent drop', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemStarted(commandExecutionItem('c1', { command: 'boom' })), ctx);
      const events = mapCodexEvent(
        codexItemCompleted(
          commandExecutionItem('c1', {
            command: 'boom',
            output: 'command not found\n',
            status: 'failed',
            exitCode: 127,
          })
        ),
        ctx
      );
      expect(events.map((e) => e.type)).toEqual(['tool_call_end', 'tool_result']);
      expect(events[0]!.data).toMatchObject({ status: 'error' });
      expect(events[1]!.data).toMatchObject({ status: 'error', result: 'command not found\n' });
    });
  });

  describe('mcp_tool_call → tool events', () => {
    it('uses the mcp__server__tool naming convention and JSON arguments', () => {
      const ctx = makeContext();
      const events = mapCodexEvent(
        codexItemStarted(
          mcpToolCallItem('m1', { server: 'linear', tool: 'create_issue', args: { title: 'T' } })
        ),
        ctx
      );
      expect(events).toMatchObject([
        {
          type: 'tool_call_start',
          data: {
            toolCallId: 'm1',
            toolName: 'mcp__linear__create_issue',
            input: '{"title":"T"}',
            status: 'running',
          },
        },
      ]);
    });

    it('maps success to tool_call_end + tool_result with extracted text', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemStarted(mcpToolCallItem('m1')), ctx);
      const events = mapCodexEvent(
        codexItemCompleted(mcpToolCallItem('m1', { status: 'completed', resultText: 'created' })),
        ctx
      );
      expect(events).toMatchObject([
        {
          type: 'tool_call_end',
          data: { toolCallId: 'm1', toolName: 'mcp__linear__create_issue', status: 'complete' },
        },
        {
          type: 'tool_result',
          data: {
            toolCallId: 'm1',
            toolName: 'mcp__linear__create_issue',
            result: 'created',
            status: 'complete',
          },
        },
      ]);
    });
  });

  describe('control_ui is an ordinary MCP tool call now', () => {
    /**
     * The `dorkos_ui` retirement, asserted where it could regress (spec
     * `canvas-agent-seat` §5).
     *
     * This mapper used to intercept a `control_ui` call on a scoped `dorkos_ui`
     * server and turn it into a `ui_command` itself, because that server's
     * handler was a stub with no session in scope and could produce no effect.
     * `control_ui` is a `ui` capability on the `dorkos` server now, with a real
     * session behind it: the handler applies the command, stamps what it wrote,
     * and answers the model. So the mapper must leave it alone — a second
     * `ui_command` from here would apply every Codex canvas operation twice.
     */
    it('renders a control_ui call like any other MCP tool call, and emits no ui_command', () => {
      const ctx = makeContext();
      const item = mcpToolCallItem('ui-1', {
        server: 'dorkos',
        tool: 'control_ui',
        args: { action: 'open_canvas', content: { type: 'markdown', content: '# hi' } },
        status: 'completed',
      });

      const events = mapCodexEvent(codexItemCompleted(item), ctx);

      expect(events.some((e) => e.type === 'ui_command')).toBe(false);
      // No `tool_result`: this fixture's item carries no result text, and the
      // generic mapper emits one only when there is something to show. The two
      // call events are what says it went down the ORDINARY path.
      expect(events.map((e) => e.type)).toEqual(['tool_call_start', 'tool_call_end']);
      expect(events[0]!.data).toMatchObject({ toolName: 'mcp__dorkos__control_ui' });
    });
  });

  describe('file_change → tool events', () => {
    it('maps a completed patch to start + end + human-readable result', () => {
      const ctx = makeContext();
      const events = mapCodexEvent(
        codexItemCompleted(
          fileChangeItem('f1', [
            { path: 'src/a.ts', kind: 'update' },
            { path: 'src/b.ts', kind: 'add' },
          ])
        ),
        ctx
      );
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'tool_call_end',
        'tool_result',
      ]);
      expect(events[2]!.data).toMatchObject({
        toolCallId: 'f1',
        toolName: 'ApplyPatch',
        result: 'update src/a.ts\nadd src/b.ts',
        status: 'complete',
      });
    });
  });

  describe('todo_list → task_update', () => {
    it('maps the running todo list to a task snapshot', () => {
      const ctx = makeContext();
      const events = mapCodexEvent(
        codexItemUpdated(
          todoListItem('t1', [
            { text: 'step 1', completed: true },
            { text: 'step 2', completed: false },
          ])
        ),
        ctx
      );
      expect(events).toEqual([
        {
          type: 'task_update',
          data: {
            action: 'snapshot',
            task: { id: '1', subject: 'step 1', status: 'completed' },
            tasks: [
              { id: '1', subject: 'step 1', status: 'completed' },
              { id: '2', subject: 'step 2', status: 'pending' },
            ],
          },
        },
      ]);
    });

    it('propagates a clearing snapshot when a rendered list is emptied', () => {
      const ctx = makeContext();
      // Render a non-empty list first.
      const first = mapCodexEvent(
        codexItemUpdated(todoListItem('t1', [{ text: 'step 1', completed: false }])),
        ctx
      );
      expect(first).toHaveLength(1);

      // Emptying it now emits a real clear (empty tasks array), not nothing.
      const cleared = mapCodexEvent(codexItemUpdated(todoListItem('t1', [])), ctx);
      expect(cleared).toEqual([
        {
          type: 'task_update',
          data: {
            action: 'snapshot',
            task: { id: '0', subject: '', status: 'pending' },
            tasks: [],
          },
        },
      ]);
    });
  });

  describe('errors and turn end', () => {
    it('keeps SDK output and cache totals but omits its cumulative input from context', () => {
      const events = mapCodexEvent(codexTurnCompleted(DEFAULT_USAGE), makeContext());
      expect(events).toEqual([
        {
          type: 'session_status',
          data: {
            sessionId: SESSION_ID,
            // 45 output + 10 reasoning tokens folded in (DEFAULT_USAGE).
            outputTokens: 55,
            cacheReadTokens: 80,
            terminalReason: 'completed',
          },
        },
        { type: 'done', data: { sessionId: SESSION_ID } },
      ]);
    });

    it('maps verified native current-context usage onto a completed turn', () => {
      const events = mapCodexEvent(codexTurnCompleted(DEFAULT_USAGE), makeContext(), {
        contextTokens: 54_999,
        contextMaxTokens: 258_400,
      });

      expect(events[0]?.data).toMatchObject({
        contextTokens: 54_999,
        contextMaxTokens: 258_400,
        outputTokens: 55,
        cacheReadTokens: 80,
      });
    });

    it('maps turn.failed to an error-reason session_status, a typed error, and terminal done', () => {
      const events = mapCodexEvent(codexTurnFailed('model exploded'), makeContext());
      expect(events).toEqual([
        {
          type: 'session_status',
          data: { sessionId: SESSION_ID, terminalReason: 'error' },
        },
        {
          type: 'error',
          data: { message: 'model exploded', code: 'turn_failed', category: 'execution_error' },
        },
        { type: 'done', data: { sessionId: SESSION_ID } },
      ]);
    });

    it('answers an auth failure in DorkOS words naming Codex, keeping the CLI text in details', () => {
      // DOR-1656: one voice for a dead sign-in across every runtime — and it
      // must name CODEX, never the runtime whose adapter the copy came from.
      const vendorText = '401 Unauthorized: your access token has been revoked';
      const events = mapCodexEvent(codexTurnFailed(vendorText), makeContext());
      const error = events.find((e) => e.type === 'error');
      expect(error?.data).toMatchObject({
        message: 'Your Codex sign-in stopped working. Sign in again to keep going.',
        code: 'turn_failed',
        category: 'auth_error',
        details: vendorText,
      });
    });

    it('maps a nested model/version rejection to actionable copy with raw details', () => {
      const events = mapCodexEvent(codexTurnFailed(CODEX_UPDATE_ERROR), makeContext());
      expect(events[1]).toEqual({
        type: 'error',
        data: {
          message:
            'The Codex version DorkOS is using is too old for gpt-6-astra. Update DorkOS (or your custom Codex installation), then try again. You can also choose another model.',
          code: 'turn_failed',
          category: 'runtime_update_required',
          details: CODEX_UPDATE_ERROR,
        },
      });
    });

    it('does not misclassify a ChatGPT model rejection as a sign-in failure', () => {
      const events = mapCodexEvent(codexTurnFailed(CHATGPT_MODEL_ERROR), makeContext());
      expect(events[1]?.data).toEqual({
        message:
          'gpt-5.4 isn’t available with a ChatGPT account. Choose another model from the model menu.',
        code: 'turn_failed',
        category: 'model_unavailable',
        details: CHATGPT_MODEL_ERROR,
      });
    });
  });
});

describe('mapCodexThread', () => {
  const FULL_TURNS: Array<[string, () => ThreadEvent[]]> = [
    ['simple text turn', () => codexSimpleTurn('Hello world')],
    ['command execution turn', () => codexCommandTurn('ls', 'file1\nfile2\n', 'Two files.')],
    ['mcp tool call turn', () => codexMcpTurn()],
    ['failed turn', () => codexFailedTurn('boom')],
    ['failed turn with preceding error item', () => codexFailedTurnWithErrorItem('boom')],
    ['recovered turn after stream errors', () => codexRecoveredTurn('All good.')],
    ['stream dying after a stream-level error', () => codexStreamErrorTurn('gone')],
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
      // Codex exec mode has no approval surface (NOTES.md, Verdict 1).
      expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    }
  );

  it("announces a usage limit the rollout shows before the turn's done", async () => {
    const readTurnContextUsage = vi.fn(async () => ({
      context: null,
      rateLimits: [
        {
          limit_id: 'codex',
          primary: { used_percent: 100, window_minutes: 10080, resets_at: 1789243480 },
          rate_limit_reached_type: null,
        },
      ],
    }));
    const ctx = createCodexEventContext(SESSION_ID, { readTurnContextUsage, now: () => 0 });
    const turn = codexSimpleTurn('done');
    turn[0] = codexThreadStarted('01a082ce-2b72-71d2-be38-aa8425f13650');

    const events = await drain(turn, ctx);
    const limitIndex = events.findIndex(
      (event) => event.type === 'session_status' && 'limit' in event.data
    );

    expect(limitIndex).toBeGreaterThan(-1);
    expect(events[limitIndex]!.data).toMatchObject({
      sessionId: SESSION_ID,
      limit: { window: 'seven_day', resetsAt: new Date(1789243480 * 1000).toISOString() },
    });
    expect(events.at(-1)?.type).toBe('done');
    expect(limitIndex).toBe(events.length - 2);
  });

  it('classifies a stream crash that is really a dead sign-in as auth_error (DOR-1656)', async () => {
    // A credential failure can surface as a THROW rather than a turn.failed,
    // and a hardcoded execution_error here leaves a person with no way back in.
    const vendorText = 'Error: 401 Unauthorized — your Codex access token has been revoked';
    async function* crashingStream(): AsyncGenerator<ThreadEvent> {
      yield codexThreadStarted();
      throw new Error(vendorText);
    }
    const events = await drain(crashingStream());
    expect(events[0]!.data).toMatchObject({
      message: 'Your Codex sign-in stopped working. Sign in again to keep going.',
      code: 'stream_error',
      category: 'auth_error',
      details: vendorText,
    });
  });

  it('speaks DorkOS words when the error ITEM is the dead sign-in (DOR-1656)', async () => {
    // This is the shape live traffic takes: the error item carries the failure
    // and `turn.failed` repeats it, so the item's copy is the ONLY copy a person
    // sees — the turn.failed branch dedupes itself away. Getting turn.failed
    // right and leaving this raw would fix nothing in practice.
    const vendorText = '401 Unauthorized: your access token has been revoked';
    const events = await drain(codexFailedTurnWithErrorItem(vendorText));
    expect(events.map((e) => e.type)).toEqual(['error', 'session_status', 'done']);
    expect(events[0]!.data).toMatchObject({
      message: 'Your Codex sign-in stopped working. Sign in again to keep going.',
      code: 'item_error',
      category: 'auth_error',
      details: vendorText,
    });
  });

  it('still catches a TERMINAL auth failure whose wording is too vague for the item channel', () => {
    // The narrowing above is a channel rule, not a weaker classifier: the same
    // words on `turn.failed` are the turn's own verdict and still translate.
    const vendorText = 'Failed to authenticate: your ChatGPT session could not be refreshed';
    const events = mapCodexEvent(codexTurnFailed(vendorText), makeContext());
    const error = events.find((e) => e.type === 'error');
    expect(error?.data).toMatchObject({
      message: 'Your Codex sign-in stopped working. Sign in again to keep going.',
      category: 'auth_error',
      details: vendorText,
    });
  });
});
