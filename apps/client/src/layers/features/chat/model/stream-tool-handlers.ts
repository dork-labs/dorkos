/**
 * Tool, hook, and subagent event handlers for the stream event processor.
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
  SubagentStartedEvent,
  SubagentProgressEvent,
  SubagentDoneEvent,
  HookStartedEvent,
  HookProgressEvent,
  HookResponseEvent,
  HookPart,
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
    // Mark AskUserQuestion as answered so QuestionPrompt shows collapsed on remount
    if (existing.interactiveType === 'question' && !existing.answers) {
      existing.answers = {};
    }
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
  const existing = helpers.findToolCallPart(approval.toolCallId);
  if (existing) {
    existing.interactiveType = 'approval';
    existing.input = approval.input;
    existing.status = 'pending';
    existing.timeoutMs = approval.timeoutMs;
  } else {
    // New tool call arriving directly as approval_required (no prior tool_call_start)
    helpers.currentPartsRef.current.push({
      type: 'tool_call',
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      input: approval.input,
      status: 'pending',
      interactiveType: 'approval',
      timeoutMs: approval.timeoutMs,
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
  const existing = helpers.findToolCallPart(question.toolCallId);
  if (existing) {
    existing.interactiveType = 'question';
    existing.questions = question.questions;
    existing.status = 'pending';
  } else {
    helpers.currentPartsRef.current.push({
      type: 'tool_call',
      toolCallId: question.toolCallId,
      toolName: 'AskUserQuestion',
      input: '',
      status: 'pending',
      interactiveType: 'question',
      questions: question.questions,
    });
  }
  helpers.updateAssistantMessage(assistantId);
}

// ---------------------------------------------------------------------------
// Subagent lifecycle
// ---------------------------------------------------------------------------

/** Handle a subagent being started. */
export function handleSubagentStarted(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const { taskId, description } = data as SubagentStartedEvent;
  helpers.currentPartsRef.current.push({
    type: 'subagent',
    taskId,
    description,
    status: 'running',
  });
  helpers.updateAssistantMessage(assistantId);
}

/** Handle subagent progress updates. */
export function handleSubagentProgress(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const progress = data as SubagentProgressEvent;
  const subagentPart = helpers.findSubagentPart(progress.taskId);
  if (subagentPart) {
    subagentPart.toolUses = progress.toolUses;
    subagentPart.lastToolName = progress.lastToolName;
    subagentPart.durationMs = progress.durationMs;
  } else {
    console.warn('[stream] subagent_progress: unknown taskId', progress.taskId);
  }
  helpers.updateAssistantMessage(assistantId);
}

/** Handle a subagent completing. */
export function handleSubagentDone(
  helpers: StreamHandlerHelpers,
  data: unknown,
  assistantId: string
) {
  const done = data as SubagentDoneEvent;
  const subagentPartDone = helpers.findSubagentPart(done.taskId);
  if (subagentPartDone) {
    subagentPartDone.status = done.status === 'completed' ? 'complete' : 'error';
    subagentPartDone.summary = done.summary;
    if (done.toolUses !== undefined) subagentPartDone.toolUses = done.toolUses;
    if (done.durationMs !== undefined) subagentPartDone.durationMs = done.durationMs;
  } else {
    console.warn('[stream] subagent_done: unknown taskId', done.taskId);
  }
  helpers.updateAssistantMessage(assistantId);
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
