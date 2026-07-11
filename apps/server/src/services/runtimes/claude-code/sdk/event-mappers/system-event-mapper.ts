import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, MemoryRecallEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from '../../agent-types.js';
import { logger } from '../../../../../lib/logger.js';

/** Hook events that correlate to a specific tool call and render inside ToolCallCard. */
const TOOL_CONTEXTUAL_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/**
 * Map a `system` SDK message (init plus every subtype) to zero or more StreamEvents.
 *
 * Covers session init, background-task lifecycle, status, memory recall, compaction,
 * SDK session-state changes, MCP elicitation completion, API retries, and hook events.
 * Mutates `session` (sdkSessionId/hasStarted/memoryPaths) and reads `toolState` for hook
 * correlation. Unknown subtypes are logged for diagnostics and yield nothing.
 *
 * @param message - The `system` SDK message to map.
 * @param session - In-memory session state (mutated for init and memory recall).
 * @param sessionId - DorkOS session identifier (stamped onto init session_status).
 * @param toolState - Mutable tool tracking state, read for hook tool-call correlation.
 */
export async function* mapSystemEvent(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState
): AsyncGenerator<StreamEvent> {
  // Handle system/init messages
  if ('subtype' in message && message.subtype === 'init') {
    session.sdkSessionId = message.session_id;
    session.hasStarted = true;
    const initModel = (message as Record<string, unknown>).model as string | undefined;
    if (initModel) {
      yield {
        type: 'session_status',
        data: { sessionId, model: initModel },
      };
    }
    return;
  }

  // Handle background task lifecycle messages (task_started, task_progress, task_notification)
  if ('subtype' in message) {
    if (message.subtype === 'task_started') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'background_task_started',
        data: {
          taskId: msg.task_id as string,
          taskType: message.session_id ? ('agent' as const) : ('bash' as const),
          startedAt: Date.now(),
          subagentSessionId: message.session_id,
          command: message.session_id ? undefined : (msg.command as string | undefined),
          toolUseId: msg.tool_use_id as string | undefined,
          description: msg.description as string,
        },
      };
      return;
    }

    if (message.subtype === 'task_progress') {
      const msg = message as Record<string, unknown>;
      const usage = msg.usage as { tool_uses: number; duration_ms: number };
      yield {
        type: 'background_task_progress',
        data: {
          taskId: msg.task_id as string,
          toolUses: usage.tool_uses,
          lastToolName: msg.last_tool_name as string | undefined,
          durationMs: usage.duration_ms,
          summary: msg.summary as string | undefined,
        },
      };
      return;
    }

    if (message.subtype === 'task_notification') {
      const msg = message as Record<string, unknown>;
      const usage = msg.usage as { tool_uses: number; duration_ms: number } | undefined;
      yield {
        type: 'background_task_done',
        data: {
          taskId: msg.task_id as string,
          status: msg.status as 'completed' | 'failed' | 'stopped',
          summary: msg.summary as string | undefined,
          toolUses: usage?.tool_uses,
          durationMs: usage?.duration_ms,
        },
      };
      return;
    }

    // Handle system status messages. Compaction lifecycle maps to the
    // runtime-agnostic `operation_progress` contract (DOR-110): the in-flight
    // `status: 'compacting'` opens an indeterminate operation (the SDK exposes no
    // percent — parity with the CLI's own indeterminate bar), and the resolving
    // status carrying `compact_result`/`compact_error` closes it done/failed.
    // Every OTHER status (`'requesting'`, permission-mode changes, generic
    // tokens) stays on the generic `system_status` channel.
    if (message.subtype === 'status') {
      const msg = message as Record<string, unknown>;
      const status = msg.status as string | undefined;
      const text = (msg.body as string) ?? (msg.message as string) ?? '';
      const compactResult = msg.compact_result as 'success' | 'failed' | undefined;
      const compactError = msg.compact_error as string | undefined;

      // Compaction start.
      if (status === 'compacting') {
        yield {
          type: 'operation_progress',
          data: {
            operation: 'compaction',
            state: 'started',
            determinate: false,
            message: 'Compacting context…',
          },
        };
        return;
      }

      // Compaction resolution. Success ALSO fires a separate `compact_boundary`
      // (the durable transcript row); this `done` just clears the live strip.
      // Failure fires NO boundary, so this `failed` carries the error surface.
      if (compactResult !== undefined) {
        yield {
          type: 'operation_progress',
          data: {
            operation: 'compaction',
            state: compactResult === 'failed' ? 'failed' : 'done',
            determinate: false,
            ...(compactError ? { error: compactError } : {}),
          },
        };
        return;
      }

      // Generic (non-compaction) status.
      if (text || status) {
        yield {
          type: 'system_status',
          data: {
            message: text || (status ? `Status: ${status}` : ''),
            ...(status ? { status } : {}),
          },
        };
      }
      return;
    }

    // Handle memory recall events (SDK 0.2.105+)
    if (message.subtype === 'memory_recall') {
      const msg = message as Record<string, unknown>;
      const mode = msg.mode as MemoryRecallEvent['mode'];
      const memories = (msg.memories as MemoryRecallEvent['memories'] | undefined) ?? [];
      const paths = memories.map((m) => m.path).filter((p): p is string => Boolean(p));
      if (paths.length > 0) {
        session.memoryPaths = Array.from(new Set([...(session.memoryPaths ?? []), ...paths]));
      }
      yield {
        type: 'memory_recall',
        data: { mode, memories },
      };
      return;
    }

    // Handle compact boundary (context window compaction occurred). Forward the
    // SDK's `compact_metadata` (camelCased) so a renderer can show "Compacted —
    // N tokens summarized (manual/auto)". Each field is forwarded only when
    // present, so a malformed boundary still validates as `{}` (DOR-108).
    if (message.subtype === 'compact_boundary') {
      const meta = (message as Record<string, unknown>).compact_metadata as
        | {
            trigger?: 'manual' | 'auto';
            pre_tokens?: number;
            post_tokens?: number;
            duration_ms?: number;
          }
        | undefined;
      yield {
        type: 'compact_boundary',
        data: {
          ...(meta?.trigger !== undefined ? { trigger: meta.trigger } : {}),
          ...(meta?.pre_tokens !== undefined ? { preTokens: meta.pre_tokens } : {}),
          ...(meta?.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {}),
          ...(meta?.duration_ms !== undefined ? { durationMs: meta.duration_ms } : {}),
        },
      };
      return;
    }

    // Mid-session command-list changes (`commands_changed`) replace the runtime
    // command cache so `/api/commands` stays fresh without a restart. That update
    // needs the RuntimeCache, which this pure mapper does not hold, so it is wired
    // in the message-sender stream loop (DOR-108). Swallow here to keep the
    // unhandled-subtype debug log quiet.
    if (message.subtype === 'commands_changed') {
      return;
    }

    // Handle SDK session state changes (idle/running/requires_action)
    if (message.subtype === 'session_state_changed') {
      const msg = message as Record<string, unknown>;
      const state = msg.state as 'idle' | 'running' | 'requires_action';
      yield {
        type: 'session_state_changed' as const,
        data: { state },
      };
      return;
    }

    // Handle MCP elicitation completion (URL-mode auth confirmed by MCP server)
    if (message.subtype === 'elicitation_complete') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'elicitation_complete',
        data: {
          serverName: msg.mcp_server_name as string,
          elicitationId: msg.elicitation_id as string,
        },
      };
      return;
    }

    // Handle API retry events (SDK 0.2.77+)
    if (message.subtype === 'api_retry') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'api_retry',
        data: {
          attempt: msg.attempt as number,
          maxRetries: msg.max_retries as number,
          retryDelayMs: msg.retry_delay_ms as number,
          errorStatus: (msg.error_status as number) ?? null,
        },
      };
      return;
    }

    // Handle classifier/SDK tool denials (e.g. auto-mode safety classifier).
    // The SDK resolves these before `canUseTool` is reached, so we surface them
    // as a read-only denial chip rather than an approval card.
    if (message.subtype === 'permission_denied') {
      const msg = message as Record<string, unknown>;
      yield {
        type: 'permission_denied',
        data: {
          toolCallId: msg.tool_use_id as string,
          toolName: msg.tool_name as string,
          reasonType: msg.decision_reason_type as string | undefined,
          reason: msg.decision_reason as string | undefined,
          message: msg.message as string,
        },
      };
      return;
    }

    // Live thinking-token estimate emitted during the redacted/omitted thinking phase
    // (the API streams only pings, so the SDK digests their token estimates into this
    // message). We render thinking from `thinking_delta` text instead — and force
    // `display: 'summarized'` so that text actually streams (see thinking-config.ts) —
    // so these carry no UI value here. Swallow them to keep the catch-all log quiet.
    if (message.subtype === 'thinking_tokens') {
      return;
    }

    // Handle hook lifecycle events
    if (message.subtype === 'hook_started') {
      const msg = message as Record<string, unknown>;
      const hookEvent = msg.hook_event as string;
      const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

      if (isToolContextual) {
        yield {
          type: 'hook_started',
          data: {
            hookId: msg.hook_id as string,
            hookName: msg.hook_name as string,
            hookEvent,
            toolCallId: toolState.currentToolId || null,
          },
        };
      } else {
        yield {
          type: 'system_status',
          data: { message: `Running hook "${msg.hook_name as string}"...` },
        };
      }
      return;
    }

    if (message.subtype === 'hook_progress') {
      const msg = message as Record<string, unknown>;
      const hookEvent = msg.hook_event as string;
      const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

      if (isToolContextual) {
        yield {
          type: 'hook_progress',
          data: {
            hookId: msg.hook_id as string,
            stdout: msg.stdout as string,
            stderr: msg.stderr as string,
          },
        };
      }
      // Session-level progress: silent (no useful output to show mid-execution)
      return;
    }

    if (message.subtype === 'hook_response') {
      const msg = message as Record<string, unknown>;
      const hookEvent = msg.hook_event as string;
      const isToolContextual = TOOL_CONTEXTUAL_HOOK_EVENTS.has(hookEvent);

      if (isToolContextual) {
        yield {
          type: 'hook_response',
          data: {
            hookId: msg.hook_id as string,
            hookName: msg.hook_name as string,
            exitCode: msg.exit_code as number | undefined,
            outcome: msg.outcome as 'success' | 'error' | 'cancelled',
            stdout: msg.stdout as string,
            stderr: msg.stderr as string,
          },
        };
      } else if ((msg.outcome as string) === 'error') {
        // Session-level failure: escalate to persistent error
        yield {
          type: 'error',
          data: {
            message: `Hook "${msg.hook_name as string}" failed (${hookEvent})`,
            code: 'hook_failure',
            category: 'execution_error',
            details: (msg.stderr as string) || (msg.stdout as string),
          },
        };
      }
      // Session-level success: silent (already shown via system_status on start)
      return;
    }
  }

  // Catch-all: log unhandled system subtypes for debugging (moved from the dispatcher).
  logger.debug(
    'Unhandled SDK message type: %s (subtype: %s)',
    message.type,
    'subtype' in message ? (message as Record<string, unknown>).subtype : 'none'
  );
}
