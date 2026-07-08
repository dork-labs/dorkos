/**
 * MCP tools for agent-driven UI control and UI state queries.
 *
 * `control_ui` validates a UiCommand via Zod and emits a `ui_command` SSE event
 * to the active session's event queue.
 *
 * `get_ui_state` returns the session's stored UI state (or a default when none is set).
 *
 * @module services/runtimes/claude-code/mcp-tools/ui-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { UiCommandSchema } from '@dorkos/shared/schemas';
import type { UiState, StreamEvent } from '@dorkos/shared/types';
import { CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT } from '../../shared/ui-tool-contract.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Default UI state returned when no client-reported state exists on the session. */
const DEFAULT_UI_STATE: UiState = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, tasks: false, relay: false },
  sidebar: { open: true, activeTab: 'overview' },
  agent: { id: null, cwd: null },
};

/**
 * Minimal session interface needed by UI tool handlers.
 * Matches the subset of `AgentSession` that event-emitting tools require.
 */
export interface UiToolSession {
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
  uiState?: UiState;
  /**
   * Session working directory. Used to resolve the session's trusted Relay
   * sender identity (see `resolveSenderIdentity`) so relay tools inject a
   * server-derived `from` rather than trusting the LLM.
   */
  cwd?: string;
}

/**
 * Create the `control_ui` tool handler.
 * Validates the command against UiCommandSchema, emits a `ui_command` SSE event
 * to the session's event queue, and returns confirmation to the agent.
 *
 * @param session - The active session to emit events on (bound at tool creation)
 */
export function createControlUiHandler(session: UiToolSession) {
  return async (args: Record<string, unknown>) => {
    const parsed = UiCommandSchema.safeParse(args);
    if (!parsed.success) {
      return jsonContent({ error: 'Invalid UI command', details: parsed.error.issues }, true);
    }

    const command = parsed.data;

    // Emit the command as a ui_command StreamEvent to the SSE stream
    session.eventQueue.push({
      type: 'ui_command',
      data: { command },
    } as StreamEvent);
    session.eventQueueNotify?.();

    return jsonContent({ success: true, action: command.action });
  };
}

/**
 * Create the `get_ui_state` tool handler.
 * Returns the client-reported UI state stored on the session, or defaults.
 *
 * @param session - The active session whose uiState to read (bound at tool creation)
 */
export function createGetUiStateHandler(session: UiToolSession) {
  return async () => {
    return jsonContent(session.uiState ?? DEFAULT_UI_STATE);
  };
}

/**
 * Returns the UI control tool definitions for registration with the MCP server.
 *
 * When `session` is provided (per-query), tool handlers emit real SSE events
 * and read actual UI state. Without a session, stub handlers return defaults
 * (used only for the external MCP server at `/mcp`).
 *
 * @param _deps - Shared tool dependencies (unused by UI tools)
 * @param session - Per-query session for event emission and state access
 */
export function getUiTools(_deps: McpToolDeps, session?: UiToolSession) {
  const controlUiHandler = session
    ? createControlUiHandler(session)
    : async (input: Record<string, unknown>) =>
        jsonContent({ success: true, action: (input as { action: string }).action });

  const getUiStateHandler = session
    ? createGetUiStateHandler(session)
    : async () => jsonContent(DEFAULT_UI_STATE);

  return [
    tool('control_ui', CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT, async (input) =>
      controlUiHandler(input)
    ),
    tool(
      'get_ui_state',
      'Get the current DorkOS UI state — which panels are open, sidebar tab, canvas state, and active agent. Use after control_ui to verify the result, or to make UI decisions based on current state.',
      {},
      async () => getUiStateHandler()
    ),
  ];
}
