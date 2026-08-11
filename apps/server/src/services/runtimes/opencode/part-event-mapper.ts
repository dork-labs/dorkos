/**
 * OpenCode message-part mapping — the text, reasoning and tool parts carried by
 * `message.part.updated` and `message.part.delta`, translated into DorkOS
 * StreamEvents. `event-mapper.ts` routes wire events here and holds the
 * adapter-wide SOURCE OF TRUTH notes.
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
 * @module services/runtimes/opencode/part-event-mapper
 */
import type { Event, ToolPart } from '@opencode-ai/sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  TASK_TOOL_NAME,
  mapSubagentTaskPart,
  type OpenCodeSubagentState,
} from './subagent-mapper.js';

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

/**
 * The slice of a turn's mapping context this module owns — delta baselines and
 * the single-shot tool guards, plus the subagent bookkeeping a `task` part
 * writes through. The event mapper's `OpenCodeEventContext` extends it.
 */
export interface OpenCodePartState extends OpenCodeSubagentState {
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
}

/**
 * Route a cumulative part snapshot to its per-type mapper.
 *
 * @param part - The cumulative part snapshot from `message.part.updated`
 * @param state - Per-turn part bookkeeping (mutated)
 */
export function mapPartSnapshot(
  part: Extract<Event, { type: 'message.part.updated' }>['properties']['part'],
  state: OpenCodePartState
): StreamEvent[] {
  switch (part.type) {
    case 'text':
      // `ignored` parts are hidden bookkeeping text (upstream flag) — skip.
      if (part.ignored === true) return [];
      return emitTextSuffix(part.id, 'text', part.text, state);
    case 'reasoning':
      return emitTextSuffix(part.id, 'reasoning', part.text, state);
    case 'tool':
      return mapToolPart(part, state);
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
  state: OpenCodePartState
): StreamEvent[] {
  state.partKindById.set(partId, kind);
  const previous = state.lastTextByPartId.get(partId) ?? '';
  const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
  state.lastTextByPartId.set(partId, next);
  if (delta.length === 0) return [];
  return [{ type: kind === 'reasoning' ? 'thinking_delta' : 'text_delta', data: { text: delta } }];
}

/**
 * Map a true text increment (`message.part.delta`). The part kind is learned
 * from the preceding start snapshot (upstream always publishes `text-start`/
 * `reasoning-start` before deltas); orphan deltas for unknown parts are
 * dropped — the final cumulative snapshot covers their content.
 *
 * @param properties - The `message.part.delta` payload
 * @param state - Per-turn part bookkeeping (mutated)
 */
export function mapPartDelta(
  properties: EventMessagePartDelta['properties'],
  state: OpenCodePartState
): StreamEvent[] {
  if (properties.field !== 'text' || properties.delta.length === 0) return [];
  const kind = state.partKindById.get(properties.partID);
  if (kind === undefined) return [];
  const previous = state.lastTextByPartId.get(properties.partID) ?? '';
  state.lastTextByPartId.set(properties.partID, previous + properties.delta);
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
  state: OpenCodePartState
): void {
  if (state.startedToolCallIds.has(toolCallId)) return;
  state.startedToolCallIds.add(toolCallId);
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
function mapToolPart(part: ToolPart, state: OpenCodePartState): StreamEvent[] {
  const events = mapToolCall(part, state);
  if (part.tool !== TASK_TOOL_NAME) return events;
  // A `task` call is BOTH a tool call and a subagent run — claude-code renders
  // the same pair (a Task tool card plus a background-task card), so emit both.
  return [...events, ...mapSubagentTaskPart(part, state)];
}

/** The runtime-neutral tool-call half of a tool part (every tool, `task` included). */
function mapToolCall(part: ToolPart, ctx: OpenCodePartState): StreamEvent[] {
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
