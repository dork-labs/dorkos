import {
  mapHookOutcome,
  resolutionForCancelledReason,
  toToolPayload,
  toApprovalEvent,
  toQuestionEvent,
  toCapabilityApprovalRequiredEvent,
  toCapabilityApprovalResolvedEvent,
  toMcpSigninRequiredEvent,
  toMcpSigninResolvedEvent,
  toElicitationEvent,
  toStatusChange,
  toTodoUpdate,
  mapDoneStatus,
} from './session-event-payload-helpers.js';
import { isRefusedAskKind } from '@dorkos/shared/run-refusals';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { RawSessionEvent } from '../session-state-projector.js';

/** A `StreamEvent`'s `data` payload, read defensively as a loose record. */
type StreamData = Record<string, unknown>;

/**
 * The `seq`-less shape of a single {@link SessionEvent} member, selected by its
 * `type` discriminator. `Omit<SessionEvent, 'seq'>` collapses the union to its
 * common keys; distributing `Extract` first preserves each member's full field
 * set so object literals type-check precisely.
 */
export type RawOf<T extends SessionEvent['type']> = Omit<Extract<SessionEvent, { type: T }>, 'seq'>;

/**
 * Map a single DorkOS {@link StreamEvent} to a {@link RawSessionEvent}, or
 * `null` when the event has no durable session-stream projection.
 *
 * Pure and synchronous: it never reads I/O and never stamps `seq` (the
 * projector owns that). Task #6 calls this per `StreamEvent` during a triggered
 * turn; external-session deltas (task #6/#9) can reuse it once JSONL deltas are
 * translated back into `StreamEvent`s.
 *
 * @param event - A DorkOS `StreamEvent` as produced by `sendMessage`.
 * @returns The normalized event, or `null` to drop it.
 */
export function toRawSessionEvent(event: StreamEvent): RawSessionEvent | null {
  const data = (event.data ?? {}) as StreamData;
  switch (event.type) {
    case 'text_delta': {
      const delta: RawOf<'text_delta'> = { type: 'text_delta', text: String(data.text ?? '') };
      return delta;
    }
    case 'thinking_delta': {
      const delta: RawOf<'thinking_delta'> = {
        type: 'thinking_delta',
        text: String(data.text ?? ''),
      };
      return delta;
    }

    case 'tool_progress': {
      const progress: RawOf<'tool_progress'> = {
        type: 'tool_progress',
        toolCallId: String(data.toolCallId ?? ''),
        content: String(data.content ?? ''),
      };
      return progress;
    }

    // tool_call_start/delta map to an in-progress tool_call; tool_call_end and
    // tool_result both map to the tool_result member. All reuse the
    // ToolCallEvent payload shape, so we pass the fields straight through.
    //
    // ## `tool_result` is the member, `status` is the claim
    //
    // The frame NAME does not mean the call ended, and a consumer that reads it
    // that way will be wrong on the default runtime. What the runtimes agree on
    // is narrower: a `tool_result` frame is the last word available about a
    // tool call SO FAR, and its `status` says whether that word is terminal.
    //
    // They disagree on when they first have something to say, because they are
    // told different things:
    //
    // - **codex** and **opencode** learn of a call and its outcome together, so
    //   their `tool_call_end` carries a real terminal status and the frame is
    //   terminal in practice.
    // - **claude-code** streams the call as the model types it, and the SDK
    //   closes the block (`content_block_stop`) when the ARGUMENTS are done —
    //   before the permission prompt, before the tool runs. That
    //   `tool_call_end` reports `running`, and the terminal frame arrives later
    //   from the result message (DOR-2011).
    //
    // So the split is real and it is deliberate: forcing claude-code to
    // withhold the frame until it had a result would drop the only signal that
    // a call's input finished, and forcing the other two to emit a spurious
    // in-flight frame would invent a state they never observe. Read `status`,
    // never the member name; `complete` and `error` are terminal, `running` and
    // `pending` are not. The client already does this
    // (`project-session-turn.ts` copies the status through), and so does the
    // history fold (`event-log-history.ts` takes `event.status` verbatim).
    case 'tool_call_start':
    case 'tool_call_delta': {
      const call: RawOf<'tool_call'> = { type: 'tool_call', ...toToolPayload(data) };
      return call;
    }
    case 'tool_call_end':
    case 'tool_result': {
      const result: RawOf<'tool_result'> = { type: 'tool_result', ...toToolPayload(data) };
      return result;
    }

    case 'approval_required':
      return toApprovalEvent(data);
    case 'question_prompt':
      return toQuestionEvent(data);
    case 'elicitation_prompt':
      return toElicitationEvent(data);

    // An in-session destructive capability call held awaiting the operator's
    // decision, and its resolution (DOR-939). The projector tracks the required
    // event as a pending HOLD (pausing the stall watchdog); the resolved event
    // drops it and retires the inline card.
    case 'capability_approval_required':
      return toCapabilityApprovalRequiredEvent(data);
    case 'capability_approval_resolved':
      return toCapabilityApprovalResolvedEvent(data);

    case 'mcp_signin_required':
      return toMcpSigninRequiredEvent(data);
    case 'mcp_signin_resolved':
      return toMcpSigninResolvedEvent(data);

    case 'session_status':
      return toStatusChange(data);

    case 'task_update':
      return toTodoUpdate(data);

    case 'background_task_started': {
      const update: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId: String(data.taskId ?? ''),
        status: 'running',
        ...(data.description !== undefined ? { description: String(data.description) } : {}),
        // Carried onto the durable event so a client that reconnects mid-turn
        // still knows this one is housekeeping. Absent stays absent.
        ...(data.ambient !== undefined ? { ambient: Boolean(data.ambient) } : {}),
      };
      return update;
    }
    case 'background_task_progress': {
      const update: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId: String(data.taskId ?? ''),
        status: 'running',
        ...(data.toolUses !== undefined ? { toolUses: Number(data.toolUses) } : {}),
        ...(data.lastToolName !== undefined ? { lastToolName: String(data.lastToolName) } : {}),
        ...(data.summary !== undefined ? { summary: String(data.summary) } : {}),
      };
      return update;
    }
    case 'background_task_done': {
      const update: RawOf<'subagent_update'> = {
        type: 'subagent_update',
        taskId: String(data.taskId ?? ''),
        status: mapDoneStatus(data.status),
        ...(data.summary !== undefined ? { summary: String(data.summary) } : {}),
        ...(data.toolUses !== undefined ? { toolUses: Number(data.toolUses) } : {}),
        ...(data.ambient !== undefined ? { ambient: Boolean(data.ambient) } : {}),
      };
      return update;
    }

    // The three hook phases collapse into one `hook_update` member keyed by
    // hookId (the subagent_update precedent): start carries identity, progress
    // carries cumulative output, response carries the outcome.
    case 'hook_started': {
      const update: RawOf<'hook_update'> = {
        type: 'hook_update',
        hookId: String(data.hookId ?? ''),
        status: 'running',
        hookName: String(data.hookName ?? ''),
        hookEvent: String(data.hookEvent ?? ''),
        toolCallId: data.toolCallId === null ? null : String(data.toolCallId ?? ''),
      };
      return update;
    }
    case 'hook_progress': {
      const update: RawOf<'hook_update'> = {
        type: 'hook_update',
        hookId: String(data.hookId ?? ''),
        status: 'running',
        stdout: String(data.stdout ?? ''),
        stderr: String(data.stderr ?? ''),
      };
      return update;
    }
    case 'hook_response': {
      const update: RawOf<'hook_update'> = {
        type: 'hook_update',
        hookId: String(data.hookId ?? ''),
        status: mapHookOutcome(data.outcome),
        hookName: String(data.hookName ?? ''),
        stdout: String(data.stdout ?? ''),
        stderr: String(data.stderr ?? ''),
        ...(data.exitCode !== undefined ? { exitCode: Number(data.exitCode) } : {}),
      };
      return update;
    }

    // An image the turn produced. The adapter has ALREADY stored the bytes by
    // the time this arrives, so the event is a reference and this hop is a
    // straight field copy — see `sessionImageShape` for why the bytes never
    // ride the stream. Defensive reads like every other case here: a malformed
    // event becomes a reference to nothing, which the renderer degrades on,
    // rather than throwing inside a live turn.
    case 'image_attachment': {
      const image: RawOf<'image_attachment'> = {
        type: 'image_attachment',
        attachmentId: String(data.attachmentId ?? ''),
        url: String(data.url ?? ''),
        mediaType: String(data.mediaType ?? ''),
        size: Number(data.size ?? 0),
        ...(data.alt !== undefined ? { alt: String(data.alt) } : {}),
      };
      return image;
    }

    case 'memory_recall': {
      const recall: RawOf<'memory_recall'> = {
        type: 'memory_recall',
        mode: (data.mode as RawOf<'memory_recall'>['mode']) ?? 'select',
        // MemoryEntry[] passes through structurally; the projector treats it opaquely.
        memories: (data.memories as RawOf<'memory_recall'>['memories']) ?? [],
      };
      return recall;
    }

    // A context-window compaction boundary. The mapper camelCases the SDK
    // `compact_metadata`; forward only the fields present so a malformed boundary
    // still validates as `{}`. `!== undefined` (not truthiness) so `0` survives.
    case 'compact_boundary': {
      const boundary: RawOf<'compact_boundary'> = {
        type: 'compact_boundary',
        ...(data.trigger !== undefined
          ? { trigger: data.trigger as RawOf<'compact_boundary'>['trigger'] }
          : {}),
        ...(data.preTokens !== undefined ? { preTokens: Number(data.preTokens) } : {}),
        ...(data.postTokens !== undefined ? { postTokens: Number(data.postTokens) } : {}),
        ...(data.durationMs !== undefined ? { durationMs: Number(data.durationMs) } : {}),
        // Stamped by the dispatcher on a compaction the agent asked for
        // (DOR-2732), never by a runtime, so only the one value is carried.
        ...(data.requestedBy === 'agent' ? { requestedBy: 'agent' as const } : {}),
        ...(typeof data.contextPercent === 'number'
          ? { contextPercent: Math.round(data.contextPercent) }
          : {}),
        ...(typeof data.requestedAt === 'string' ? { requestedAt: data.requestedAt } : {}),
      };
      return boundary;
    }

    // A tool call refused before anyone could be asked (DOR-795). Forwarded
    // rather than dropped because the runtime's own transcript cannot answer for
    // it: for a BACKGROUNDED subagent (`reasonType: 'asyncAgent'`) the denied
    // call lives in a child transcript no reader opens, so this event is the only
    // place the loss is ever stated. Optionals ride only when present so a lean
    // denial stays lean — `agentId` in particular, whose ABSENCE means "the main
    // thread", a claim an empty string would quietly fake.
    case 'permission_denied': {
      const denied: RawOf<'permission_denied'> = {
        type: 'permission_denied',
        toolCallId: String(data.toolCallId ?? ''),
        toolName: String(data.toolName ?? ''),
        message: String(data.message ?? ''),
        ...(data.reasonType !== undefined ? { reasonType: String(data.reasonType) } : {}),
        ...(data.reason !== undefined ? { reason: String(data.reason) } : {}),
        // Carried through, not stringified blind: `askKind` says WHICH of the
        // three unanswerable asks this was, and the run-outcome rule reads it
        // to tell a run that lost a TOOL from one that merely asked a question
        // (DOR-2101). Dropping it here would have made the schema's claim that
        // the record reaches the transcript false for every replayed event,
        // and a value outside the enum is no answer at all rather than a new
        // kind — so it is validated with the enum's own guard.
        ...(isRefusedAskKind(data.askKind) ? { askKind: data.askKind } : {}),
        ...(data.agentId !== undefined ? { agentId: String(data.agentId) } : {}),
      };
      return denied;
    }

    // A turn that ran on another model than its session names (DOR-2636).
    // Forwarded whole: the runtime's transcript never says a model was swapped,
    // so this event is the only lasting record that it was.
    case 'model_substituted': {
      const substituted: RawOf<'model_substituted'> = {
        type: 'model_substituted',
        from: String(data.from ?? ''),
        fromName: String(data.fromName ?? data.from ?? ''),
        to: String(data.to ?? ''),
        toName: String(data.toName ?? data.to ?? ''),
        reason: 'credits-not-covered',
      };
      return substituted;
    }

    // A transient operational status (hook progress, a raw SDK `status` token).
    // Drives the client status strip; forward only the fields present. Operation
    // lifecycle (compaction) rides `operation_progress`, not this member.
    case 'system_status': {
      const status: RawOf<'system_status'> = {
        type: 'system_status',
        message: String(data.message ?? ''),
        ...(data.status !== undefined ? { status: String(data.status) } : {}),
      };
      return status;
    }

    // Runtime-agnostic operation progress (DOR-110 — compaction start/done/failed).
    // Drives the status strip's progress treatment and the failed-compaction error
    // surface; forward only the fields present so a lean phase stays lean.
    case 'operation_progress': {
      const progress: RawOf<'operation_progress'> = {
        type: 'operation_progress',
        operation: data.operation as RawOf<'operation_progress'>['operation'],
        state: data.state as RawOf<'operation_progress'>['state'],
        determinate: Boolean(data.determinate),
        ...(data.percent !== undefined ? { percent: Number(data.percent) } : {}),
        ...(data.message !== undefined ? { message: String(data.message) } : {}),
        ...(data.error !== undefined ? { error: String(data.error) } : {}),
        // Stamped by the dispatcher on an agent-requested compaction (DOR-2732).
        ...(data.requestedBy === 'agent' ? { requestedBy: 'agent' as const } : {}),
      };
      return progress;
    }

    // A pending interaction resolved off the ordinary in-DorkOS answer path
    // (SDK abort — e.g. a mid-turn steer superseding a pending question —
    // timeout, or an OpenCode `permission.replied` echo reporting an answer
    // given elsewhere, e.g. the OpenCode TUI). Projects to the same
    // `interaction_resolved` member every path uses, so every consumer drops
    // the card identically and, where the reason names a real answer, records
    // the same receipt an in-DorkOS answer would (DOR-1148).
    //
    // The four reasons stay distinguishable downstream: `timeout` was answered
    // (auto-denied) on the person's behalf and is worth recording; `approved`/
    // `denied` is a real answer somebody gave outside DorkOS; `aborted` (the
    // default) withdrew the ask before anyone could answer it and is not.
    case 'interaction_cancelled': {
      const resolved: RawOf<'interaction_resolved'> = {
        type: 'interaction_resolved',
        id: String(data.interactionId ?? ''),
        resolution: resolutionForCancelledReason(data.reason),
        at: Date.now(),
      };
      return resolved;
    }

    // An agent-issued imperative UI command (the `control_ui` MCP tool pushes it
    // onto the eventQueue, which `message-sender` drains into this turn's
    // StreamEvent stream). Carried whole into the contract as a transient,
    // side-effecting member: the projector folds no state for it (the `default`
    // arm of `project()`), so it forwards live and clears with the turn. The
    // command rode the StreamEvent under `data.command`.
    case 'ui_command': {
      const command = data.command;
      if (command === undefined) return null;
      const uiCommand: RawOf<'ui_command'> = {
        type: 'ui_command',
        command: command as RawOf<'ui_command'>['command'],
      };
      // **The stamp has to survive this function, and it is the one edit that
      // makes the two-caller canvas design safe** (spec `room-canvas` §5.2).
      //
      // This arm REBUILDS the event field by field and drops everything else on
      // `data` — which is exactly what it is for, and exactly what would erase
      // `applied` between the event queue and the projector. A room turn's
      // collector applies every `ui_command` carrying no stamp, so an erased
      // stamp means every claude-code canvas operation applies TWICE: two rows
      // for content with no dedupe key, two counts against the per-turn ceiling,
      // and two mentions in the turn's one line. Invisible until it is missing,
      // which is why a round-trip test pins it rather than this comment.
      const applied = data.applied;
      if (applied !== undefined) {
        uiCommand.applied = applied as RawOf<'ui_command'>['applied'];
      }
      return uiCommand;
    }

    // A server→client screenshot request (the `browser_screenshot` MCP tool,
    // DOR-213 Phase 3). Same transient, side-effecting class as `ui_command`:
    // forwards live to the attached client (which relays it into the preview
    // frame) and clears with the turn — never re-projected from a snapshot.
    case 'devtools_capture_request': {
      const requestId = data.requestId;
      if (requestId === undefined) return null;
      const captureRequest: RawOf<'devtools_capture_request'> = {
        type: 'devtools_capture_request',
        ...(typeof data.bridgeGeneration === 'string'
          ? { bridgeGeneration: data.bridgeGeneration }
          : {}),
        requestId: String(requestId),
        ...(data.targetClientId !== undefined
          ? { targetClientId: String(data.targetClientId) }
          : {}),
        ...(data.documentId !== undefined ? { documentId: String(data.documentId) } : {}),
      };
      return captureRequest;
    }

    // A server→client request to act in the preview (spec `canvas-agent-seat`
    // §2): the driving sibling of the capture request above, and transient for
    // the same reason — replaying a click from a snapshot would be a second
    // click nobody asked for. The command is forwarded whole; it was composed
    // server-side from a tool call and validated on the way out.
    case 'devtools_action_request': {
      const requestId = data.requestId;
      const targetClientId = data.targetClientId;
      const documentId = data.documentId;
      const command = data.command;
      if (
        requestId === undefined ||
        targetClientId === undefined ||
        documentId === undefined ||
        command === undefined
      ) {
        return null;
      }
      const actionRequest: RawOf<'devtools_action_request'> = {
        type: 'devtools_action_request',
        ...(typeof data.bridgeGeneration === 'string'
          ? { bridgeGeneration: data.bridgeGeneration }
          : {}),
        requestId: String(requestId),
        targetClientId: String(targetClientId),
        documentId: String(documentId),
        command: command as RawOf<'devtools_action_request'>['command'],
        // Forwarded only when set, and it is set only while a recording is
        // running on this page (spec `canvas-agent-seat` §3.2). Dropping it here
        // would leave the recording running and every frame missing, with no
        // failure anywhere to say so.
        ...(data.capture === true ? { capture: true } : {}),
      };
      return actionRequest;
    }

    // Start or stop recording the page a driving window holds (spec
    // `canvas-agent-seat` §3). Transient for the same reason its two siblings
    // above are: replaying a `stop` from a snapshot would ask a window to encode
    // and upload a recording that finished long ago.
    case 'devtools_recording_request': {
      const { requestId, targetClientId, documentId, action, recordingId, bounds } = data;
      if (
        requestId === undefined ||
        targetClientId === undefined ||
        documentId === undefined ||
        recordingId === undefined ||
        typeof action !== 'string' ||
        !['start', 'stop', 'confirm-start', 'cancel-start'].includes(action) ||
        bounds === undefined
      ) {
        return null;
      }
      const recordingRequest: RawOf<'devtools_recording_request'> = {
        type: 'devtools_recording_request',
        ...(typeof data.bridgeGeneration === 'string'
          ? { bridgeGeneration: data.bridgeGeneration }
          : {}),
        requestId: String(requestId),
        targetClientId: String(targetClientId),
        documentId: String(documentId),
        action: action as RawOf<'devtools_recording_request'>['action'],
        ...(typeof data.reservationTimeoutMs === 'number'
          ? { reservationTimeoutMs: data.reservationTimeoutMs }
          : {}),
        recordingId: String(recordingId),
        bounds: bounds as RawOf<'devtools_recording_request'>['bounds'],
      };
      return recordingRequest;
    }

    // A typed turn error, adapter-yielded or server-injected (guardTurnErrors
    // on a throw, the stall watchdog). Optionals are forwarded only when
    // present so a lean adapter error stays lean.
    case 'error': {
      const error: RawOf<'error'> = {
        type: 'error',
        message: String(data.message ?? 'Unknown error'),
        ...(data.code !== undefined ? { code: String(data.code) } : {}),
        ...(data.category !== undefined
          ? { category: data.category as RawOf<'error'>['category'] }
          : {}),
        ...(data.details !== undefined ? { details: String(data.details) } : {}),
      };
      return error;
    }

    // No session-stream projection: raw context/usage notices, sync/presence/
    // relay traffic, prompt suggestions, and `done` (turn boundary handled by
    // feedProjector, not by a per-event mapping).
    default:
      return null;
  }
}
