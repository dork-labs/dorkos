import { describe, it, expect } from 'vitest';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ThreadEvent } from '@openai/codex-sdk';
import {
  createCodexEventContext,
  mapCodexEvent,
  mapCodexThread,
  type CodexEventContext,
} from '../event-mapper.js';
import { CODEX_UI_MCP_SERVER } from '../codex-ui-mcp-server.js';
import {
  DEFAULT_USAGE,
  agentMessageItem,
  codexAbortedTurn,
  codexCommandTurn,
  codexFailedTurn,
  codexFailedTurnWithErrorItem,
  codexItemCompleted,
  codexItemStarted,
  codexItemUpdated,
  codexMcpTurn,
  codexRecoveredTurn,
  codexSimpleTurn,
  codexStreamError,
  codexStreamErrorTurn,
  codexThreadStarted,
  codexTurnCompleted,
  codexTurnFailed,
  codexTurnStarted,
  commandExecutionItem,
  errorThreadItem,
  fileChangeItem,
  mcpToolCallItem,
  reasoningItem,
  todoListItem,
  toEventStream,
  webSearchItem,
} from './codex-scenarios.js';

const SESSION_ID = 'session-1';

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

    it('emits nothing for turn.started', () => {
      expect(mapCodexEvent(codexTurnStarted(), makeContext())).toEqual([]);
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

    it('emits the full new text when a snapshot is not a prefix extension', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemUpdated(agentMessageItem('m1', 'Hello')), ctx);
      expect(mapCodexEvent(codexItemUpdated(agentMessageItem('m1', 'Goodbye')), ctx)).toEqual([
        { type: 'text_delta', data: { text: 'Goodbye' } },
      ]);
    });

    it('emits one full text_delta for a completed-only agent_message', () => {
      const ctx = makeContext();
      expect(mapCodexEvent(codexItemCompleted(agentMessageItem('m1', 'All at once')), ctx)).toEqual(
        [{ type: 'text_delta', data: { text: 'All at once' } }]
      );
    });

    it('emits nothing when a completed snapshot adds no new text', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemUpdated(agentMessageItem('m1', 'Full text')), ctx);
      expect(mapCodexEvent(codexItemCompleted(agentMessageItem('m1', 'Full text')), ctx)).toEqual(
        []
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
      expect(events).toEqual([
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

    it('maps updated aggregated_output to incremental tool_progress', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemStarted(commandExecutionItem('c1', { command: 'ls' })), ctx);
      expect(
        mapCodexEvent(
          codexItemUpdated(commandExecutionItem('c1', { command: 'ls', output: 'file1\n' })),
          ctx
        )
      ).toEqual([{ type: 'tool_progress', data: { toolCallId: 'c1', content: 'file1\n' } }]);
      expect(
        mapCodexEvent(
          codexItemUpdated(commandExecutionItem('c1', { command: 'ls', output: 'file1\nfile2\n' })),
          ctx
        )
      ).toEqual([{ type: 'tool_progress', data: { toolCallId: 'c1', content: 'file2\n' } }]);
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
      expect(events).toEqual([
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

    it('synthesizes tool_call_start when completion arrives without a start', () => {
      const ctx = makeContext();
      const events = mapCodexEvent(
        codexItemCompleted(
          commandExecutionItem('c1', { command: 'ls', output: 'ok', status: 'completed' })
        ),
        ctx
      );
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'tool_call_end',
        'tool_result',
      ]);
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
      expect(events).toEqual([
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

    it('emits nothing for in-progress mcp updates', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemStarted(mcpToolCallItem('m1')), ctx);
      expect(mapCodexEvent(codexItemUpdated(mcpToolCallItem('m1')), ctx)).toEqual([]);
    });

    it('maps success to tool_call_end + tool_result with extracted text', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemStarted(mcpToolCallItem('m1')), ctx);
      const events = mapCodexEvent(
        codexItemCompleted(mcpToolCallItem('m1', { status: 'completed', resultText: 'created' })),
        ctx
      );
      expect(events).toEqual([
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

    it('maps failure to error-status tool events carrying the error message', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemStarted(mcpToolCallItem('m1')), ctx);
      const events = mapCodexEvent(
        codexItemCompleted(
          mcpToolCallItem('m1', { status: 'failed', errorMessage: 'server unreachable' })
        ),
        ctx
      );
      expect(events.map((e) => e.type)).toEqual(['tool_call_end', 'tool_result']);
      expect(events[0]!.data).toMatchObject({ status: 'error' });
      expect(events[1]!.data).toMatchObject({ status: 'error', result: 'server unreachable' });
    });
  });

  describe('control_ui → ui_command (canvas parity)', () => {
    const openCanvasArgs = {
      action: 'open_canvas',
      content: { type: 'markdown', content: '# hi' },
    };

    function controlUiItem(
      id: string,
      opts: { args?: unknown; status?: 'in_progress' | 'completed' | 'failed' } = {}
    ) {
      return mcpToolCallItem(id, {
        server: CODEX_UI_MCP_SERVER,
        tool: 'control_ui',
        args: opts.args ?? openCanvasArgs,
        ...(opts.status ? { status: opts.status } : {}),
      });
    }

    it('translates a completed dorkos_ui control_ui call into exactly one ui_command and no tool events', () => {
      const events = mapCodexEvent(
        codexItemCompleted(controlUiItem('ui-1', { status: 'completed' })),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'ui_command',
          data: {
            command: { action: 'open_canvas', content: { type: 'markdown', content: '# hi' } },
          },
        },
      ]);
      expect(events.some((e) => e.type.startsWith('tool_call'))).toBe(false);
      expect(events.some((e) => e.type === 'tool_result')).toBe(false);
    });

    it('emits nothing on the started and updated phases (fires once, on terminal)', () => {
      const ctx = makeContext();
      expect(mapCodexEvent(codexItemStarted(controlUiItem('ui-1')), ctx)).toEqual([]);
      expect(mapCodexEvent(codexItemUpdated(controlUiItem('ui-1')), ctx)).toEqual([]);
    });

    it('does NOT emit a ui_command for a failed control_ui call — renders the generic failed tool call', () => {
      // A control_ui call that fails at the MCP-transport level (rate limit,
      // timeout, loopback error) reaches `completed` with status 'failed'.
      // Applying it as a ui_command would mask the failure; surface it as a
      // normal failed tool call instead (matching every sibling mapper).
      const events = mapCodexEvent(
        codexItemCompleted(
          mcpToolCallItem('ui-1', {
            server: CODEX_UI_MCP_SERVER,
            tool: 'control_ui',
            args: openCanvasArgs,
            status: 'failed',
            errorMessage: 'rate limited',
          })
        ),
        makeContext()
      );
      expect(events.some((e) => e.type === 'ui_command')).toBe(false);
      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'tool_call_end',
        'tool_result',
      ]);
      expect(events[1]!.data).toMatchObject({
        toolName: 'mcp__dorkos_ui__control_ui',
        status: 'error',
      });
      expect(events[2]!.data).toMatchObject({ status: 'error', result: 'rate limited' });
    });

    it('emits a typed error and no ui_command for invalid arguments', () => {
      const events = mapCodexEvent(
        codexItemCompleted(
          controlUiItem('ui-1', { status: 'completed', args: { action: 'not_a_real_action' } })
        ),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'error',
          data: { message: 'Invalid control_ui command', code: 'ui_command_invalid' },
        },
      ]);
      expect(events.some((e) => e.type === 'ui_command')).toBe(false);
    });

    it('falls through to generic mcp mapping when a different server exposes control_ui', () => {
      const events = mapCodexEvent(
        codexItemStarted(
          mcpToolCallItem('m1', { server: 'linear', tool: 'control_ui', args: { action: 'x' } })
        ),
        makeContext()
      );
      expect(events).toEqual([
        {
          type: 'tool_call_start',
          data: {
            toolCallId: 'm1',
            toolName: 'mcp__linear__control_ui',
            input: '{"action":"x"}',
            status: 'running',
          },
        },
      ]);
      expect(events.some((e) => e.type === 'ui_command')).toBe(false);
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

    it('maps a failed patch to error status', () => {
      const ctx = makeContext();
      const events = mapCodexEvent(
        codexItemCompleted(fileChangeItem('f1', [{ path: 'src/a.ts', kind: 'update' }], 'failed')),
        ctx
      );
      expect(events[1]!.data).toMatchObject({ status: 'error' });
      expect(events[2]!.data).toMatchObject({ status: 'error' });
    });
  });

  describe('web_search → tool events', () => {
    it('maps started/completed to tool_call_start/tool_call_end without a result', () => {
      const ctx = makeContext();
      expect(mapCodexEvent(codexItemStarted(webSearchItem('w1', 'dorkos')), ctx)).toEqual([
        {
          type: 'tool_call_start',
          data: {
            toolCallId: 'w1',
            toolName: 'WebSearch',
            input: '{"query":"dorkos"}',
            status: 'running',
          },
        },
      ]);
      expect(mapCodexEvent(codexItemCompleted(webSearchItem('w1', 'dorkos')), ctx)).toEqual([
        {
          type: 'tool_call_end',
          data: { toolCallId: 'w1', toolName: 'WebSearch', status: 'complete' },
        },
      ]);
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

    it('emits nothing for an empty todo list', () => {
      expect(mapCodexEvent(codexItemUpdated(todoListItem('t1', [])), makeContext())).toEqual([]);
    });
  });

  describe('errors and turn end', () => {
    it('maps a non-fatal error item to a non-terminal error event', () => {
      const events = mapCodexEvent(
        codexItemCompleted(errorThreadItem('e1', 'tool exploded')),
        makeContext()
      );
      expect(events).toEqual([
        { type: 'error', data: { message: 'tool exploded', code: 'item_error' } },
      ]);
    });

    it('maps turn.completed to usage session_status followed by terminal done', () => {
      const events = mapCodexEvent(codexTurnCompleted(DEFAULT_USAGE), makeContext());
      expect(events).toEqual([
        {
          type: 'session_status',
          data: {
            sessionId: SESSION_ID,
            contextTokens: 120,
            outputTokens: 45,
            cacheReadTokens: 80,
          },
        },
        { type: 'done', data: { sessionId: SESSION_ID } },
      ]);
    });

    it('maps turn.failed to a typed error followed by terminal done', () => {
      const events = mapCodexEvent(codexTurnFailed('model exploded'), makeContext());
      expect(events).toEqual([
        {
          type: 'error',
          data: { message: 'model exploded', code: 'turn_failed', category: 'execution_error' },
        },
        { type: 'done', data: { sessionId: SESSION_ID } },
      ]);
    });

    it('dedupes turn.failed when an error item already surfaced the same failure', () => {
      const ctx = makeContext();
      const itemEvents = mapCodexEvent(
        codexItemCompleted(errorThreadItem('e1', 'stream disconnected')),
        ctx
      );
      expect(itemEvents.map((e) => e.type)).toEqual(['error']);

      const failedEvents = mapCodexEvent(codexTurnFailed('stream disconnected'), ctx);
      expect(failedEvents).toEqual([{ type: 'done', data: { sessionId: SESSION_ID } }]);
    });

    it('still emits the turn.failed error when its message differs from the last error item', () => {
      const ctx = makeContext();
      mapCodexEvent(codexItemCompleted(errorThreadItem('e1', 'falling back to HTTPS')), ctx);

      const events = mapCodexEvent(codexTurnFailed('connection lost'), ctx);
      expect(events.map((e) => e.type)).toEqual(['error', 'done']);
      expect(events[0]!.data).toMatchObject({ message: 'connection lost', code: 'turn_failed' });
    });

    it('maps a stream-level error to a NON-terminal system_status diagnostic', () => {
      // Live-verified: stream errors are transient reconnect attempts, not
      // fatal (NOTES.md §Additional live-verified facts) — no error, no done.
      const events = mapCodexEvent(codexStreamError('Reconnecting... 3/5'), makeContext());
      expect(events).toEqual([{ type: 'system_status', data: { message: 'Reconnecting... 3/5' } }]);
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

  it('maps a simple turn to text deltas, usage, and done', async () => {
    const events = await drain(codexSimpleTurn('Hello world'));
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

  it('recovers through transient stream errors into a completed turn', async () => {
    const events = await drain(codexRecoveredTurn('All good.'));
    expect(events.map((e) => e.type)).toEqual([
      'system_status',
      'system_status',
      'text_delta',
      'session_status',
      'done',
    ]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('emits exactly one user-visible error when an error item precedes turn.failed', async () => {
    const events = await drain(codexFailedTurnWithErrorItem('boom'));
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]!.data).toMatchObject({ message: 'boom', code: 'item_error' });
  });

  it('appends terminal done when the stream dies after a stream-level error', async () => {
    const events = await drain(codexStreamErrorTurn('gone'));
    expect(events.map((e) => e.type)).toEqual(['system_status', 'done']);
  });

  it('ends an aborted (interrupted) turn with done and no error event', async () => {
    const events = await drain(codexAbortedTurn('partial answer'));
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
    expect(events[1]!.data).toEqual({ sessionId: SESSION_ID });
  });

  it('converts a non-abort stream crash into a typed error followed by done', async () => {
    async function* crashingStream(): AsyncGenerator<ThreadEvent> {
      yield codexThreadStarted();
      throw new Error('codex process exited unexpectedly');
    }
    const events = await drain(crashingStream());
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]!.data).toMatchObject({
      message: 'codex process exited unexpectedly',
      code: 'stream_error',
    });
  });

  it('records the thread id on the context while streaming', async () => {
    const ctx = makeContext();
    await drain(codexSimpleTurn('hi'), ctx);
    expect(ctx.threadId).toBe('codex-thread-0001');
  });
});
