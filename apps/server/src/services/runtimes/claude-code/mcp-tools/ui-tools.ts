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
import { z } from 'zod';
import { UiCommandSchema } from '@dorkos/shared/schemas';
import type { UiState, StreamEvent } from '@dorkos/shared/types';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Default UI state returned when no client-reported state exists on the session. */
const DEFAULT_UI_STATE: UiState = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, pulse: false, relay: false, mesh: false },
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

/** Tool description for control_ui (shared between stub and session-bound). */
const CONTROL_UI_DESCRIPTION = `Control the DorkOS client UI. Actions:
- open_panel / close_panel / toggle_panel: { panel: "settings"|"pulse"|"relay"|"mesh"|"picker" }
- open_sidebar / close_sidebar
- switch_sidebar_tab: { tab: "overview"|"sessions"|"schedules"|"connections" }
- open_canvas: { content: { type: "url"|"markdown"|"json", ... }, preferredWidth?: 20-80 }
- update_canvas: { content: { type: "url"|"markdown"|"json", ... } }
- close_canvas
- show_toast: { message: string, level?: "success"|"error"|"info"|"warning", description?: string }
- set_theme: { theme: "light"|"dark" }
- scroll_to_message: { messageId?: string } (omit for bottom)
- switch_agent: { cwd: string }
- open_command_palette`;

/** Shared input schema for control_ui tool. */
const CONTROL_UI_INPUT = {
  action: z.string().describe('The UI action to perform'),
  panel: z.string().optional().describe('Panel ID for panel commands'),
  tab: z.string().optional().describe('Tab name for switch_sidebar_tab'),
  content: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Canvas content for open_canvas/update_canvas'),
  preferredWidth: z.number().optional().describe('Canvas width percentage (20-80) for open_canvas'),
  message: z.string().optional().describe('Toast message for show_toast'),
  level: z.string().optional().describe('Toast level for show_toast'),
  description: z.string().optional().describe('Toast description for show_toast'),
  theme: z.string().optional().describe('Theme for set_theme'),
  messageId: z.string().optional().describe('Message ID for scroll_to_message'),
  cwd: z.string().optional().describe('Working directory for switch_agent'),
} as const;

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
