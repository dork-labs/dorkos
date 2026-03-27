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
  sidebar: { open: true, activeTab: 'sessions' },
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

/** Returns the UI control tool definitions for registration with the MCP server. */
export function getUiTools(_deps: McpToolDeps) {
  // These tools need session context at call time, so they use a deferred
  // session binding pattern. The actual handlers are created per-session in
  // the interactive-handlers layer. Here we register stub tools that return
  // helpful guidance — the real execution is wired through canUseTool.
  return [
    tool(
      'control_ui',
      `Control the DorkOS client UI. Actions:
- open_panel / close_panel / toggle_panel: { panel: "settings"|"pulse"|"relay"|"mesh"|"picker" }
- open_sidebar / close_sidebar
- switch_sidebar_tab: { tab: "sessions"|"agents" }
- open_canvas: { content: { type: "url"|"markdown"|"json", ... }, preferredWidth?: 20-80 }
- update_canvas: { content: { type: "url"|"markdown"|"json", ... } }
- close_canvas
- show_toast: { message: string, level?: "success"|"error"|"info"|"warning", description?: string }
- set_theme: { theme: "light"|"dark" }
- scroll_to_message: { messageId?: string } (omit for bottom)
- switch_agent: { cwd: string }
- open_command_palette`,
      {
        action: z.string().describe('The UI action to perform'),
        panel: z.string().optional().describe('Panel ID for panel commands'),
        tab: z.string().optional().describe('Tab name for switch_sidebar_tab'),
        content: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Canvas content for open_canvas/update_canvas'),
        preferredWidth: z
          .number()
          .optional()
          .describe('Canvas width percentage (20-80) for open_canvas'),
        message: z.string().optional().describe('Toast message for show_toast'),
        level: z.string().optional().describe('Toast level for show_toast'),
        description: z.string().optional().describe('Toast description for show_toast'),
        theme: z.string().optional().describe('Theme for set_theme'),
        messageId: z.string().optional().describe('Message ID for scroll_to_message'),
        cwd: z.string().optional().describe('Working directory for switch_agent'),
      },
      async (input) => {
        // This stub handler is the fallback — the real execution happens via
        // the canUseTool hook which intercepts control_ui calls, validates
        // through UiCommandSchema, and emits events to the session queue.
        return jsonContent({ success: true, action: input.action });
      }
    ),
    tool(
      'get_ui_state',
      'Get the current DorkOS UI state — which panels are open, sidebar tab, canvas state, and active agent. Use after control_ui to verify the result, or to make UI decisions based on current state.',
      {},
      async () => {
        // Stub — real execution is wired through canUseTool with session access.
        return jsonContent(DEFAULT_UI_STATE);
      }
    ),
  ];
}
