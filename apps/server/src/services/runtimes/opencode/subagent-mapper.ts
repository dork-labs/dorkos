/**
 * OpenCode subagent mapping — the `task` tool part and its child session,
 * folded into the runtime-neutral background-task vocabulary.
 *
 * OpenCode delegates through its built-in `task` tool, which creates a CHILD
 * session (`Session.parentID`) and runs the chosen agent in it. There is no
 * dedicated subagent event on the wire — the whole signal is carried by the
 * ordinary `task` tool part in the PARENT session, whose `state.metadata` gains
 * `{parentSessionId, sessionId, model}` once the child exists (NOTES.md §7).
 * This module folds that part into `background_task_started`/`_progress`/
 * `_done` (which the session normalizer turns into `subagent_update`) and
 * counts the tool calls the child session reports, so the parent's card can
 * say how much work the subagent has done.
 *
 * `event-mapper.ts` owns the routing — which session an event belongs to, and
 * therefore which of the child's events reach {@link mapSubagentChildToolPart}
 * at all. Child text, todos and terminals never get here: only the parent
 * session may write the transcript or end the turn.
 *
 * @module services/runtimes/opencode/subagent-mapper
 */
import type { ToolPart } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';

/**
 * OpenCode's built-in delegation tool (`GET /experimental/tool/ids` at
 * v1.18.15: `… "task" …`). Every subagent run in OpenCode goes through it.
 */
export const TASK_TOOL_NAME = 'task';

/**
 * The tool-part metadata key holding the subagent's child session id. The task
 * tool publishes `{parentSessionId, sessionId, model}` onto its own part right
 * after creating the child session and before prompting it.
 */
const SUBAGENT_SESSION_METADATA_KEY = 'sessionId';

/** Its companion key, naming the session that DELEGATED — never a child. */
const SUBAGENT_PARENT_SESSION_METADATA_KEY = 'parentSessionId';

/**
 * The `task` tool input field naming which agent to run (`GET /experimental/
 * tool`: required alongside `description` and `prompt`). It is what a person
 * would call the subagent, so it is what its prompts are labelled with.
 */
const SUBAGENT_TYPE_INPUT_KEY = 'subagent_type';

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
 *   `Error("Task cancelled")` after the runner wraps it.
 * - `Task cancelled` — the SAME throw, unwrapped. Live-captured 2026-08-11
 *   (`fixtures/live-child-permission-stop.jsonl`) when the stop landed while the
 *   subagent was holding a permission: the task tool settles its own part, so
 *   the runner never wraps the message and never stamps `interrupted`. Reading
 *   it as a failure told the operator their own stop had gone wrong.
 * - `Cancelled` — `SessionPrompt.handleSubtask`'s `onInterrupt`, reachable only
 *   when a client sends a `SubtaskPartInput` (DorkOS never does).
 *
 * Anchoring on the last one alone (as this first shipped) painted an ordinary
 * stop as a failure, because it is the one path DorkOS cannot reach.
 */
const SUBAGENT_STOPPED_PATTERN =
  /^(?:(?:task )?cancelled|tool execution (?:aborted|interrupted|failed: task cancelled))$/i;

/** One live subagent run, keyed in the context by the `task` tool's callID. */
interface OpenCodeSubagentRun {
  /** `state.time.start` of the task tool part — the baseline for progress durations. */
  readonly startedAt: number;
  /**
   * What to call this subagent on the parent's surfaces: the agent type the
   * `task` call selected, or its description when the model named no type.
   * Undefined when the input bag carried neither.
   */
  readonly name: string | undefined;
  /** Distinct child tool callIDs observed so far; the size is `toolUses`. */
  readonly toolCallIds: Set<string>;
  /** The subagent's child OpenCode session id, once its metadata reveals it. */
  childSessionId?: string;
  /** True once the terminal `background_task_done` has been emitted. */
  ended: boolean;
}

/**
 * The slice of a turn's mapping context this module owns. The event mapper's
 * `OpenCodeEventContext` extends it, so a whole context passes straight
 * through wherever this shape is asked for.
 */
export interface OpenCodeSubagentState {
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
 *
 * @param part - The parent session's `task` tool part
 * @param state - The turn's subagent bookkeeping (mutated)
 */
export function mapSubagentTaskPart(part: ToolPart, state: OpenCodeSubagentState): StreamEvent[] {
  const toolState = part.state;
  // `pending` has no `time` yet — the input is still streaming (see mapToolCall).
  if (toolState.status === 'pending') return [];

  const taskId = part.callID;
  const childSessionId = readSubagentChildSessionId(part);
  const events: StreamEvent[] = [];

  let run = state.subagentRuns.get(taskId);
  if (run === undefined) {
    const description = readStringField(toolState.input, 'description');
    run = {
      startedAt: toolState.time.start,
      name: readStringField(toolState.input, SUBAGENT_TYPE_INPUT_KEY) ?? description,
      toolCallIds: new Set(),
      ended: false,
    };
    state.subagentRuns.set(taskId, run);
    events.push({
      type: 'background_task_started',
      data: {
        taskId,
        taskType: 'agent',
        startedAt: toolState.time.start,
        toolUseId: taskId,
        ...(description !== undefined ? { description } : {}),
        ...(childSessionId !== undefined ? { subagentSessionId: childSessionId } : {}),
      },
    });
  }

  if (childSessionId !== undefined && run.childSessionId === undefined) {
    run.childSessionId = childSessionId;
    state.subagentTaskIdBySession.set(childSessionId, taskId);
  }

  if (toolState.status === 'running' || run.ended) return events;

  run.ended = true;
  events.push({
    type: 'background_task_done',
    data: {
      taskId,
      status:
        toolState.status === 'completed'
          ? 'completed'
          : subagentFailureStatus(toolState.error, toolState.metadata, part.metadata),
      durationMs: toolState.time.end - run.startedAt,
      ...(run.toolCallIds.size > 0 ? { toolUses: run.toolCallIds.size } : {}),
    },
  });
  return events;
}

/**
 * Close every subagent this turn opened and never terminated, reporting each as
 * `stopped`. The turn mapper calls this ONLY on the authoritative turn terminal
 * — the parent's `session.idle` — and yields the result before it, so the card
 * settles inside the turn window rather than trailing its `done` (DOR-1146).
 *
 * ## Why a run can still be open when the parent goes idle
 *
 * The stop ordering is on the wire, captured live twice (`__tests__/fixtures/
 * live-cancel.jsonl`): child `session.error{MessageAbortedError}` → child
 * `session.idle` → parent `session.error` → **parent `session.idle`** → the
 * parent's `task` part finally arriving as `status:"error"`,
 * `metadata.interrupted:true`. The only event that carries the subagent's
 * outcome lands AFTER the terminal the turn mapper returns on, so it was never
 * read and the card was left running until something else retired it.
 *
 * ## Why `stopped` is a claim and not a guess
 *
 * `session.idle` is published by upstream's `SessionStatus.set(...,{idle})`
 * only once the runner has drained — including `failUnsettledTools`, which
 * settles every tool part the turn still owns. A `task` call blocks its parent's
 * tool loop, so the parent cannot reach idle while a subagent is genuinely
 * working; a run still open here was torn down, and its terminal snapshot merely
 * raced or was lost. The happy path proves the other half: there the `task` part
 * reaches `completed` long before the parent's idle, so this closes nothing.
 *
 * ## Why only on `session.idle`
 *
 * The other terminals — a thrown stream error, an AbortError, a stream that
 * simply ends — mean DorkOS STOPPED WATCHING, not that the turn finished. A
 * child may well still be running behind them, so nothing is emitted and the
 * normalizer's end-of-stream sweep retires it as `untracked` instead: "we lost
 * sight of this", the strongest claim that evidence supports (DOR-1108).
 *
 * `durationMs` is deliberately omitted — the wire never told us when the child
 * stopped, and the field is dropped in normalization anyway.
 *
 * @param state - The turn's subagent bookkeeping (mutated)
 */
export function* closeOpenSubagents(state: OpenCodeSubagentState): Generator<StreamEvent> {
  for (const [taskId, run] of state.subagentRuns) {
    if (run.ended) continue;
    run.ended = true;
    yield {
      type: 'background_task_done',
      data: {
        taskId,
        status: 'stopped',
        ...(run.toolCallIds.size > 0 ? { toolUses: run.toolCallIds.size } : {}),
      },
    };
  }
}

/**
 * Whether a subagent run is still live — the guard every child-session event
 * passes before it is attributed to the parent's card. A run that has already
 * reported its terminal is finished: a straggling child event belongs to
 * nothing, and a straggling child PROMPT would be an unanswerable card.
 *
 * @param state - The turn's subagent bookkeeping
 * @param taskId - The parent's `task` callID the child session belongs to
 */
export function isSubagentRunning(state: OpenCodeSubagentState, taskId: string): boolean {
  const run = state.subagentRuns.get(taskId);
  return run !== undefined && !run.ended;
}

/**
 * The card header for a permission a subagent raised, so a person answering it
 * knows who is asking rather than seeing an unexplained command appear
 * (DOR-1126). Named for the agent the `task` call selected; a run whose input
 * named neither an agent type nor a description still says a subagent asked,
 * which is the part that changes what the answer means.
 *
 * @param state - The turn's subagent bookkeeping
 * @param taskId - The parent's `task` callID the child session belongs to
 */
export function subagentPromptTitle(state: OpenCodeSubagentState, taskId: string): string {
  const name = state.subagentRuns.get(taskId)?.name;
  return name === undefined
    ? 'A subagent needs permission'
    : `The ${name} subagent needs permission`;
}

/**
 * Report a tool part from a subagent's child session on its parent task card —
 * one `background_task_progress` beat per distinct call, mirroring
 * claude-code's `task_progress` cadence. Everything else the child emits (text,
 * reasoning, todos, permissions, its own terminal) is dropped upstream of here:
 * the child is not the turn, and its `session.idle` must never be mistaken for
 * the parent's.
 *
 * @param part - A tool part observed in the child session
 * @param taskId - The parent's `task` callID the child session belongs to
 * @param state - The turn's subagent bookkeeping (mutated)
 */
export function mapSubagentChildToolPart(
  part: ToolPart,
  taskId: string,
  state: OpenCodeSubagentState
): StreamEvent[] {
  if (part.state.status === 'pending') return [];

  const run = state.subagentRuns.get(taskId);
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
