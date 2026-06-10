/**
 * Tool, hook, and background task event handlers for the stream event processor.
 *
 * Each handler receives a `StreamHandlerHelpers` context, the event data, and
 * the assistant message ID. They mutate `currentPartsRef` and call
 * `updateAssistantMessage` to flush changes to React state.
 *
 * @module features/chat/model/stream-tool-handlers
 */
import type {
  ToolCallEvent,
  ApprovalEvent,
  QuestionPromptEvent,
  ToolProgressEvent,
  BackgroundTaskStartedEvent,
  BackgroundTaskProgressEvent,
  BackgroundTaskDoneEvent,
  SubagentTextDeltaEvent,
  HookStartedEvent,
  HookProgressEvent,
  HookResponseEvent,
  HookPart,
  ElicitationPromptEvent,
} from '@dorkos/shared/types';
import type { StreamHandlerHelpers } from './stream-event-types';

// ---------------------------------------------------------------------------
// Tool lifecycle
// ---------------------------------------------------------------------------

/** Handle a new tool call being started. */
export function handleToolCallStart(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const tc = data as ToolCallEvent;
  // Drain any hook events that arrived before this tool_call_start
  const buffered = helpers.orphanHooksRef.current.get(tc.toolCallId);
  helpers.orphanHooksRef.current.delete(tc.toolCallId);
  helpers.currentPartsRef.current.push({
    type: 'tool_call',
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: '',
    status: 'running',
    startedAt: Date.now(),
    ...(buffered && buffered.length > 0 ? { hooks: buffered } : {}),
  });
  helpers.updateAssistantMessage(assistantId);
}

/** Handle incremental tool call input. */
export function handleToolCallDelta(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const tc = data as ToolCallEvent;
  const existing = helpers.findToolCallPart(tc.toolCallId);
  if (existing && tc.input) {
    existing.input = (existing.input || '') + tc.input;
  } else if (!existing) {
    console.warn('[stream] tool_call_delta: unknown toolCallId', tc.toolCallId);
  }
  helpers.updateAssistantMessage(assistantId);
}

/** Handle tool progress output. */
export function handleToolProgress(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const tp = data as ToolProgressEvent;
  const existing = helpers.findToolCallPart(tp.toolCallId);
  if (existing) {
    existing.progressOutput = (existing.progressOutput || '') + tp.content;
  } else {
    console.warn('[stream] tool_progress: unknown toolCallId', tp.toolCallId);
  }
  helpers.updateAssistantMessage(assistantId);
}

/** Handle tool call completion. */
export function handleToolCallEnd(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const tc = data as ToolCallEvent;
  const existing = helpers.findToolCallPart(tc.toolCallId);
  if (existing) {
    // Don't overwrite 'pending' status on interactive tool calls — they remain
    // pending until the user responds (tool_result handles the final status).
    if (!existing.interactiveType) {
      existing.status = 'complete';
      // Set completedAt if not already set (MCP tools complete here, not via tool_result)
      if (!existing.completedAt) {
        existing.completedAt = Date.now();
      }
    }
  } else {
    console.warn('[stream] tool_call_end: unknown toolCallId', tc.toolCallId);
  }
  helpers.updateAssistantMessage(assistantId);
}

/** Handle a tool result arriving. */
export function handleToolResult(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const tc = data as ToolCallEvent;
  const existing = helpers.findToolCallPart(tc.toolCallId);
  if (existing) {
    existing.result = tc.result;
    existing.status = 'complete';
    existing.completedAt = Date.now();
    existing.progressOutput = undefined;
    // For AskUserQuestion, the 'complete' status alone collapses QuestionPrompt
    // into its answered row (AssistantMessageContent supplies `{}` once the part
    // is no longer 'pending'). We intentionally do NOT overwrite `answers` here —
    // doing so would erase the submitting client's chosen values from the row.
  } else {
    console.warn('[stream] tool_result: unknown toolCallId', tc.toolCallId);
  }
  // Defer re-render by one microtask so the immediately-following
  // text_delta('Done') event can batch into the same React flush,
  // preventing an orphaned 'Done' text part from appearing.
  queueMicrotask(() => helpers.updateAssistantMessage(assistantId));
}

/** Handle a tool requiring user approval. */
export function handleApprovalRequired(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const approval = data as ApprovalEvent;
  const approvalFields = {
    interactiveType: 'approval' as const,
    input: approval.input,
    status: 'pending' as const,
    timeoutMs: approval.timeoutMs,
    approvalStartedAt: approval.startedAt,
    approvalTitle: approval.title,
    approvalDisplayName: approval.displayName,
    approvalDescription: approval.description,
    approvalBlockedPath: approval.blockedPath,
    approvalDecisionReason: approval.decisionReason,
    approvalHasSuggestions: approval.hasSuggestions,
    // Server-authoritative remaining time, present only on recovery re-emit/pull.
    // Seeding it in place lets a re-fire resume the countdown at the true offset
    // (Date.now() + remainingMs) instead of resetting from approvalStartedAt + timeoutMs.
    ...(approval.remainingMs !== undefined ? { approvalRemainingMs: approval.remainingMs } : {}),
  };
  const existing = helpers.findToolCallPart(approval.toolCallId);
  if (existing) {
    Object.assign(existing, approvalFields);
  } else {
    // New tool call arriving directly as approval_required (no prior tool_call_start)
    helpers.currentPartsRef.current.push({
      type: 'tool_call',
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      ...approvalFields,
    });
  }
  helpers.updateAssistantMessage(assistantId);
}

/** Handle a question prompt from AskUserQuestion. */
export function handleQuestionPrompt(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const question = data as QuestionPromptEvent;
  // Server-authoritative countdown seeds, present only on recovery re-emit/pull.
  const countdownFields = {
    ...(question.startedAt !== undefined ? { approvalStartedAt: question.startedAt } : {}),
    ...(question.remainingMs !== undefined ? { approvalRemainingMs: question.remainingMs } : {}),
  };
  const existing = helpers.findToolCallPart(question.toolCallId);
  if (existing) {
    existing.interactiveType = 'question';
    existing.questions = question.questions;
    existing.status = 'pending';
    Object.assign(existing, countdownFields);
  } else {
    helpers.currentPartsRef.current.push({
      type: 'tool_call',
      toolCallId: question.toolCallId,
      toolName: 'AskUserQuestion',
      input: '',
      status: 'pending',
      interactiveType: 'question',
      questions: question.questions,
      ...countdownFields,
    });
  }
  helpers.updateAssistantMessage(assistantId);
}

/**
 * Handle an MCP elicitation prompt — upserts an ElicitationPart keyed by
 * `interactionId`.
 *
 * Upserting (rather than always pushing) is the linchpin that keeps the two
 * recovery paths safe: a foreground in-band emit and a later recovery re-emit/pull
 * carrying the same `interactionId` update the existing card in place instead of
 * producing a duplicate.
 */
export function handleElicitationPrompt(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const elicitation = data as ElicitationPromptEvent;
  const elicitationFields = {
    serverName: elicitation.serverName,
    message: elicitation.message,
    mode: elicitation.mode,
    url: elicitation.url,
    elicitationId: elicitation.elicitationId,
    requestedSchema: elicitation.requestedSchema,
    status: 'pending' as const,
    // Server-authoritative countdown seeds, present only on recovery re-emit/pull.
    ...(elicitation.startedAt !== undefined ? { startedAt: elicitation.startedAt } : {}),
    ...(elicitation.remainingMs !== undefined ? { remainingMs: elicitation.remainingMs } : {}),
  };
  const existing = helpers.findElicitationPart(elicitation.interactionId);
  if (existing) {
    Object.assign(existing, elicitationFields);
  } else {
    helpers.currentPartsRef.current.push({
      type: 'elicitation',
      interactionId: elicitation.interactionId,
      ...elicitationFields,
    });
  }
  helpers.updateAssistantMessage(assistantId);
}

// ---------------------------------------------------------------------------
// Background task lifecycle (SSE events: background_task_* -> BackgroundTaskPart)
// ---------------------------------------------------------------------------

/** Handle a background task being started — creates a BackgroundTaskPart. */
export function handleSubagentStarted(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const { taskId, toolUseId, description } = data as BackgroundTaskStartedEvent;
  helpers.currentPartsRef.current.push({
    type: 'background_task',
    taskId,
    taskType: 'agent',
    status: 'running',
    startedAt: Date.now(),
    description,
    // Retained so forwarded `subagent_text_delta` events can correlate their
    // `parentToolUseId` back to this task (see handleSubagentTextDelta).
    toolUseId,
  });
  helpers.updateAssistantMessage(assistantId);
}

/** Handle background task progress updates. */
export function handleSubagentProgress(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const progress = data as BackgroundTaskProgressEvent;
  const taskPart = helpers.findBackgroundTaskPart(progress.taskId);
  if (taskPart) {
    taskPart.toolUses = progress.toolUses;
    taskPart.lastToolName = progress.lastToolName;
    taskPart.durationMs = progress.durationMs;
    if (progress.summary) taskPart.summary = progress.summary;
  } else {
    console.warn('[stream] background_task_progress: unknown taskId', progress.taskId);
  }
  helpers.updateAssistantMessage(assistantId);
}

/** Handle a background task completing. */
export function handleSubagentDone(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const done = data as BackgroundTaskDoneEvent;
  const taskPartDone = helpers.findBackgroundTaskPart(done.taskId);
  if (taskPartDone) {
    taskPartDone.status = done.status === 'completed' ? 'complete' : 'error';
    taskPartDone.summary = done.summary;
    if (done.toolUses !== undefined) taskPartDone.toolUses = done.toolUses;
    if (done.durationMs !== undefined) taskPartDone.durationMs = done.durationMs;
  } else {
    console.warn('[stream] background_task_done: unknown taskId', done.taskId);
  }
  helpers.updateAssistantMessage(assistantId);
}

/**
 * Handle a forwarded subagent text delta (SDK `forwardSubagentText`).
 *
 * Appends the delta to the streamed text of the background task whose
 * `toolUseId` matches the event's `parentToolUseId`, so the operator can watch
 * the subagent work live inside its inline block. Deltas that arrive before the
 * task is known (or after it scrolled out of the live parts) are dropped.
 */
export function handleSubagentTextDelta(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const { parentToolUseId, text } = data as SubagentTextDeltaEvent;
  const taskPart = helpers.findBackgroundTaskPartByToolUseId(parentToolUseId);
  if (taskPart) {
    taskPart.subagentText = (taskPart.subagentText ?? '') + text;
    helpers.updateAssistantMessage(assistantId);
  } else {
    console.warn('[stream] subagent_text_delta: unknown parentToolUseId', parentToolUseId);
  }
}

// ---------------------------------------------------------------------------
// Hook lifecycle
// ---------------------------------------------------------------------------

/** Handle a hook being started. */
export function handleHookStarted(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const hook = data as HookStartedEvent;
  const newHook: HookPart = {
    hookId: hook.hookId,
    hookName: hook.hookName,
    hookEvent: hook.hookEvent,
    status: 'running',
    stdout: '',
    stderr: '',
  };
  if (hook.toolCallId) {
    const tc = helpers.findToolCallPart(hook.toolCallId);
    if (tc) {
      tc.hooks = [...(tc.hooks || []), newHook];
      helpers.updateAssistantMessage(assistantId);
    } else {
      // Tool call not yet started — buffer for later drain
      const existing = helpers.orphanHooksRef.current.get(hook.toolCallId) || [];
      helpers.orphanHooksRef.current.set(hook.toolCallId, [...existing, newHook]);
    }
  } else {
    // No tool context — session-level hook, ignore on client
    // (server routes these as system_status or error events)
  }
}

/** Handle hook progress output. */
export function handleHookProgress(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const progress = data as HookProgressEvent;
  const hook = helpers.findHookById(progress.hookId);
  if (hook) {
    hook.stdout = progress.stdout;
    hook.stderr = progress.stderr;
    helpers.updateAssistantMessage(assistantId);
  }
}

/** Handle a hook response completing. */
export function handleHookResponse(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const response = data as HookResponseEvent;
  const hook = helpers.findHookById(response.hookId);
  if (hook) {
    hook.status = response.outcome;
    hook.stdout = response.stdout;
    hook.stderr = response.stderr;
    hook.exitCode = response.exitCode;
    helpers.updateAssistantMessage(assistantId);
  }
}
