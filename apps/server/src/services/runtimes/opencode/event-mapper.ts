/**
 * OpenCode event mapper — pure functions translating `@opencode-ai/sdk` SSE
 * events into DorkOS StreamEvents (`packages/shared/src/schemas.ts`).
 *
 * SOURCE OF TRUTH: SDK v1.17.13 generated types (`dist/gen/types.gen.d.ts`,
 * 32-member `Event` union) cross-checked against the upstream server source
 * at tag `v1.17.13` (`anomalyco/opencode`, `packages/opencode/src/session/
 * {processor,session,status,run-state}.ts` and the httpapi event handlers).
 *
 * DEMUX (one global stream, many sessions): the adapter subscribes ONCE per
 * runtime to `client.global.event()` and filters per session with
 * {@link matchesOpenCodeSession} on `{directory, sessionID}` — per-directory
 * `/event` subscriptions lazily boot instances and are avoided (NOTES.md §1).
 * The filter matches on the OPENCODE session id (`ses_*`), while emitted
 * StreamEvents are stamped with the DORKOS session id supplied to
 * {@link createOpenCodeEventContext} — the two ids are DIFFERENT namespaces,
 * bridged by `session-mapper.ts` at the subscription site (task 3.6).
 *
 * DELTA SEMANTICS (verified upstream at v1.17.13, `processor.ts` +
 * `session.ts#updatePart/updatePartDelta`): `message.part.updated` carries a
 * CUMULATIVE part snapshot and fires at part start (`text: ""`), at part end
 * (full text), and on every tool state transition. True text increments ride
 * a separate `message.part.delta` wire event ({sessionID, messageID, partID,
 * field, delta}) that the SDK's Event union does NOT declare — modeled here
 * as {@link EventMessagePartDelta}. (The SDK's optional `delta` field on
 * `message.part.updated` is a type-level remnant; the v1.17.13 server never
 * populates it, and this mapper ignores it in favor of suffix-diffing the
 * cumulative snapshots, which subsumes it.) The mapper therefore streams from
 * `message.part.delta` when present and emits only the UNSEEN suffix of each
 * cumulative snapshot, so both wire styles produce identical output with no
 * double emission.
 *
 * TURN-END VERDICT (upstream evidence): `session.idle` is the authoritative
 * turn terminal. `SessionStatus.set(sessionID, {type:"idle"})` (`status.ts`)
 * always publishes `session.status{idle}` AND `session.idle`; it fires on
 * success (runner drain, `run-state.ts#onIdle`), on failure
 * (`processor.ts#halt` → `session.error` then idle), and on interrupt/cancel
 * (`run-state.ts#cancel`). The mapper maps `session.idle` → terminal `done`
 * and deliberately ignores `session.status{idle}` (which always precedes it)
 * to avoid double terminals.
 *
 * ABORT SHAPE: an interrupt surfaces as `session.error` carrying
 * `MessageAbortedError` followed by `session.idle`. Aborts are user-initiated,
 * not failures, so that error name is suppressed and the turn ends with a
 * plain `done` — mirroring the Codex mapper's AbortError handling.
 *
 * TOOL APPROVALS: OpenCode supportsToolApproval = TRUE. `permission.updated`
 * maps to `approval_required` with `toolCallId = Permission.id` (the
 * permission id, NOT `callID`): the id the client echoes back through
 * `approveTool()` is exactly what `POST /session/{id}/permissions/
 * {permissionID}` needs, so 3.6's respond wiring is a direct pass-through.
 * `hasSuggestions` is false by design: OpenCode's `"always"` response would
 * persist a rule in OpenCode's own store and diverge from DorkOS's approval
 * model, so DorkOS only offers once/reject (NOTES.md §2).
 *
 * SUBAGENTS: OpenCode delegates through its built-in `task` tool, which creates
 * a CHILD session (`Session.parentID`) and runs the chosen agent in it. There is
 * no dedicated subagent event on the wire — the whole signal is carried by the
 * ordinary `task` tool part in the PARENT session, whose `state.metadata` gains
 * `{parentSessionId, sessionId, model}` once the child exists (NOTES.md §7).
 * The mapper therefore folds a `task` tool part into the runtime-neutral
 * background-task vocabulary (`background_task_started`/`_progress`/`_done`,
 * which the session normalizer turns into `subagent_update`), and admits the
 * child session's own tool parts through {@link matchesOpenCodeSubagentSession}
 * so the parent's card can report how many tools the subagent has run. Child
 * text, todos and terminals are deliberately dropped: only the parent session
 * may write the transcript or end the turn.
 *
 * @module services/runtimes/opencode/event-mapper
 */
import type {
  AssistantMessage,
  Event,
  GlobalEvent,
  Permission,
  SessionStatus,
  Todo,
  ToolPart,
} from '@opencode-ai/sdk';
import type { SessionTaskStatus, StreamEvent, TaskItem } from '@dorkos/shared/types';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import { SESSIONS } from '../../../config/constants.js';

/**
 * The true text-increment wire event at v1.17.13, published on every
 * `text-delta`/`reasoning-delta` but ABSENT from the SDK's generated Event
 * union (`processor.ts` → `session.ts#updatePartDelta` →
 * `SessionV1.Event.PartDelta`, type `"message.part.delta"`). Declared here so
 * the mapper and the 3.6 subscription can handle it type-safely.
 */
export interface EventMessagePartDelta {
  type: 'message.part.delta';
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    /** Which part field the delta extends — only `"text"` is mapped. */
    field: string;
    delta: string;
  };
}

/** Everything the v1.17.13 wire can carry: the SDK union + the undeclared delta event. */
export type OpenCodeWireEvent = Event | EventMessagePartDelta;

/** The error name OpenCode stamps on interrupts — suppressed, not surfaced. */
const ABORT_ERROR_NAME = 'MessageAbortedError';

/**
 * OpenCode's built-in delegation tool (`GET /experimental/tool/ids` at
 * v1.18.15: `… "task" …`). Every subagent run in OpenCode goes through it.
 */
const TASK_TOOL_NAME = 'task';

/**
 * The tool-part metadata key holding the subagent's child session id. The task
 * tool publishes `{parentSessionId, sessionId, model}` onto its own part right
 * after creating the child session and before prompting it.
 */
const SUBAGENT_SESSION_METADATA_KEY = 'sessionId';

/** Its companion key, naming the session that DELEGATED — never a child. */
const SUBAGENT_PARENT_SESSION_METADATA_KEY = 'parentSessionId';

/**
 * Metadata flag OpenCode stamps on every tool part it tears down on abort — the
 * STRUCTURAL stop signal, and the one upstream's own renderer keys on
 * (`state.status === "error" && (metadata.interrupted === true || error ===
 * "Tool execution aborted")` → `cancelled`).
 */
const SUBAGENT_INTERRUPTED_METADATA_KEY = 'interrupted';

/**
 * Tool-error text that means a subagent was STOPPED rather than failed. All
 * four shapes verified against the compiled `opencode-ai@1.18.15` binary:
 *
 * - `Tool execution aborted` — `SessionProcessor.cleanup` on abort, alongside
 *   `metadata.interrupted: true`. **This is the ordinary user-stop path.**
 * - `Tool execution interrupted` — `SessionRunner.failUnsettledTools`.
 * - `Tool execution failed: Task cancelled` — the TaskTool's own
 *   `Error("Task cancelled")` after the runner wraps it; the bare message never
 *   reaches the wire.
 * - `Cancelled` — `SessionPrompt.handleSubtask`'s `onInterrupt`, reachable only
 *   when a client sends a `SubtaskPartInput` (DorkOS never does).
 *
 * Anchoring on the last one alone (as this first shipped) painted an ordinary
 * stop as a failure, because it is the one path DorkOS cannot reach.
 */
const SUBAGENT_STOPPED_PATTERN =
  /^(?:cancelled|tool execution (?:aborted|interrupted)|tool execution failed: task cancelled)$/i;

/**
 * Message signals that a turn failed because the chosen model is missing — a
 * not-installed Ollama tag, or a model a provider does not serve. OpenCode has
 * NO typed model-not-found error: the failure arrives as a generic
 * `APIError`/`UnknownError` whose `data.message` carries the provider's reason,
 * so this matches the message conservatively — only DEFINITIVE "no such model"
 * shapes, never softer wording. Verified upstream shapes: Ollama replies
 * `model "<tag>" not found, try pulling it first`; OpenRouter replies `No
 * endpoints found for <model>`.
 *
 * Deliberately excludes phrases like "temporarily not available"/"unavailable":
 * those read as transient outages a retry could clear, and telling the user to
 * pick a different model would be wrong. Everything not matched here stays a
 * generic execution error (spec §11).
 */
const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\bmodel\b[^.]*\bnot\s+found\b/i,
  /\bno\s+endpoints?\s+found\b/i,
  /\bunknown\s+model\b/i,
];

/** Plain-language turn error for an unavailable model — points at the model menu (spec §11). */
const MODEL_UNAVAILABLE_MESSAGE =
  "That model isn't available. Pick another one from the model menu.";

/** Whether a provider error message reads as an unavailable/unknown model. */
function isModelUnavailableMessage(message: string): boolean {
  return MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Session error union member shape (all variants carry `name` + `data`). */
type OpenCodeSessionError = NonNullable<
  Extract<Event, { type: 'session.error' }>['properties']['error']
>;

/** One live subagent run, keyed in the context by the `task` tool's callID. */
interface OpenCodeSubagentRun {
  /** `state.time.start` of the task tool part — the baseline for progress durations. */
  readonly startedAt: number;
  /** Distinct child tool callIDs observed so far; the size is `toolUses`. */
  readonly toolCallIds: Set<string>;
  /** The subagent's child OpenCode session id, once its metadata reveals it. */
  childSessionId?: string;
  /** True once the terminal `background_task_done` has been emitted. */
  ended: boolean;
}

/**
 * Per-turn mutable state threaded through the pure mapping functions —
 * the OpenCode analog of the Codex adapter's `CodexEventContext`.
 */
export interface OpenCodeEventContext {
  /**
   * DORKOS session id stamped onto done/session_status events. NOT the
   * OpenCode `ses_*` id — the demux filter matches on that one; the caller
   * (3.6) bridges the namespaces via the session mapper.
   */
  readonly sessionId: string;
  /** Last-seen cumulative text per text/reasoning part id (delta baseline). */
  readonly lastTextByPartId: Map<string, string>;
  /** Part kind per part id, learned from snapshots — routes `message.part.delta`. */
  readonly partKindById: Map<string, 'text' | 'reasoning'>;
  /** Tool callIDs that already emitted tool_call_start. */
  readonly startedToolCallIds: Set<string>;
  /**
   * Tool callIDs that already emitted their terminal end/result. Compaction
   * re-saves completed tool parts (`time.compacted`), re-publishing the
   * snapshot — this guard keeps the terminal pair single-shot.
   */
  readonly endedToolCallIds: Set<string>;
  /** Live subagent runs by `task` tool callID (the DorkOS background-task id). */
  readonly subagentRuns: Map<string, OpenCodeSubagentRun>;
  /**
   * Child OpenCode session id → the `task` callID running in it, learned from
   * task-part metadata. Entries are kept for the whole turn even after the
   * subagent finishes: a straggling child event must keep being recognised as
   * a child (and dropped), never fall through to the parent's transcript.
   */
  readonly subagentTaskIdBySession: Map<string, string>;
}

/**
 * Create a fresh mapping context for one turn.
 *
 * @param sessionId - DORKOS session identifier stamped onto emitted events
 *   (not the OpenCode `ses_*` id — see {@link OpenCodeEventContext.sessionId})
 */
export function createOpenCodeEventContext(sessionId: string): OpenCodeEventContext {
  return {
    sessionId,
    lastTextByPartId: new Map(),
    partKindById: new Map(),
    startedToolCallIds: new Set(),
    endedToolCallIds: new Set(),
    subagentRuns: new Map(),
    subagentTaskIdBySession: new Map(),
  };
}

/**
 * Extract the OpenCode session id an event belongs to — the sessionID half
 * of the `{directory, sessionID}` demux key. Returns undefined for events
 * that are not session-scoped (installation, lsp, tui, pty, files, vcs…).
 */
export function extractOpenCodeSessionId(event: OpenCodeWireEvent): string | undefined {
  switch (event.type) {
    case 'message.updated':
      return event.properties.info.sessionID;
    case 'message.part.updated':
      return event.properties.part.sessionID;
    case 'message.part.delta':
    case 'message.removed':
    case 'message.part.removed':
    case 'permission.updated':
    case 'permission.replied':
    case 'session.status':
    case 'session.idle':
    case 'session.compacted':
    case 'session.diff':
    case 'session.error':
    case 'todo.updated':
    case 'command.executed':
      return event.properties.sessionID;
    case 'session.created':
    case 'session.updated':
    case 'session.deleted':
      return event.properties.info.id;
    default:
      return undefined;
  }
}

/**
 * The per-session demux filter for the ONE `client.global.event()`
 * subscription: an event belongs to a session iff BOTH the envelope
 * directory and the payload's OpenCode session id match (NOTES.md §1).
 *
 * @param globalEvent - `{directory, payload}` envelope from `/global/event`
 * @param directory - The session's working directory (as stored by OpenCode)
 * @param opencodeSessionId - The OpenCode-native `ses_*` id (from session-mapper)
 */
export function matchesOpenCodeSession(
  globalEvent: GlobalEvent,
  directory: string,
  opencodeSessionId: string
): boolean {
  if (globalEvent.directory !== directory) return false;
  return extractOpenCodeSessionId(globalEvent.payload as OpenCodeWireEvent) === opencodeSessionId;
}

/**
 * The companion demux filter for a subagent's CHILD session: true once a `task`
 * tool part in this turn has revealed the child session id and before the
 * subagent's terminal clears it. OR this with {@link matchesOpenCodeSession} at
 * the subscription site so the parent turn can report what its subagents are
 * doing (`background_task_progress`).
 *
 * Learning is done by the mapper, which sees events only after they are
 * admitted, so a child event that arrives before the mapper has drained the
 * metadata snapshot is dropped. That costs progress beats, never correctness:
 * the subagent's start and terminal ride the PARENT session, which is always
 * admitted.
 *
 * @param globalEvent - `{directory, payload}` envelope from `/global/event`
 * @param directory - The session's working directory (as stored by OpenCode)
 * @param ctx - The turn's mapping context (holds the known child sessions)
 */
export function matchesOpenCodeSubagentSession(
  globalEvent: GlobalEvent,
  directory: string,
  ctx: OpenCodeEventContext
): boolean {
  if (ctx.subagentTaskIdBySession.size === 0) return false;
  if (globalEvent.directory !== directory) return false;
  const sessionId = extractOpenCodeSessionId(globalEvent.payload as OpenCodeWireEvent);
  return sessionId !== undefined && ctx.subagentTaskIdBySession.has(sessionId);
}

/**
 * Map one OpenCode wire event to zero or more StreamEvents. Pure aside from
 * the mutable {@link OpenCodeEventContext} (delta baselines, tool guards).
 *
 * `session.idle` is the only event that emits the terminal `done`;
 * {@link mapOpenCodeTurn} guarantees that invariant for whole streams,
 * including aborted or crashed ones.
 *
 * Ignore-list default (documented, not exhaustive-checked — the 32-member
 * union plus wire-only extras like `server.heartbeat` make a `never` check
 * counterproductive): `server.instance.disposed`, `installation.*`, `lsp.*`,
 * `message.removed`, `message.part.removed`, `session.created/updated/
 * deleted` (session-list watcher domain, not the turn stream),
 * `session.diff`, `file.edited`, `file.watcher.updated`, `command.executed`,
 * `vcs.branch.updated`, `tui.*`, `pty.*`, `server.connected`, and any
 * undeclared wire type (e.g. `server.heartbeat`).
 *
 * @param event - The OpenCode wire event to translate
 * @param ctx - Per-turn mapping context (mutated)
 */
export function mapOpenCodeEvent(
  event: OpenCodeWireEvent,
  ctx: OpenCodeEventContext
): StreamEvent[] {
  // A subagent's child session speaks only through its parent's task card:
  // route it away from the parent-session mapping entirely, so its text never
  // lands in the transcript and its `session.idle` never ends the parent turn.
  const subagentTaskId = resolveSubagentTaskId(event, ctx);
  if (subagentTaskId !== undefined) return mapSubagentChildEvent(event, subagentTaskId, ctx);

  switch (event.type) {
    case 'message.part.updated':
      return mapPartSnapshot(event.properties.part, ctx);
    case 'message.part.delta':
      return mapPartDelta(event.properties, ctx);
    case 'message.updated':
      return mapMessageUpdated(event.properties.info, ctx);
    case 'permission.updated':
      return mapPermission(event.properties);
    case 'permission.replied':
      // Resolution echo (possibly from another client, e.g. the TUI) — clear
      // the pending approval card instead of leaving an answerable ghost.
      return [
        {
          type: 'interaction_cancelled',
          data: { interactionId: event.properties.permissionID },
        },
      ];
    case 'session.status':
      return mapSessionStatus(event.properties.status);
    case 'session.idle':
      // The authoritative turn terminal (see module doc, TURN-END VERDICT).
      return [{ type: 'done', data: { sessionId: ctx.sessionId } }];
    case 'session.compacted':
      // OpenCode reports compaction as a single post-hoc completion — it exposes
      // no start signal and no percent, so honest degradation is a lone
      // `operation_progress` `done` (DOR-110) plus the durable `compact_boundary`
      // row. No metadata upstream — an empty boundary still renders the marker.
      return [
        {
          type: 'operation_progress',
          data: { operation: 'compaction', state: 'done', determinate: false },
        },
        { type: 'compact_boundary', data: {} },
      ];
    case 'session.error':
      return mapSessionError(event.properties.error);
    case 'todo.updated':
      return mapTodos(event.properties.todos);
    default:
      // Documented ignore list — see the function doc above.
      return [];
  }
}

/**
 * Map a whole demuxed per-session event stream, guaranteeing the conformance
 * invariant that exactly one terminal `done` ends the StreamEvent stream:
 *
 * - after `done` (`session.idle`) the generator returns without pulling more;
 * - an AbortError (subscription torn down mid-turn) ends the turn with a
 *   plain `done` — user-initiated, not an error;
 * - any other thrown error (e.g. the sidecar dying) becomes a typed `error`
 *   followed by `done`;
 * - a stream that ends without `session.idle` still gets its trailing `done`
 *   so consumers can key turn teardown on it.
 *
 * @param events - Demuxed per-session wire events (from the global stream)
 * @param ctx - Per-turn mapping context (mutated)
 */
export async function* mapOpenCodeTurn(
  events: AsyncIterable<OpenCodeWireEvent>,
  ctx: OpenCodeEventContext
): AsyncGenerator<StreamEvent> {
  try {
    for await (const event of events) {
      for (const mapped of mapOpenCodeEvent(event, ctx)) {
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

// === Part mapping ===

/** Route a cumulative part snapshot to its per-type mapper. */
function mapPartSnapshot(
  part: Extract<Event, { type: 'message.part.updated' }>['properties']['part'],
  ctx: OpenCodeEventContext
): StreamEvent[] {
  switch (part.type) {
    case 'text':
      // `ignored` parts are hidden bookkeeping text (upstream flag) — skip.
      if (part.ignored === true) return [];
      return emitTextSuffix(part.id, 'text', part.text, ctx);
    case 'reasoning':
      return emitTextSuffix(part.id, 'reasoning', part.text, ctx);
    case 'tool':
      return mapToolPart(part, ctx);
    default:
      // step-start/step-finish/snapshot/patch/agent/retry/compaction/file/
      // subtask parts are turn bookkeeping: usage rides message.updated,
      // retries ride session.status, and file changes ride their tool parts.
      return [];
  }
}

/**
 * Emit the unseen suffix of a cumulative text snapshot and advance the
 * baseline. Falls back to the full new text when the snapshot is not a
 * prefix extension of what was last seen (defensive; never observed
 * upstream). Baselines are kept for the whole turn — a completed part can be
 * re-published (e.g. plugin text rewrite), and clearing early would re-emit
 * the entire text.
 */
function emitTextSuffix(
  partId: string,
  kind: 'text' | 'reasoning',
  next: string,
  ctx: OpenCodeEventContext
): StreamEvent[] {
  ctx.partKindById.set(partId, kind);
  const previous = ctx.lastTextByPartId.get(partId) ?? '';
  const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
  ctx.lastTextByPartId.set(partId, next);
  if (delta.length === 0) return [];
  return [{ type: kind === 'reasoning' ? 'thinking_delta' : 'text_delta', data: { text: delta } }];
}

/**
 * Map a true text increment (`message.part.delta`). The part kind is learned
 * from the preceding start snapshot (upstream always publishes `text-start`/
 * `reasoning-start` before deltas); orphan deltas for unknown parts are
 * dropped — the final cumulative snapshot covers their content.
 */
function mapPartDelta(
  properties: EventMessagePartDelta['properties'],
  ctx: OpenCodeEventContext
): StreamEvent[] {
  if (properties.field !== 'text' || properties.delta.length === 0) return [];
  const kind = ctx.partKindById.get(properties.partID);
  if (kind === undefined) return [];
  const previous = ctx.lastTextByPartId.get(properties.partID) ?? '';
  ctx.lastTextByPartId.set(properties.partID, previous + properties.delta);
  return [
    {
      type: kind === 'reasoning' ? 'thinking_delta' : 'text_delta',
      data: { text: properties.delta },
    },
  ];
}

/**
 * Emit `tool_call_start` for a tool call unless it already started — covers
 * calls whose first observed snapshot is already `completed`/`error`.
 */
function ensureToolStart(
  events: StreamEvent[],
  toolCallId: string,
  toolName: string,
  input: string,
  ctx: OpenCodeEventContext
): void {
  if (ctx.startedToolCallIds.has(toolCallId)) return;
  ctx.startedToolCallIds.add(toolCallId);
  events.push({
    type: 'tool_call_start',
    data: { toolCallId, toolName, input, status: 'running' },
  });
}

/**
 * tool part → tool_call_start when execution begins (`running` — `pending`
 * still has a streaming input), then tool_call_end + tool_result on the
 * terminal state. Keyed by `callID` (the provider call id `Permission.callID`
 * also references); tool names pass through verbatim (`bash`, `edit`,
 * `webfetch`, …).
 */
function mapToolPart(part: ToolPart, ctx: OpenCodeEventContext): StreamEvent[] {
  const events = mapToolCall(part, ctx);
  if (part.tool !== TASK_TOOL_NAME) return events;
  // A `task` call is BOTH a tool call and a subagent run — claude-code renders
  // the same pair (a Task tool card plus a background-task card), so emit both.
  return [...events, ...mapSubagentTaskPart(part, ctx)];
}

/** The runtime-neutral tool-call half of a tool part (every tool, `task` included). */
function mapToolCall(part: ToolPart, ctx: OpenCodeEventContext): StreamEvent[] {
  const toolCallId = part.callID;
  const state = part.state;
  const events: StreamEvent[] = [];

  switch (state.status) {
    case 'pending':
      // Input still streaming — start once it is finalized (running).
      return [];
    case 'running':
      ensureToolStart(events, toolCallId, part.tool, JSON.stringify(state.input), ctx);
      return events;
    case 'completed': {
      if (ctx.endedToolCallIds.has(toolCallId)) return [];
      ctx.endedToolCallIds.add(toolCallId);
      ensureToolStart(events, toolCallId, part.tool, JSON.stringify(state.input), ctx);
      events.push({
        type: 'tool_call_end',
        data: { toolCallId, toolName: part.tool, status: 'complete' },
      });
      if (state.output) {
        events.push({
          type: 'tool_result',
          data: { toolCallId, toolName: part.tool, result: state.output, status: 'complete' },
        });
      }
      return events;
    }
    case 'error': {
      if (ctx.endedToolCallIds.has(toolCallId)) return [];
      ctx.endedToolCallIds.add(toolCallId);
      ensureToolStart(events, toolCallId, part.tool, JSON.stringify(state.input), ctx);
      events.push({
        type: 'tool_call_end',
        data: { toolCallId, toolName: part.tool, status: 'error' },
      });
      if (state.error) {
        events.push({
          type: 'tool_result',
          data: { toolCallId, toolName: part.tool, result: state.error, status: 'error' },
        });
      }
      return events;
    }
  }
}

// === Subagents (the `task` tool) ===

/** Read a string field off a tool part's input/metadata bag, or undefined. */
function readStringField(
  bag: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = bag?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A failed `task` part → the DorkOS background-task outcome. The structural
 * signal wins: `interrupted` is read off the tool STATE's metadata and then the
 * PART's, exactly as upstream's own cancelled-vs-error renderer resolves it.
 * The text match is the fallback for the stop shapes that carry no flag.
 */
function subagentFailureStatus(
  error: string,
  stateMetadata: Record<string, unknown> | undefined,
  partMetadata: Record<string, unknown> | undefined
): 'failed' | 'stopped' {
  const interrupted =
    stateMetadata?.[SUBAGENT_INTERRUPTED_METADATA_KEY] ??
    partMetadata?.[SUBAGENT_INTERRUPTED_METADATA_KEY];
  if (interrupted === true) return 'stopped';
  return SUBAGENT_STOPPED_PATTERN.test(error.trim()) ? 'stopped' : 'failed';
}

/**
 * The child session a `task` part delegates to, or undefined when it has not
 * been created yet — or when the metadata names the PARENT session.
 *
 * That last guard is not reachable at 1.18.15, and is cheap insurance against a
 * shape change with a catastrophic failure mode: admitting the parent as its own
 * child routes the whole turn down the child path, where its text is dropped,
 * its task completion is misread as progress, and its `session.idle` never ends
 * the turn. `part.sessionID` is the structural truth (a `task` part always lives
 * in the parent session), so it is checked even if `parentSessionId` disagrees.
 */
function readSubagentChildSessionId(part: ToolPart): string | undefined {
  const metadata = part.state.status === 'pending' ? undefined : part.state.metadata;
  const childSessionId = readStringField(metadata, SUBAGENT_SESSION_METADATA_KEY);
  if (childSessionId === undefined) return undefined;
  if (childSessionId === part.sessionID) return undefined;
  if (childSessionId === readStringField(metadata, SUBAGENT_PARENT_SESSION_METADATA_KEY)) {
    return undefined;
  }
  return childSessionId;
}

/**
 * Fold a `task` tool part into the background-task lifecycle: the first
 * non-pending snapshot opens the subagent, every snapshot may reveal the child
 * session id (the task tool sets it right after creating the child), and the
 * terminal snapshot closes it with the tool count the child session reported.
 */
function mapSubagentTaskPart(part: ToolPart, ctx: OpenCodeEventContext): StreamEvent[] {
  const state = part.state;
  // `pending` has no `time` yet — the input is still streaming (see mapToolCall).
  if (state.status === 'pending') return [];

  const taskId = part.callID;
  const childSessionId = readSubagentChildSessionId(part);
  const events: StreamEvent[] = [];

  let run = ctx.subagentRuns.get(taskId);
  if (run === undefined) {
    run = { startedAt: state.time.start, toolCallIds: new Set(), ended: false };
    ctx.subagentRuns.set(taskId, run);
    const description = readStringField(state.input, 'description');
    events.push({
      type: 'background_task_started',
      data: {
        taskId,
        taskType: 'agent',
        startedAt: state.time.start,
        toolUseId: taskId,
        ...(description !== undefined ? { description } : {}),
        ...(childSessionId !== undefined ? { subagentSessionId: childSessionId } : {}),
      },
    });
  }

  if (childSessionId !== undefined && run.childSessionId === undefined) {
    run.childSessionId = childSessionId;
    ctx.subagentTaskIdBySession.set(childSessionId, taskId);
  }

  if (state.status === 'running' || run.ended) return events;

  run.ended = true;
  events.push({
    type: 'background_task_done',
    data: {
      taskId,
      status:
        state.status === 'completed'
          ? 'completed'
          : subagentFailureStatus(state.error, state.metadata, part.metadata),
      durationMs: state.time.end - run.startedAt,
      ...(run.toolCallIds.size > 0 ? { toolUses: run.toolCallIds.size } : {}),
    },
  });
  return events;
}

/**
 * The `task` callID a wire event belongs to when it came from a live subagent's
 * child session, or undefined when it belongs to the parent session.
 */
function resolveSubagentTaskId(
  event: OpenCodeWireEvent,
  ctx: OpenCodeEventContext
): string | undefined {
  if (ctx.subagentTaskIdBySession.size === 0) return undefined;
  const sessionId = extractOpenCodeSessionId(event);
  if (sessionId === undefined) return undefined;
  return ctx.subagentTaskIdBySession.get(sessionId);
}

/**
 * Map one event from a subagent's child session onto its parent task card. Only
 * the child's tool calls are reported — one `background_task_progress` beat per
 * distinct call, mirroring claude-code's `task_progress` cadence. Everything
 * else the child emits (text, reasoning, todos, permissions, its own terminal)
 * is dropped: the child is not the turn, and its `session.idle` must never be
 * mistaken for the parent's.
 */
function mapSubagentChildEvent(
  event: OpenCodeWireEvent,
  taskId: string,
  ctx: OpenCodeEventContext
): StreamEvent[] {
  if (event.type !== 'message.part.updated') return [];
  const part = event.properties.part;
  if (part.type !== 'tool' || part.state.status === 'pending') return [];

  const run = ctx.subagentRuns.get(taskId);
  if (run === undefined || run.ended || run.toolCallIds.has(part.callID)) return [];
  run.toolCallIds.add(part.callID);

  return [
    {
      type: 'background_task_progress',
      data: {
        taskId,
        toolUses: run.toolCallIds.size,
        lastToolName: part.tool,
        durationMs: Math.max(0, part.state.time.start - run.startedAt),
      },
    },
  ];
}

// === Message / permission / status mapping ===

/**
 * message.updated → usage `session_status` once the assistant message
 * completes (`time.completed` set). In-flight updates and user messages emit
 * nothing; message-level errors are NOT mapped here — upstream `halt()`
 * publishes the same failure as `session.error`, which owns error mapping.
 */
function mapMessageUpdated(
  info: Extract<Event, { type: 'message.updated' }>['properties']['info'],
  ctx: OpenCodeEventContext
): StreamEvent[] {
  if (info.role !== 'assistant') return [];
  const assistant: AssistantMessage = info;
  if (assistant.time.completed === undefined) return [];
  return [
    {
      type: 'session_status',
      data: {
        sessionId: ctx.sessionId,
        model: assistant.modelID,
        costUsd: assistant.cost,
        contextTokens: assistant.tokens.input,
        outputTokens: assistant.tokens.output,
        cacheReadTokens: assistant.tokens.cache.read,
        cacheCreationTokens: assistant.tokens.cache.write,
        // OpenCode fronts multiple providers with no shared quota, so it reports
        // pay-as-you-go cost (the one honest, legible signal); the active
        // provider/model names the tooltip. No utilization, no reset window.
        usage: {
          kind: 'pay-as-you-go',
          costUsd: assistant.cost,
          detail: `${assistant.providerID}/${assistant.modelID}`,
        },
      },
    },
  ];
}

/**
 * permission.updated → `approval_required`. `toolCallId` carries the
 * PERMISSION id (see module doc, TOOL APPROVALS) so the client's echo through
 * `approveTool()` is directly the respond-endpoint path param. The permission
 * mode enforcement (auto-answering under acceptEdits/bypassPermissions) is
 * the facade's job (task 3.6) — the mapper surfaces every request it is
 * handed.
 */
function mapPermission(permission: Permission): StreamEvent[] {
  const { pattern, metadata } = permission;
  return [
    {
      type: 'approval_required',
      data: {
        toolCallId: permission.id,
        toolName: permission.type,
        input: JSON.stringify({ ...(pattern !== undefined ? { pattern } : {}), ...metadata }),
        timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
        startedAt: permission.time.created,
        title: permission.title,
        hasSuggestions: false,
      },
    },
  ];
}

/**
 * session.status → non-terminal diagnostics only. `retry` surfaces as a
 * `system_status` line (the shape lacks `maxRetries`, so `api_retry` cannot
 * be populated honestly); `busy` is implicit in the turn being live; `idle`
 * is deliberately ignored — `session.idle` (always published immediately
 * after) is the single terminal, avoiding a double `done`.
 */
function mapSessionStatus(status: SessionStatus): StreamEvent[] {
  if (status.type !== 'retry') return [];
  return [
    {
      type: 'system_status',
      data: { message: `Retrying after error (attempt ${status.attempt}): ${status.message}` },
    },
  ];
}

/**
 * session.error → typed non-terminal `error` (the turn still terminates via
 * the `session.idle` that upstream `halt()` publishes right after). The
 * interrupt shape (`MessageAbortedError`) is suppressed entirely — aborts are
 * user-initiated, not failures.
 */
function mapSessionError(error: OpenCodeSessionError | undefined): StreamEvent[] {
  if (error === undefined) {
    return [
      {
        type: 'error',
        data: {
          message: 'OpenCode reported a session error',
          code: 'session_error',
          category: 'execution_error',
        },
      },
    ];
  }
  if (error.name === ABORT_ERROR_NAME) return [];
  const data: Record<string, unknown> = error.data;
  const message =
    typeof data.message === 'string' && data.message.length > 0 ? data.message : error.name;
  // An unavailable/unknown model is the one provider failure with a plain-language
  // remedy: pick another model. Map it to friendly copy pointing at the model menu
  // instead of leaking the raw sidecar/provider string (spec §11).
  if (isModelUnavailableMessage(message)) {
    return [
      {
        type: 'error',
        data: {
          message: MODEL_UNAVAILABLE_MESSAGE,
          code: 'model_unavailable',
          category: 'execution_error',
        },
      },
    ];
  }
  return [
    {
      type: 'error',
      data: {
        message,
        code: error.name,
        category: detectAuthError({ message, code: error.name }) ? 'auth_error' : 'execution_error',
      },
    },
  ];
}

// === Todos ===

/** OpenCode todo status → DorkOS task status; `cancelled` entries are dropped. */
function mapTodoStatus(status: string): SessionTaskStatus {
  if (status === 'in_progress' || status === 'completed') return status;
  return 'pending';
}

/**
 * Project OpenCode todos onto DorkOS task items. Cancelled todos are dropped
 * rather than mis-labeled (DorkOS task status has no cancelled member).
 * Shared by the turn stream (`todo.updated`) and the facade's
 * `getSessionTasks` (`GET /session/{id}/todo` — the same Todo shape).
 */
export function mapOpenCodeTodos(todos: Todo[]): TaskItem[] {
  return todos
    .filter((entry) => entry.status !== 'cancelled')
    .map((entry) => ({
      id: entry.id,
      subject: entry.content,
      status: mapTodoStatus(entry.status),
    }));
}

/**
 * todo.updated → `task_update` snapshot, mirroring the Codex/Claude TodoWrite
 * mapping; an empty result emits nothing.
 */
function mapTodos(todos: Todo[]): StreamEvent[] {
  const tasks = mapOpenCodeTodos(todos);
  if (tasks.length === 0) return [];
  return [{ type: 'task_update', data: { action: 'snapshot', task: tasks[0]!, tasks } }];
}

/** True when the thrown value is an AbortError (subscription teardown). */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}
