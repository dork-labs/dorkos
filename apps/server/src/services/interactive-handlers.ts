import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../config/constants.js';

export interface PendingInteraction {
  type: 'question' | 'approval';
  toolCallId: string;
  resolve: (result: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Minimal session interface needed by interactive handlers. */
export interface InteractiveSession {
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

/** Handle an AskUserQuestion tool call — pause, collect answers, inject into input. */
export function handleAskUserQuestion(
  session: InteractiveSession,
  toolUseId: string,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  session.eventQueue.push({
    type: 'question_prompt',
    data: {
      toolCallId: toolUseId,
      questions: input.questions as import('@dorkos/shared/types').QuestionItem[],
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'User did not respond within 10 minutes' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      resolve: (answers) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({
          behavior: 'allow',
          updatedInput: { ...input, answers },
        });
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}

/**
 * Create the `canUseTool` callback for an SDK query.
 *
 * Routes AskUserQuestion to the question handler, tool approvals based on
 * permissionMode, and auto-allows everything else.
 */
export function createCanUseTool(
  session: InteractiveSession & { permissionMode: string },
  logFn: (msg: string, data: Record<string, unknown>) => void
): (
  toolName: string,
  input: Record<string, unknown>,
  context: { signal: AbortSignal; toolUseID: string; decisionReason?: string; suggestions?: unknown[] }
) => Promise<PermissionResult> {
  return async (toolName, input, context) => {
    if (toolName === 'AskUserQuestion') {
      logFn('[canUseTool] routing to question handler', { toolName, toolUseID: context.toolUseID });
      return handleAskUserQuestion(session, context.toolUseID, input);
    }
    if (session.permissionMode === 'default') {
      logFn('[canUseTool] requesting approval', { toolName, permissionMode: 'default', toolUseID: context.toolUseID });
      return handleToolApproval(session, context.toolUseID, toolName, input);
    }
    logFn('[canUseTool] auto-allow', { toolName, permissionMode: session.permissionMode, toolUseID: context.toolUseID });
    return { behavior: 'allow', updatedInput: input };
  };
}

/** Handle tool approval — pause when permissionMode is 'default'. */
export function handleToolApproval(
  session: InteractiveSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  session.eventQueue.push({
    type: 'approval_required',
    data: {
      toolCallId: toolUseId,
      toolName,
      input: JSON.stringify(input),
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      session.pendingInteractions.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'Tool approval timed out after 10 minutes' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      resolve: (approved) => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve(
          approved
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'User denied tool execution' }
        );
      },
      reject: () => {
        clearTimeout(timeout);
        session.pendingInteractions.delete(toolUseId);
        resolve({ behavior: 'deny', message: 'Interaction cancelled' });
      },
      timeout,
    });
  });
}
