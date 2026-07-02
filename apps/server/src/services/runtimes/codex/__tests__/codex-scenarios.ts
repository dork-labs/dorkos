/**
 * Scripted Codex SDK event fixtures for mapper and facade tests.
 *
 * Mirrors the conventions of the Claude adapter's `sdk-scenarios.ts`: typed
 * event builders, full scripted turns, and mock helpers for
 * `vi.mock('@openai/codex-sdk')`. Lives inside the codex ESLint boundary —
 * `@openai/codex-sdk` imports are confined to `services/runtimes/codex/`, so
 * do not import this module from outside the codex adapter.
 *
 * @module services/runtimes/codex/__tests__/codex-scenarios
 */
import { vi } from 'vitest';
import type {
  AgentMessageItem,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  ThreadEvent,
  ThreadItem,
  TodoListItem,
  Usage,
  WebSearchItem,
} from '@openai/codex-sdk';

/** Thread id stamped on `thread.started` fixtures. */
export const THREAD_ID = 'codex-thread-0001';

/** Default per-turn token usage for `turn.completed` fixtures. */
export const DEFAULT_USAGE: Usage = {
  input_tokens: 120,
  cached_input_tokens: 80,
  output_tokens: 45,
  reasoning_output_tokens: 10,
};

// === ThreadEvent builders ===

/** Build a `thread.started` event. */
export function codexThreadStarted(threadId = THREAD_ID): ThreadEvent {
  return { type: 'thread.started', thread_id: threadId };
}

/** Build a `turn.started` event. */
export function codexTurnStarted(): ThreadEvent {
  return { type: 'turn.started' };
}

/** Build a `turn.completed` event carrying token usage. */
export function codexTurnCompleted(usage: Usage = DEFAULT_USAGE): ThreadEvent {
  return { type: 'turn.completed', usage };
}

/** Build a `turn.failed` event carrying a ThreadError. */
export function codexTurnFailed(message: string): ThreadEvent {
  return { type: 'turn.failed', error: { message } };
}

/** Build a stream-level fatal `error` event. */
export function codexStreamError(message: string): ThreadEvent {
  return { type: 'error', message };
}

/** Wrap a ThreadItem in an `item.started` event. */
export function codexItemStarted(item: ThreadItem): ThreadEvent {
  return { type: 'item.started', item };
}

/** Wrap a ThreadItem in an `item.updated` event. */
export function codexItemUpdated(item: ThreadItem): ThreadEvent {
  return { type: 'item.updated', item };
}

/** Wrap a ThreadItem in an `item.completed` event. */
export function codexItemCompleted(item: ThreadItem): ThreadEvent {
  return { type: 'item.completed', item };
}

// === ThreadItem builders ===

/**
 * Build an `agent_message` item. Codex item payloads carry the CUMULATIVE
 * text snapshot, not a delta — pass the full text seen so far.
 */
export function agentMessageItem(id: string, text: string): AgentMessageItem {
  return { id, type: 'agent_message', text };
}

/** Build a `reasoning` item (cumulative text snapshot, like agent_message). */
export function reasoningItem(id: string, text: string): ReasoningItem {
  return { id, type: 'reasoning', text };
}

/** Build a `command_execution` item. `output` is the CUMULATIVE aggregated output. */
export function commandExecutionItem(
  id: string,
  opts: {
    command?: string;
    output?: string;
    status?: CommandExecutionItem['status'];
    exitCode?: number;
  } = {}
): CommandExecutionItem {
  const { command = 'ls -la', output = '', status = 'in_progress', exitCode } = opts;
  return {
    id,
    type: 'command_execution',
    command,
    aggregated_output: output,
    status,
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
  };
}

/** Build a `file_change` item (emitted once the patch succeeds or fails). */
export function fileChangeItem(
  id: string,
  changes: FileChangeItem['changes'],
  status: FileChangeItem['status'] = 'completed'
): FileChangeItem {
  return { id, type: 'file_change', changes, status };
}

/** Build an `mcp_tool_call` item with optional text result or error payload. */
export function mcpToolCallItem(
  id: string,
  opts: {
    server?: string;
    tool?: string;
    args?: unknown;
    status?: McpToolCallItem['status'];
    resultText?: string;
    errorMessage?: string;
  } = {}
): McpToolCallItem {
  const {
    server = 'linear',
    tool = 'create_issue',
    args = { title: 'Test' },
    status = 'in_progress',
    resultText,
    errorMessage,
  } = opts;
  return {
    id,
    type: 'mcp_tool_call',
    server,
    tool,
    arguments: args,
    ...(resultText !== undefined
      ? { result: { content: [{ type: 'text', text: resultText }], structured_content: null } }
      : {}),
    ...(errorMessage !== undefined ? { error: { message: errorMessage } } : {}),
    status,
  };
}

/** Build a `web_search` item. */
export function webSearchItem(id: string, query: string): WebSearchItem {
  return { id, type: 'web_search', query };
}

/** Build a `todo_list` item from `[text, completed]` tuples. */
export function todoListItem(id: string, items: TodoListItem['items']): TodoListItem {
  return { id, type: 'todo_list', items };
}

/** Build a non-fatal `error` item. */
export function errorThreadItem(id: string, message: string): ErrorItem {
  return { id, type: 'error', message };
}

// === Full scripted turns ===

/**
 * A minimal successful text turn: empty message start, one cumulative update
 * (first half of the text), completion with the full text, then turn end.
 */
export function codexSimpleTurn(text: string): ThreadEvent[] {
  const half = Math.ceil(text.length / 2);
  return [
    codexThreadStarted(),
    codexTurnStarted(),
    codexItemStarted(agentMessageItem('msg-1', '')),
    codexItemUpdated(agentMessageItem('msg-1', text.slice(0, half))),
    codexItemCompleted(agentMessageItem('msg-1', text)),
    codexTurnCompleted(),
  ];
}

/** A turn running one shell command (start → cumulative output → success) then text. */
export function codexCommandTurn(
  command: string,
  output: string,
  responseText: string
): ThreadEvent[] {
  return [
    codexThreadStarted(),
    codexTurnStarted(),
    codexItemStarted(commandExecutionItem('cmd-1', { command })),
    codexItemUpdated(commandExecutionItem('cmd-1', { command, output })),
    codexItemCompleted(
      commandExecutionItem('cmd-1', { command, output, status: 'completed', exitCode: 0 })
    ),
    codexItemCompleted(agentMessageItem('msg-1', responseText)),
    codexTurnCompleted(),
  ];
}

/** A turn invoking one MCP tool that succeeds with a text result. */
export function codexMcpTurn(): ThreadEvent[] {
  return [
    codexThreadStarted(),
    codexTurnStarted(),
    codexItemStarted(mcpToolCallItem('mcp-1')),
    codexItemCompleted(mcpToolCallItem('mcp-1', { status: 'completed', resultText: 'created' })),
    codexItemCompleted(agentMessageItem('msg-1', 'Created the issue.')),
    codexTurnCompleted(),
  ];
}

/** A turn that fails: `turn.failed` ends the stream (no `turn.completed`). */
export function codexFailedTurn(message: string): ThreadEvent[] {
  return [codexThreadStarted(), codexTurnStarted(), codexTurnFailed(message)];
}

/**
 * A live-observed failure shape: an error ITEM surfaces the failure, then
 * `turn.failed` repeats the same message (NOTES.md §Additional live-verified
 * facts) — the mapper must not double-emit the user-visible error.
 */
export function codexFailedTurnWithErrorItem(message: string): ThreadEvent[] {
  return [
    codexThreadStarted(),
    codexTurnStarted(),
    codexItemCompleted(errorThreadItem('err-1', message)),
    codexTurnFailed(message),
  ];
}

/**
 * A live-observed recovery shape: transient stream-level `error` events
 * (reconnect attempts) followed by a NORMAL completed turn — stream errors
 * are not fatal (NOTES.md §Additional live-verified facts).
 */
export function codexRecoveredTurn(text: string): ThreadEvent[] {
  return [
    codexThreadStarted(),
    codexTurnStarted(),
    codexStreamError('Reconnecting... 1/5'),
    codexStreamError('Reconnecting... 2/5'),
    codexItemCompleted(agentMessageItem('msg-1', text)),
    codexTurnCompleted(),
  ];
}

/**
 * A stream that dies after a stream-level `error` event with no turn
 * terminal — the mapper's stream wrapper appends the trailing `done`.
 */
export function codexStreamErrorTurn(message: string): ThreadEvent[] {
  return [codexThreadStarted(), codexTurnStarted(), codexStreamError(message)];
}

/**
 * An interrupted turn: yields a partial answer, then throws the AbortError
 * the SDK surfaces when `TurnOptions.signal` fires mid-stream.
 */
export async function* codexAbortedTurn(text = 'partial answer'): AsyncGenerator<ThreadEvent> {
  yield codexThreadStarted();
  yield codexTurnStarted();
  yield codexItemUpdated(agentMessageItem('msg-1', text));
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  throw abort;
}

// === SDK mock helpers ===

/** Turn a fixture array into the async generator shape `runStreamed()` returns. */
export function toEventStream(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

/**
 * Fake `Thread` mirroring the SDK surface the adapter touches:
 * `runStreamed()` resolves to `{ events }` exactly like the real SDK.
 */
export function makeMockThread(
  events: ThreadEvent[] | AsyncGenerator<ThreadEvent>,
  threadId: string | null = THREAD_ID
) {
  const stream = Array.isArray(events) ? toEventStream(events) : events;
  return {
    id: threadId,
    runStreamed: vi.fn(async () => ({ events: stream })),
    run: vi.fn(),
  };
}

/**
 * Module factory body for `vi.mock('@openai/codex-sdk', ...)`: a `Codex`
 * constructor whose `startThread`/`resumeThread` both return the given fake
 * thread. Usage in a test file (vi.mock is hoisted, so build the thread via
 * `vi.hoisted` or inside the factory):
 *
 * ```ts
 * vi.mock('@openai/codex-sdk', () => makeMockCodexModule(thread));
 * ```
 */
export function makeMockCodexModule(thread: ReturnType<typeof makeMockThread>) {
  return {
    Codex: vi.fn(() => ({
      startThread: vi.fn(() => thread),
      resumeThread: vi.fn(() => thread),
    })),
  };
}
