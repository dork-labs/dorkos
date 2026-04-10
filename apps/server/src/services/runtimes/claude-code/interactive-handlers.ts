import type {
  PermissionResult,
  PermissionUpdate,
  ElicitationRequest,
  ElicitationResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../config/constants.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Auto-approved tool sets (module-level to avoid per-call reconstruction)
// ---------------------------------------------------------------------------

/** Read-only Claude Code tools — cannot modify filesystem or execute shell commands. */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebSearch',
  'WebFetch',
]);

/**
 * DorkOS agent communication tools — pure messaging/discovery infrastructure.
 * Relay access control (relay/access-rules.json) handles authorization separately.
 */
const DORKOS_AGENT_TOOLS = new Set([
  'mcp__dorkos__relay_send',
  'mcp__dorkos__relay_inbox',
  'mcp__dorkos__relay_list_endpoints',
  'mcp__dorkos__relay_register_endpoint',
  'mcp__dorkos__mesh_list',
  'mcp__dorkos__mesh_inspect',
  'mcp__dorkos__mesh_discover',
  'mcp__dorkos__mesh_register',
  'mcp__dorkos__mesh_status',
  'mcp__dorkos__mesh_query_topology',
  'mcp__dorkos__get_agent',
  // UI control tools — pure client-side UI mutations, no system access
  'mcp__dorkos__control_ui',
  'mcp__dorkos__get_ui_state',
]);

// ---------------------------------------------------------------------------
// Pending interaction types (discriminated union for type safety)
// ---------------------------------------------------------------------------

interface PendingApproval {
  type: 'approval';
  toolCallId: string;
  resolve: (result: boolean | PermissionUpdate[]) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** SDK permission suggestions for "Always Allow" — stored so session-store can forward them. */
  suggestions?: PermissionUpdate[];
}

interface PendingQuestion {
  type: 'question';
  toolCallId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingElicitation {
  type: 'elicitation';
  toolCallId: string;
  resolve: (result: ElicitationResult) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type PendingInteraction = PendingApproval | PendingQuestion | PendingElicitation;

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
 * Handle an MCP elicitation request — pause, collect user input, return result.
 *
 * The `onElicitation` SDK callback receives the request from an MCP server
 * and must return an ElicitationResult. We push an SSE event to the client,
 * wait for the user's response, and resolve the Promise.
 */
export function handleElicitation(
  session: InteractiveSession,
  request: ElicitationRequest,
  signal: AbortSignal
): Promise<ElicitationResult> {
  const interactionId = request.elicitationId ?? randomUUID();

  session.eventQueue.push({
    type: 'elicitation_prompt',
    data: {
      interactionId,
      serverName: request.serverName,
      message: request.message,
      mode: request.mode,
      url: request.url,
      elicitationId: request.elicitationId,
      requestedSchema: request.requestedSchema,
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
    },
  });
  session.eventQueueNotify?.();

  return new Promise<ElicitationResult>((resolve) => {
    const decline = () => resolve({ action: 'decline' } as ElicitationResult);

    // Auto-decline if the SDK query is aborted
    const onAbort = () => {
      clearTimeout(timeout);
      session.pendingInteractions.delete(interactionId);
      decline();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(interactionId);
      decline();
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(interactionId, {
      type: 'elicitation',
      toolCallId: interactionId,
      resolve: (result) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(interactionId);
        resolve(result as ElicitationResult);
      },
      reject: () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(interactionId);
        decline();
      },
      timeout,
    });
  });
}

/** SDK context fields forwarded with tool approval requests. */
export interface ToolApprovalContext {
  signal: AbortSignal;
  toolUseID: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  suggestions?: PermissionUpdate[];
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
  context: ToolApprovalContext
) => Promise<PermissionResult> {
  return async (toolName, input, context) => {
    if (toolName === 'AskUserQuestion') {
      logFn('[canUseTool] routing to question handler', { toolName, toolUseID: context.toolUseID });
      return handleAskUserQuestion(session, context.toolUseID, input);
    }

    if (READ_ONLY_TOOLS.has(toolName) || DORKOS_AGENT_TOOLS.has(toolName)) {
      logFn('[canUseTool] auto-allow safe tool', { toolName, toolUseID: context.toolUseID });
      return { behavior: 'allow', updatedInput: input };
    }

    if (session.permissionMode === 'default') {
      logFn('[canUseTool] requesting approval', {
        toolName,
        permissionMode: 'default',
        toolUseID: context.toolUseID,
      });
      return handleToolApproval(session, context.toolUseID, toolName, input, context);
    }
    logFn('[canUseTool] auto-allow', {
      toolName,
      permissionMode: session.permissionMode,
      toolUseID: context.toolUseID,
    });
    return { behavior: 'allow', updatedInput: input };
  };
}

/**
 * Handle tool approval — pause when permissionMode is 'default'.
 *
 * Pushes an `approval_required` SSE event to the client, registers a pending
 * interaction, and waits for the user's response (approve, always-allow, or deny).
 * Auto-denies on timeout or if the SDK query is aborted.
 */
export function handleToolApproval(
  session: InteractiveSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  context: ToolApprovalContext
): Promise<PermissionResult> {
  const startedAt = Date.now();
  const timeoutMinutes = Math.ceil(SESSIONS.INTERACTION_TIMEOUT_MS / 60_000);

  session.eventQueue.push({
    type: 'approval_required',
    data: {
      toolCallId: toolUseId,
      toolName,
      input: JSON.stringify(input),
      timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
      startedAt,
      // SDK-provided rich context for the approval UI
      title: context.title,
      displayName: context.displayName,
      description: context.description,
      blockedPath: context.blockedPath,
      decisionReason: context.decisionReason,
      hasSuggestions: (context.suggestions?.length ?? 0) > 0,
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const deny = (message: string) => resolve({ behavior: 'deny', message });

    // Auto-deny if the SDK query is aborted (e.g. user interrupts the stream)
    const onAbort = () => {
      clearTimeout(timeout);
      session.pendingInteractions.delete(toolUseId);
      deny('Tool approval aborted');
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      context.signal.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(toolUseId);
      deny(`Tool approval timed out after ${timeoutMinutes} minutes`);
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      suggestions: context.suggestions,
      resolve: (result) => {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);

        if (Array.isArray(result)) {
          // "Always Allow" — forward SDK permission suggestions
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: result });
        } else if (result) {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          deny('User denied tool execution');
        }
      },
      reject: () => {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        deny('Interaction cancelled');
      },
      timeout,
    });
  });
}
