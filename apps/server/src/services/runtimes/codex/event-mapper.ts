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
import {
  describeCodexDiagnostic,
  describeRuntimeError,
  type RuntimeErrorCopy,
} from '@dorkos/shared/runtime-error-classification';
import { CODEX_UI_MCP_SERVER } from './codex-ui-mcp-server.js';
import {
  UI_COMMAND_REFUSED_CODE,
  isUiActionRefusedInRoom,
  isUiActionRefusedOnCodex,
  uiActionRefusalMessage,
} from './ui-command-consent.js';
import { NOT_IN_A_ROOM_MESSAGE } from '../../rooms/canvas/index.js';
import { recordCodexMedia, type CodexMediaState } from './media-capture.js';
import { readCodexTurnContextUsage, type CodexTurnContextUsage } from './turn-context-usage.js';

/**
 * This adapter's runtime type — the identity {@link describeRuntimeError} turns
 * into the name a person reads, so a Codex credential failure says "Codex" and
 * never another runtime's name (DOR-1656).
 */
const CODEX_RUNTIME_TYPE = 'codex';
const TURN_CONTEXT_USAGE_TIMEOUT_MS = 100;

type ReadTurnContextUsage = (
  threadId: string,
  turnStartedAtMs: number,
  signal: AbortSignal
) => Promise<CodexTurnContextUsage | null>;

/** Optional dependencies for one Codex event-mapping context. */
export interface CodexEventContextOptions {
  /** Native rollout reader used after a completed turn. */
  readTurnContextUsage?: ReadTurnContextUsage;
  /** Maximum wait for optional native context metadata. */
  turnContextUsageTimeoutMs?: number;
  /** Clock seam for deterministic turn-boundary tests. */
  now?: () => number;
  /** Whether this turn is answering in a room. See {@link CodexEventContext.inRoomTurn}. */
  inRoomTurn?: boolean;
}

/**
 * What to show for one Codex failure: DorkOS's sentence when the CLI's words
 * mean a dead sign-in (with those words kept in `details`), the CLI's words
 * verbatim otherwise.
 *
 * Codex reports a failure through three channels — an error ITEM, `turn.failed`,
 * and a thrown stream — and a person should not be able to tell which one caught
 * it, so all three go through here.
 *
 * @param message - The CLI's own failure text.
 * @param options - Which channel is asking: its machine `code`, and whether that
 *   channel is `diagnostic` — one that also carries failures about something
 *   OTHER than the session's own sign-in, which narrows what counts as a
 *   credential signal (see `detectAuthError`'s `unambiguousOnly`).
 */
function codexErrorCopy(
  message: string,
  options: { code?: string; diagnostic?: boolean } = {}
): RuntimeErrorCopy {
  const { code, diagnostic = false } = options;
  return describeRuntimeError({
    runtimeType: CODEX_RUNTIME_TYPE,
    message,
    ...(code ? { code } : {}),
    unambiguousOnly: diagnostic,
  });
}

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
export interface CodexEventContext extends CodexMediaState {
  /** DorkOS session id stamped onto session_status/error/done events. */
  readonly sessionId: string;
  /** Codex thread id; set when `thread.started` arrives (persisted by the thread map). */
  threadId?: string;
  /** Local observation time for the current `turn.started` event. */
  turnStartedAtMs?: number;
  /**
   * True when this turn is answering in a ROOM rather than in a one-on-one
   * session (spec `room-canvas` §5.3).
   *
   * All the mapper needs to know: a room shares a canvas, not a whole window, so
   * every `control_ui` action that is not one of the six canvas verbs is refused
   * here exactly as a reaching action already is. What it does NOT need is the
   * room id or the acting member — Codex's canvas commands reach the table
   * through the room turn's own collector, which holds both.
   */
  readonly inRoomTurn?: boolean;
  /** Native context reader; optional metadata failures never fail the turn. */
  readonly readTurnContextUsage: ReadTurnContextUsage;
  /** Maximum wait for the native context reader. */
  readonly turnContextUsageTimeoutMs: number;
  /** Clock used to mark a turn's lower timestamp boundary. */
  readonly now: () => number;
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
 * @param sessionId - DorkOS session identifier stamped onto emitted events.
 * @param options - Optional native-usage and clock seams.
 */
export function createCodexEventContext(
  sessionId: string,
  options: CodexEventContextOptions = {}
): CodexEventContext {
  return {
    sessionId,
    readTurnContextUsage:
      options.readTurnContextUsage ??
      ((threadId, turnStartedAtMs, signal) =>
        readCodexTurnContextUsage({ threadId, turnStartedAtMs, signal })),
    turnContextUsageTimeoutMs: options.turnContextUsageTimeoutMs ?? TURN_CONTEXT_USAGE_TIMEOUT_MS,
    now: options.now ?? Date.now,
    ...(options.inRoomTurn === true ? { inRoomTurn: true } : {}),
    lastTextById: new Map(),
    lastOutputById: new Map(),
    startedToolIds: new Set(),
    pendingMedia: [],
    recordedMediaKeys: new Set(),
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
 * @param turnContextUsage - Native current-context measurement for a completed turn.
 */
export function mapCodexEvent(
  event: ThreadEvent,
  ctx: CodexEventContext,
  turnContextUsage: CodexTurnContextUsage | null = null
): StreamEvent[] {
  switch (event.type) {
    case 'thread.started':
      // No StreamEvent — the thread id feeds the sessionId↔threadId map
      // (thread-map.ts); the facade reads it off the context.
      ctx.threadId = event.thread_id;
      return [];
    case 'turn.started':
      ctx.turnStartedAtMs = ctx.now();
      return [];
    case 'turn.completed':
      // Live Codex streams expose accumulated SDK input usage here, not the
      // active context size. Only the verified native rollout measurement may
      // populate contextTokens/contextMaxTokens; when it is unavailable those
      // keys stay absent so the projector retains a prior valid reading.
      // Output/cache remain the SDK's existing cumulative accounting.
      // reasoning_output_tokens has no StreamEvent home of its own, so it is
      // folded into outputTokens. It is typed as required, but defaults to 0
      // defensively for older/future payloads.
      //
      // `terminalReason: 'completed'` marks the normal-completion outcome so
      // feedProjector latches it onto the synthesized turn_end (the failure
      // counterpart, 'error', is set on the turn.failed path below).
      return [
        {
          type: 'session_status',
          data: {
            sessionId: ctx.sessionId,
            ...(turnContextUsage ?? {}),
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
          // `turn.failed` is TERMINAL — it is the turn's own verdict, never a
          // note about one tool — so the full signal set applies here.
          data: {
            ...codexErrorCopy(event.error.message, { code: 'turn_failed' }),
            code: 'turn_failed',
          },
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

async function readCompletedTurnContext(
  ctx: CodexEventContext
): Promise<CodexTurnContextUsage | null> {
  const threadId = ctx.threadId;
  const turnStartedAtMs = ctx.turnStartedAtMs;
  if (threadId === undefined || turnStartedAtMs === undefined) return null;

  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (usage: CodexTurnContextUsage | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(usage);
    };
    const timer = setTimeout(
      () => {
        controller.abort();
        finish(null);
      },
      Math.max(0, ctx.turnContextUsageTimeoutMs)
    );
    void Promise.resolve()
      .then(() => ctx.readTurnContextUsage(threadId, turnStartedAtMs, controller.signal))
      .then(finish, () => finish(null));
  });
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
      const turnContextUsage =
        event.type === 'turn.completed' ? await readCompletedTurnContext(ctx) : null;
      for (const mapped of mapCodexEvent(event, ctx, turnContextUsage)) {
        yield mapped;
        if (mapped.type === 'done') return;
      }
    }
  } catch (err) {
    if (!isAbortError(err)) {
      yield {
        type: 'error',
        data: {
          // A thrown stream ENDED the turn, so like `turn.failed` it is the
          // session's own failure and takes the full signal set.
          ...codexErrorCopy(err instanceof Error ? err.message : String(err), {
            code: 'stream_error',
          }),
          code: 'stream_error',
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
    case 'error': {
      // Codex 0.147 reports these known warnings as error items even when the
      // turn continues. Keep them in the transient status strip, not the red
      // error treatment or durable failure history. Do not feed them into the
      // terminal dedupe state: if turn.failed repeats the same words, that
      // terminal verdict must still remain visible.
      const diagnostic = describeCodexDiagnostic(item.message);
      if (diagnostic) return [{ type: 'system_status', data: { message: diagnostic } }];

      // Unknown item errors remain visible. Remember the RAW message so a
      // following turn.failed with the same failure does not render it twice.
      ctx.lastErrorMessage = item.message;
      // The item is where a dead sign-in actually lands: live traffic reports it
      // here first and repeats it on `turn.failed`, which then dedupes itself
      // away — so this copy is the only copy a person reads (DOR-1656).
      //
      // `diagnostic` because this channel is NOT only the session's verdict.
      // The same item carries per-tool notes on a turn that goes on to succeed
      // (NOTES.md records a live "Falling back from WebSockets to HTTPS..."
      // item), so an MCP server's own "Failed to authenticate with server
      // github" would otherwise be answered with sign-in advice about Codex
      // while the Codex sign-in is fine. Narrowing costs us the vaguer wordings
      // here; `turn.failed` still catches those when the turn really dies.
      //
      // Only failures with an actionable recovery gain a `category`, and that
      // asymmetry is deliberate. A category-less item error renders its exact
      // message; categorising an ordinary item failure would hide its only
      // useful account. Auth and known model failures have a better next step,
      // and their raw text survives in `details`.
      const copy = codexErrorCopy(item.message, { diagnostic: true });
      if (
        copy.category !== 'auth_error' &&
        copy.category !== 'model_unavailable' &&
        copy.category !== 'runtime_update_required'
      ) {
        return [{ type: 'error', data: { message: item.message, code: 'item_error' } }];
      }
      return [{ type: 'error', data: { ...copy, code: 'item_error' } }];
    }
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

/**
 * Extract the display result of an MCP call: error message on failure, joined
 * text blocks on success.
 *
 * Text ONLY, and that is now a statement rather than an omission: MCP's
 * `ImageContent` blocks are read by {@link recordCodexMedia} instead, which
 * records them for `media-capture.ts` to store. Filtering them away here used to
 * be the whole story — a tool that answered with a screenshot answered with
 * nothing.
 */
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
 * THIS IS THE ENFORCEMENT POINT for Codex's consent gate (DOR-639). The scoped
 * MCP stub refuses a reaching action too, but it only tells the AGENT — this
 * mapper reads the raw `item.arguments` recorded by Codex and never sees the
 * stub's result, so a reaching action that got past the stub would still take
 * effect here. An action {@link isUiActionRefusedOnCodex} rejects therefore
 * produces a typed `error` event and no `ui_command`, the same shape the
 * `ui_command_invalid` branch below uses.
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
  if (isUiActionRefusedOnCodex(parsed.data.action)) {
    return [
      {
        type: 'error',
        data: {
          message: uiActionRefusalMessage(parsed.data.action),
          code: UI_COMMAND_REFUSED_CODE,
        },
      },
    ];
  }
  // The ROOM rule, through the same seam and for the same reason: this mapper is
  // the enforcement point, because it reads the raw arguments Codex recorded and
  // never sees what the MCP stub told the agent. An action a room does not
  // accept therefore produces a typed error and NO `ui_command` — so nothing
  // downstream, the room turn's collector included, can act on it.
  if (ctx.inRoomTurn === true && isUiActionRefusedInRoom(parsed.data.action)) {
    return [
      {
        type: 'error',
        data: { message: NOT_IN_A_ROOM_MESSAGE, code: UI_COMMAND_REFUSED_CODE },
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
    // Whatever the tool returned that was not text. Recorded, not stored: this
    // mapper does no I/O, so `captureCodexMedia` drains the intent from the
    // runtime's turn loop and announces the picture by URL. A result whose only
    // block is an image produces no `tool_result` event at all (there is no text
    // to put in one), which is exactly how it used to disappear.
    recordCodexMedia(ctx, item.id, item.result?.content);
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
