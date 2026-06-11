import type {
  PermissionResult,
  PermissionUpdate,
  ElicitationRequest,
  ElicitationResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, QuestionItem } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../config/constants.js';
import { toSdkQuestionAnswers } from '../sessions/question-answers.js';
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
// Pending interaction snapshots (serializable re-emit payloads)
// ---------------------------------------------------------------------------

/**
 * Serializable snapshot of an `approval_required` event's `data`, minus the
 * routing `toolCallId`. A recovery path rebuilds the native client event from
 * this snapshot without holding the live SDK approval closure.
 */
export interface ApprovalSnapshot {
  toolName: string;
  /** JSON-stringified tool input, matching the in-band `approval_required` payload. */
  input: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
  hasSuggestions: boolean;
}

/**
 * Serializable snapshot of a `question_prompt` event's `data`, minus the
 * routing `toolCallId`. Re-emitted verbatim on recovery.
 */
export interface QuestionSnapshot {
  questions: QuestionItem[];
}

/**
 * Serializable snapshot of an `elicitation_prompt` event's `data`, minus the
 * routing `interactionId`. Re-emitted verbatim on recovery.
 */
export interface ElicitationSnapshot {
  serverName: string;
  message: string;
  mode?: ElicitationRequest['mode'];
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
}

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
  /** Server epoch ms when this interaction began (for recovery countdown math). */
  startedAt: number;
  /** Serializable re-emit payload for the recovery path. */
  snapshot: ApprovalSnapshot;
}

interface PendingQuestion {
  type: 'question';
  toolCallId: string;
  resolve: (answers: Record<string, string>) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** Server epoch ms when this interaction began (for recovery countdown math). */
  startedAt: number;
  /** Serializable re-emit payload for the recovery path. */
  snapshot: QuestionSnapshot;
}

interface PendingElicitation {
  type: 'elicitation';
  toolCallId: string;
  resolve: (result: ElicitationResult) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** Server epoch ms when this interaction began (for recovery countdown math). */
  startedAt: number;
  /** Serializable re-emit payload for the recovery path. */
  snapshot: ElicitationSnapshot;
}

export type PendingInteraction = PendingApproval | PendingQuestion | PendingElicitation;

/** Minimal session interface needed by interactive handlers. */
export interface InteractiveSession {
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

/**
 * Push an `interaction_cancelled` StreamEvent so the projection drops a pending
 * card that was resolved WITHOUT an operator action (SDK abort or timeout).
 * Flows through the same eventQueue → normalizer → projector path as the
 * prompt events themselves, so every `/events` consumer (and the next
 * snapshot) sees the card disappear instead of an answerable ghost lingering
 * until expiry (acceptance run 20260610-173202, F5).
 */
function notifyInteractionCancelled(
  session: InteractiveSession,
  interactionId: string,
  reason: 'aborted' | 'timeout'
): void {
  session.eventQueue.push({
    type: 'interaction_cancelled',
    data: { interactionId, reason },
  });
  session.eventQueueNotify?.();
}

/**
 * Handle an AskUserQuestion tool call — pause, collect answers, inject into input.
 *
 * `signal` is the SDK's per-tool-call abort signal: a mid-turn steered message
 * (or an interrupt) cancels the pending question SDK-side, so without the
 * abort listener the pending record lingered as an answerable ghost card for
 * the full 10-minute expiry (acceptance run 20260610-173202, F5 — this handler
 * was the one interactive path with NO abort wiring).
 */
export function handleAskUserQuestion(
  session: InteractiveSession,
  toolUseId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<PermissionResult> {
  const questions = input.questions as QuestionItem[];
  const startedAt = Date.now();
  session.eventQueue.push({
    type: 'question_prompt',
    data: {
      toolCallId: toolUseId,
      questions,
    },
  });
  session.eventQueueNotify?.();

  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      session.pendingInteractions.delete(toolUseId);
      notifyInteractionCancelled(session, toolUseId, 'aborted');
      resolve({ behavior: 'deny', message: 'Question cancelled' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(toolUseId);
      notifyInteractionCancelled(session, toolUseId, 'timeout');
      resolve({ behavior: 'deny', message: 'User did not respond within 10 minutes' });
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'question',
      toolCallId: toolUseId,
      startedAt,
      snapshot: { questions },
      resolve: (answers) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        session.pendingInteractions.delete(toolUseId);
        // Translate DorkOS's canonical (index-keyed) answers into the SDK's
        // question-text-keyed format. Without this the native AskUserQuestion
        // executor finds no matching answers and tells the model the user did
        // not respond. See sessions/question-answers.ts.
        resolve({
          behavior: 'allow',
          updatedInput: { ...input, answers: toSdkQuestionAnswers(answers, questions) },
        });
      },
      reject: () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
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
  const startedAt = Date.now();

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
      notifyInteractionCancelled(session, interactionId, 'aborted');
      decline();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(interactionId);
      notifyInteractionCancelled(session, interactionId, 'timeout');
      decline();
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(interactionId, {
      type: 'elicitation',
      toolCallId: interactionId,
      startedAt,
      snapshot: {
        serverName: request.serverName,
        message: request.message,
        mode: request.mode,
        url: request.url,
        elicitationId: request.elicitationId,
        requestedSchema: request.requestedSchema,
      },
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
      return handleAskUserQuestion(session, context.toolUseID, input, context.signal);
    }

    if (READ_ONLY_TOOLS.has(toolName) || DORKOS_AGENT_TOOLS.has(toolName)) {
      logFn('[canUseTool] auto-allow safe tool', { toolName, toolUseID: context.toolUseID });
      return { behavior: 'allow', updatedInput: input };
    }

    if (session.permissionMode === 'default' || session.permissionMode === 'auto') {
      logFn('[canUseTool] requesting approval', {
        toolName,
        permissionMode: session.permissionMode,
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
      notifyInteractionCancelled(session, toolUseId, 'aborted');
      deny('Tool approval aborted');
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      context.signal.removeEventListener('abort', onAbort);
      session.pendingInteractions.delete(toolUseId);
      notifyInteractionCancelled(session, toolUseId, 'timeout');
      deny(`Tool approval timed out after ${timeoutMinutes} minutes`);
    }, SESSIONS.INTERACTION_TIMEOUT_MS);

    session.pendingInteractions.set(toolUseId, {
      type: 'approval',
      toolCallId: toolUseId,
      suggestions: context.suggestions,
      startedAt,
      snapshot: {
        toolName,
        input: JSON.stringify(input),
        title: context.title,
        displayName: context.displayName,
        description: context.description,
        blockedPath: context.blockedPath,
        decisionReason: context.decisionReason,
        hasSuggestions: (context.suggestions?.length ?? 0) > 0,
      },
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
