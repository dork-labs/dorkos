/**
 * Codex event mapper — pure functions translating `@openai/codex-sdk`
 * ThreadEvents into DorkOS StreamEvents (`packages/shared/src/schemas.ts`).
 *
 * The 0.142.5 SDK emits 8 typed ThreadEvents: `thread.started`,
 * `turn.started`, `turn.completed` (usage), `turn.failed` (error), the three
 * `item.*` phases over the ThreadItem union, and a stream-level `error`.
 * Item payloads carry CUMULATIVE snapshots, not deltas — the SDK's
 * own `run()` takes `item.completed`'s `agent_message.text` as the entire
 * `finalResponse` — so this mapper tracks the last-seen text per item id and
 * emits only the new suffix as `text_delta`/`thinking_delta`/`tool_progress`.
 * When a snapshot is not a prefix extension (never observed, but untyped
 * upstream), the full new text is emitted rather than dropped.
 *
 * STREAM-LEVEL `error` IS NOT FATAL, despite the SDK type docstring
 * ("unrecoverable"): live probes show reconnect-attempt sequences
 * (`"Reconnecting... N/5"`) that recover into a normal turn (NOTES.md,
 * §Additional live-verified facts). It maps to a non-terminal `system_status`
 * diagnostic; a turn terminates ONLY on `turn.completed`, `turn.failed`, or
 * the events generator throwing (abort / process crash).
 *
 * TOOL APPROVALS: Codex exec mode has NO approval surface — stdin closes
 * after the prompt and approval-needing calls auto-cancel, so the runtime
 * declares `supportsToolApproval: false` and this mapper NEVER emits
 * `approval_required` (NOTES.md, Verdict 1).
 *
 * @module services/runtimes/codex/event-mapper
 */
import type {
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  ThreadEvent,
  ThreadItem,
  TodoListItem,
  WebSearchItem,
} from '@openai/codex-sdk';
import type { StreamEvent, TaskItem } from '@dorkos/shared/types';
import { UiCommandSchema } from '@dorkos/shared/schemas';
import { CODEX_UI_MCP_SERVER } from './codex-ui-mcp-server.js';

/** Tool name stamped on command_execution tool events. */
export const SHELL_TOOL_NAME = 'Shell';
/** Tool name stamped on file_change (patch apply) tool events. */
export const PATCH_TOOL_NAME = 'ApplyPatch';
/** Tool name stamped on web_search tool events. */
export const WEB_SEARCH_TOOL_NAME = 'WebSearch';

/** Which item.* phase a ThreadItem arrived under. */
type ItemPhase = 'started' | 'updated' | 'completed';

/**
 * Per-turn mutable state threaded through the pure mapping functions —
 * the Codex analog of the Claude adapter's `ToolState` struct.
 */
export interface CodexEventContext {
  /** DorkOS session id stamped onto session_status/error/done events. */
  readonly sessionId: string;
  /** Codex thread id; set when `thread.started` arrives (persisted by the thread map). */
  threadId?: string;
  /** Last-seen cumulative text per agent_message/reasoning item id. */
  readonly lastTextById: Map<string, string>;
  /** Last-seen cumulative aggregated_output per command_execution item id. */
  readonly lastOutputById: Map<string, string>;
  /** Tool item ids that already emitted tool_call_start. */
  readonly startedToolIds: Set<string>;
  /**
   * Message of the last user-visible `error` event emitted for an error item.
   * Defensive dedupe: the live trace showed `turn.failed` repeating the final
   * stream error's message; when an error item carries the same text, the
   * mapper skips the duplicate error and emits only `done`.
   */
  lastErrorMessage?: string;
  /**
   * Whether a NON-empty todo_list snapshot is currently rendered. Gates the
   * emptied-list "clear": an empty todo_list update only propagates a clearing
   * `task_update` when it is a genuine transition from a rendered list, so
   * repeated or leading empties never spam a redundant clear.
   */
  todoListActive?: boolean;
}

/**
 * Create a fresh mapping context for one turn.
 *
 * @param sessionId - DorkOS session identifier stamped onto emitted events
 */
export function createCodexEventContext(sessionId: string): CodexEventContext {
  return {
    sessionId,
    lastTextById: new Map(),
    lastOutputById: new Map(),
    startedToolIds: new Set(),
  };
}

/**
 * Map one Codex ThreadEvent to zero or more StreamEvents. Pure aside from
 * the mutable {@link CodexEventContext} (delta baselines, thread id).
 *
 * Terminal events (`turn.completed`, `turn.failed`) end with `done`;
 * {@link mapCodexThread} guarantees that invariant for whole streams,
 * including aborted or crashed ones.
 *
 * @param event - The Codex SDK thread event to translate
 * @param ctx - Per-turn mapping context (mutated)
 */
export function mapCodexEvent(event: ThreadEvent, ctx: CodexEventContext): StreamEvent[] {
  switch (event.type) {
    case 'thread.started':
      // No StreamEvent — the thread id feeds the sessionId↔threadId map
      // (thread-map.ts); the facade reads it off the context.
      ctx.threadId = event.thread_id;
      return [];
    case 'turn.started':
      return [];
    case 'turn.completed':
      // Usage passthrough. Codex reports prompt tokens as input_tokens with
      // cached_input_tokens as the cache-read subset. reasoning_output_tokens
      // (the SDK's separate reasoning-model tally) has no StreamEvent home of
      // its own, so it is FOLDED into outputTokens — otherwise the displayed
      // output-token count materially undercounts reasoning-model turns. It is
      // typed as a required `number`, but defaults to 0 defensively in case a
      // future/older payload omits it.
      //
      // `terminalReason: 'completed'` marks the normal-completion outcome so
      // feedProjector latches it onto the synthesized turn_end (the failure
      // counterpart, 'error', is set on the turn.failed path below).
      return [
        {
          type: 'session_status',
          data: {
            sessionId: ctx.sessionId,
            contextTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens + (event.usage.reasoning_output_tokens ?? 0),
            cacheReadTokens: event.usage.cached_input_tokens,
            terminalReason: 'completed',
          },
        },
        { type: 'done', data: { sessionId: ctx.sessionId } },
      ];
    case 'turn.failed': {
      // A failed turn closes with terminalReason 'error' — the codebase-wide
      // turn-failure signal (test-mode's error scenario, trigger-turn's
      // guardTurnErrors, and the projector's TERMINAL_REASON_ERROR all use it;
      // it is schema-valid via TerminalReasonSchema's `z.string()` branch).
      // feedProjector latches it onto turn_end, settling the session lifecycle
      // to `error` so a cold hydrate still surfaces the failure. It rides a
      // session_status (DoneEvent has no terminalReason field), emitted even in
      // the dedupe path so the outcome is never lost.
      const failedStatus: StreamEvent = {
        type: 'session_status',
        data: { sessionId: ctx.sessionId, terminalReason: 'error' },
      };
      // Defensive dedupe (extrapolated from the live trace, where turn.failed
      // repeated the final stream error): if an error item already carried
      // this exact failure, skip the duplicate user-visible error, keep done.
      if (event.error.message === ctx.lastErrorMessage) {
        return [failedStatus, { type: 'done', data: { sessionId: ctx.sessionId } }];
      }
      return [
        failedStatus,
        {
          type: 'error',
          data: { message: event.error.message, code: 'turn_failed', category: 'execution_error' },
        },
        { type: 'done', data: { sessionId: ctx.sessionId } },
      ];
    }
    case 'error':
      // NOT fatal (see module doc): live-observed as transient reconnect
      // attempts that can recover into a completed turn. Surface as a
      // non-terminal diagnostic; turn.failed carries the real failure.
      return [{ type: 'system_status', data: { message: event.message } }];
    case 'item.started':
      return mapThreadItem(event.item, 'started', ctx);
    case 'item.updated':
      return mapThreadItem(event.item, 'updated', ctx);
    case 'item.completed':
      return mapThreadItem(event.item, 'completed', ctx);
    default: {
      // Compile-time exhaustiveness: fails to compile when the SDK adds a
      // ThreadEvent type, forcing an explicit mapping decision here.
      const unhandled: never = event;
      void unhandled;
      return [];
    }
  }
}

/**
 * Map a whole `runStreamed().events` stream, guaranteeing the conformance
 * invariant that exactly one terminal `done` ends the StreamEvent stream:
 *
 * - after a `done` (turn.completed/turn.failed) the generator returns;
 * - an AbortError (interrupt via `TurnOptions.signal`) ends the turn with a
 *   plain `done` — user-initiated, not an error;
 * - any other thrown error (e.g. the Codex subprocess crashing) becomes a
 *   typed `error` followed by `done`;
 * - a stream that just ends without a turn terminal still gets its trailing
 *   `done` so consumers can key turn teardown on it.
 *
 * @param events - The ThreadEvent stream from `thread.runStreamed()`
 * @param ctx - Per-turn mapping context (mutated; `threadId` set en route)
 */
export async function* mapCodexThread(
  events: AsyncIterable<ThreadEvent>,
  ctx: CodexEventContext
): AsyncGenerator<StreamEvent> {
  try {
    for await (const event of events) {
      for (const mapped of mapCodexEvent(event, ctx)) {
        yield mapped;
        if (mapped.type === 'done') return;
      }
    }
  } catch (err) {
    if (!isAbortError(err)) {
      yield {
        type: 'error',
        data: {
          message: err instanceof Error ? err.message : String(err),
          code: 'stream_error',
          category: 'execution_error',
        },
      };
    }
  }
  yield { type: 'done', data: { sessionId: ctx.sessionId } };
}

// NOTE: there is deliberately no approval mapping here. Codex exec mode has
// no approval surface (stdin closes after the prompt; approval-needing calls
// auto-cancel — NOTES.md, Verdict 1), so `supportsToolApproval: false` gates
// the approval UI off and no ThreadEvent can produce `approval_required`.

// === Item mapping ===

/** Route a ThreadItem to its per-type mapper. */
function mapThreadItem(item: ThreadItem, phase: ItemPhase, ctx: CodexEventContext): StreamEvent[] {
  switch (item.type) {
    case 'agent_message':
      return mapItemText(item, phase, 'text_delta', ctx);
    case 'reasoning':
      return mapItemText(item, phase, 'thinking_delta', ctx);
    case 'command_execution':
      return mapCommandExecution(item, phase, ctx);
    case 'file_change':
      return mapFileChange(item, phase, ctx);
    case 'mcp_tool_call':
      // Canvas parity: a call to the scoped `dorkos_ui` `control_ui` server is
      // translated into a runtime-neutral `ui_command` StreamEvent rather than
      // rendered as a generic MCP tool call (its stub result is noise).
      if (item.server === CODEX_UI_MCP_SERVER && item.tool === 'control_ui') {
        return mapControlUi(item, phase, ctx);
      }
      return mapMcpToolCall(item, phase, ctx);
    case 'web_search':
      return mapWebSearch(item, phase, ctx);
    case 'todo_list':
      return mapTodoList(item, ctx);
    case 'error':
      // Non-fatal error item — surfaced as a typed, NON-terminal error event.
      // Remember the message: turn.failed dedupes against it (see mapCodexEvent).
      ctx.lastErrorMessage = item.message;
      return [{ type: 'error', data: { message: item.message, code: 'item_error' } }];
    default: {
      const unhandled: never = item;
      void unhandled;
      return [];
    }
  }
}

/**
 * Emit the new text suffix of a cumulative agent_message/reasoning snapshot.
 * Falls back to the full new text when the snapshot is not a prefix
 * extension of what was last seen (defensive; see module doc).
 */
function mapItemText(
  item: AgentMessageItem | ReasoningItem,
  phase: ItemPhase,
  type: 'text_delta' | 'thinking_delta',
  ctx: CodexEventContext
): StreamEvent[] {
  const previous = ctx.lastTextById.get(item.id) ?? '';
  const next = item.text;
  const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
  if (phase === 'completed') {
    ctx.lastTextById.delete(item.id);
  } else {
    ctx.lastTextById.set(item.id, next);
  }
  return delta.length > 0 ? [{ type, data: { text: delta } }] : [];
}

/**
 * Emit `tool_call_start` for a tool-like item unless it already started —
 * covers items whose first observed phase is `updated`/`completed` (e.g.
 * file_change, which is only emitted once the patch resolves).
 */
function ensureToolStart(
  events: StreamEvent[],
  toolCallId: string,
  toolName: string,
  input: string,
  ctx: CodexEventContext
): void {
  if (ctx.startedToolIds.has(toolCallId)) return;
  ctx.startedToolIds.add(toolCallId);
  events.push({
    type: 'tool_call_start',
    data: { toolCallId, toolName, input, status: 'running' },
  });
}

/**
 * command_execution → tool_call_start on start, incremental `tool_progress`
 * for new aggregated_output on update, tool_call_end + tool_result (status
 * `error` on failure) on completion.
 */
function mapCommandExecution(
  item: CommandExecutionItem,
  phase: ItemPhase,
  ctx: CodexEventContext
): StreamEvent[] {
  const toolCallId = item.id;
  const input = JSON.stringify({ command: item.command });
  const events: StreamEvent[] = [];
  ensureToolStart(events, toolCallId, SHELL_TOOL_NAME, input, ctx);

  const previous = ctx.lastOutputById.get(toolCallId) ?? '';
  const output = item.aggregated_output ?? '';
  const outputDelta = output.startsWith(previous) ? output.slice(previous.length) : output;

  if (phase === 'completed') {
    ctx.lastOutputById.delete(toolCallId);
    const status = item.status === 'failed' ? 'error' : 'complete';
    events.push({
      type: 'tool_call_end',
      data: { toolCallId, toolName: SHELL_TOOL_NAME, status },
    });
    if (output) {
      events.push({
        type: 'tool_result',
        data: { toolCallId, toolName: SHELL_TOOL_NAME, result: output, status },
      });
    }
    return events;
  }

  ctx.lastOutputById.set(toolCallId, output);
  if (phase === 'updated' && outputDelta) {
    events.push({ type: 'tool_progress', data: { toolCallId, content: outputDelta } });
  }
  return events;
}

/** Render a patch's file changes as one human-readable line per file. */
function describeFileChanges(changes: FileChangeItem['changes']): string {
  return changes.map((change) => `${change.kind} ${change.path}`).join('\n');
}

/**
 * file_change → tool triplet. Codex emits the item once the patch succeeds
 * or fails, so completion usually synthesizes its own tool_call_start.
 */
function mapFileChange(
  item: FileChangeItem,
  phase: ItemPhase,
  ctx: CodexEventContext
): StreamEvent[] {
  const toolCallId = item.id;
  const input = JSON.stringify({ changes: item.changes });
  const events: StreamEvent[] = [];
  ensureToolStart(events, toolCallId, PATCH_TOOL_NAME, input, ctx);

  if (phase === 'completed') {
    const status = item.status === 'failed' ? 'error' : 'complete';
    events.push(
      { type: 'tool_call_end', data: { toolCallId, toolName: PATCH_TOOL_NAME, status } },
      {
        type: 'tool_result',
        data: {
          toolCallId,
          toolName: PATCH_TOOL_NAME,
          result: describeFileChanges(item.changes),
          status,
        },
      }
    );
  }
  return events;
}

/** Extract the display result of an MCP call: error message on failure, joined text blocks on success. */
function extractMcpResultText(item: McpToolCallItem): string | undefined {
  if (item.status === 'failed') return item.error?.message;
  const content = item.result?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text || undefined;
}

/**
 * Translate a scoped `dorkos_ui` `control_ui` call into a runtime-neutral
 * `ui_command` StreamEvent — the Codex route to canvas parity.
 *
 * The scoped MCP server's handler is a side-effect-free stub
 * ({@link ./codex-ui-mcp-server}); the real UI effect is produced HERE, inside
 * the turn loop where the session is in scope. Fires exactly once — on the
 * terminal `completed` phase, where the arguments are present — and emits ONLY
 * the `ui_command` event, never the generic tool_call/tool_result pair (the
 * `{ success: true }` stub payload is noise and would clutter the transcript).
 *
 * A call that genuinely FAILED at the MCP-transport level (rate limit, timeout,
 * transient loopback error) also reaches the `completed` phase but with
 * `status: 'failed'`. Translating that into a `ui_command` would apply a
 * phantom UI effect client-side and mask the failure, so — like every sibling
 * completed-phase mapper — the failed case delegates to {@link mapMcpToolCall}
 * and renders as a normal failed tool call. control_ui's started/updated phases
 * return `[]` without recording a `startedToolIds` entry, so `mapMcpToolCall`'s
 * `ensureToolStart` correctly synthesizes the `tool_call_start`.
 *
 * @param item - The `control_ui` mcp_tool_call item from the `dorkos_ui` server
 * @param phase - Which item.* phase this item arrived under
 * @param ctx - Per-turn mapping context (forwarded to the failed-case fallback)
 */
function mapControlUi(
  item: McpToolCallItem,
  phase: ItemPhase,
  ctx: CodexEventContext
): StreamEvent[] {
  if (phase !== 'completed') return [];
  if (item.status === 'failed') return mapMcpToolCall(item, phase, ctx);
  const parsed = UiCommandSchema.safeParse(item.arguments);
  if (!parsed.success) {
    return [
      {
        type: 'error',
        data: { message: 'Invalid control_ui command', code: 'ui_command_invalid' },
      },
    ];
  }
  // UiCommandEventSchema is not a member of the StreamEvent data union (only
  // the runtime-neutral SessionEvent carries it), so cast as ui-tools.ts does.
  return [{ type: 'ui_command', data: { command: parsed.data } } as StreamEvent];
}

/**
 * mcp_tool_call → tool events named with the Claude adapter's
 * `mcp__server__tool` convention so downstream tooling treats MCP calls
 * uniformly across runtimes.
 */
function mapMcpToolCall(
  item: McpToolCallItem,
  phase: ItemPhase,
  ctx: CodexEventContext
): StreamEvent[] {
  const toolCallId = item.id;
  const toolName = `mcp__${item.server}__${item.tool}`;
  const input = JSON.stringify(item.arguments ?? {});
  const events: StreamEvent[] = [];
  ensureToolStart(events, toolCallId, toolName, input, ctx);

  if (phase === 'completed') {
    const status = item.status === 'failed' ? 'error' : 'complete';
    events.push({ type: 'tool_call_end', data: { toolCallId, toolName, status } });
    const result = extractMcpResultText(item);
    if (result) {
      events.push({ type: 'tool_result', data: { toolCallId, toolName, result, status } });
    }
  }
  return events;
}

/** web_search → tool_call_start/tool_call_end (the item carries no result payload). */
function mapWebSearch(
  item: WebSearchItem,
  phase: ItemPhase,
  ctx: CodexEventContext
): StreamEvent[] {
  const events: StreamEvent[] = [];
  ensureToolStart(
    events,
    item.id,
    WEB_SEARCH_TOOL_NAME,
    JSON.stringify({ query: item.query }),
    ctx
  );
  if (phase === 'completed') {
    events.push({
      type: 'tool_call_end',
      data: { toolCallId: item.id, toolName: WEB_SEARCH_TOOL_NAME, status: 'complete' },
    });
  }
  return events;
}

/**
 * Placeholder task carried on a clearing snapshot. `TaskUpdateEventSchema`
 * requires a non-optional `task`, but the client's snapshot reducer reads
 * `event.tasks ?? [event.task]` — so an empty `tasks: []` array (which is not
 * nullish) takes precedence and this placeholder is never rendered.
 */
const CLEARED_TODO_TASK: TaskItem = { id: '0', subject: '', status: 'pending' };

/**
 * todo_list → `task_update` snapshot, mirroring the Claude adapter's
 * TodoWrite mapping (1-based string ids; codex todos have no ids of their own).
 *
 * An emptied list propagates a clearing snapshot (`tasks: []`) so a rendered
 * todo list can actually be cleared in the UI, but only on a genuine
 * transition from a non-empty list ({@link CodexEventContext.todoListActive}),
 * so leading or repeated empty updates never spam a redundant clear.
 *
 * Scope note: `todoListActive` lives on the per-turn {@link CodexEventContext},
 * so this handles same-turn clears only. A list rendered in one turn and
 * emptied at the very start of a later turn arrives as a leading empty against
 * a fresh context and is left as-is (no spurious clear); that cross-turn case
 * is not something Codex is known to emit.
 *
 * @param item - The todo_list ThreadItem (cumulative snapshot of all todos).
 * @param ctx - Per-turn mapping context (its `todoListActive` flag is mutated).
 */
function mapTodoList(item: TodoListItem, ctx: CodexEventContext): StreamEvent[] {
  if (item.items.length === 0) {
    if (!ctx.todoListActive) return [];
    ctx.todoListActive = false;
    return [
      { type: 'task_update', data: { action: 'snapshot', task: CLEARED_TODO_TASK, tasks: [] } },
    ];
  }
  ctx.todoListActive = true;
  const tasks: TaskItem[] = item.items.map((todo, index) => ({
    id: String(index + 1),
    subject: todo.text,
    status: todo.completed ? 'completed' : 'pending',
  }));
  return [{ type: 'task_update', data: { action: 'snapshot', task: tasks[0]!, tasks } }];
}

/** True when the thrown value is the AbortError raised by a fired `TurnOptions.signal`. */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}
