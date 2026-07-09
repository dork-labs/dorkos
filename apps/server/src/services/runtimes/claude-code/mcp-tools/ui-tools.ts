/**
 * MCP tools for agent-driven UI control and UI state queries.
 *
 * `control_ui` validates a UiCommand via Zod, emits a `ui_command` SSE event to
 * the active session's event queue, and optimistically folds the command's
 * deterministic effect into `session.uiState` so a same-turn `get_ui_state`
 * reflects it.
 *
 * `get_ui_state` returns the session's stored UI state (or a default when none is
 * set): the last client-reported snapshot merged with the commands issued this
 * turn.
 *
 * @module services/runtimes/claude-code/mcp-tools/ui-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { UiCommandSchema } from '@dorkos/shared/schemas';
import type { UiState, UiCommand, StreamEvent } from '@dorkos/shared/types';
import { CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT } from '../../shared/ui-tool-contract.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Default UI state returned when no client-reported state exists on the session. */
const DEFAULT_UI_STATE: UiState = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, tasks: false, relay: false, picker: false },
  sidebar: { open: true, activeTab: 'overview' },
  agent: { id: null, cwd: null },
};

/**
 * Error result returned by the session-less tool variants. Registering `control_ui`
 * / `get_ui_state` without a bound session (e.g. an external MCP surface with no
 * interactive client) must not pretend to succeed — there is no UI to control or
 * read.
 */
const SESSIONLESS_UI_ERROR = {
  error: 'control_ui and get_ui_state require an attached interactive session',
  detail:
    'These tools mutate/read a live DorkOS client UI bound to a specific session. ' +
    'The current MCP surface has no session attached, so there is no UI to control or report.',
};

/** Deep clone of {@link DEFAULT_UI_STATE} — the seed when a session has no prior snapshot. */
function cloneDefaultUiState(): UiState {
  return structuredClone(DEFAULT_UI_STATE);
}

/**
 * Fold a validated {@link UiCommand}'s deterministic effect into a UI-state
 * snapshot, returning a new state. Mirrors the client dispatcher's state writes
 * (`ui-action-dispatcher`) for the commands that change persistent UI state;
 * commands with no lasting state effect (toast, theme, scroll, command palette)
 * return the state unchanged.
 *
 * This is a best-effort projection: the client can still diverge (edit-protection
 * deferral, or no client attached — see the tool description), so the result is
 * "what the command asked for", not a guaranteed read of the live client.
 *
 * @param state - The current UI-state snapshot.
 * @param command - The validated command to apply.
 */
function applyUiCommandToState(state: UiState, command: UiCommand): UiState {
  switch (command.action) {
    case 'open_panel':
      return { ...state, panels: { ...state.panels, [command.panel]: true } };
    case 'close_panel':
      return { ...state, panels: { ...state.panels, [command.panel]: false } };
    case 'toggle_panel':
      return {
        ...state,
        panels: { ...state.panels, [command.panel]: !state.panels[command.panel] },
      };
    case 'open_sidebar':
      return { ...state, sidebar: { ...state.sidebar, open: true } };
    case 'close_sidebar':
      return { ...state, sidebar: { ...state.sidebar, open: false } };
    case 'switch_sidebar_tab':
      // The dispatcher also opens the sidebar when switching tabs.
      return { ...state, sidebar: { open: true, activeTab: command.tab } };
    case 'open_canvas':
      return {
        ...state,
        canvas: { open: true, contentType: command.content?.type ?? state.canvas.contentType },
      };
    case 'update_canvas':
      return { ...state, canvas: { ...state.canvas, contentType: command.content.type } };
    case 'open_file':
      // Opening a file surfaces it as a canvas document, so the canvas opens
      // with a file viewer active — mirrors the client dispatcher's revealCanvas.
      return { ...state, canvas: { open: true, contentType: 'file' } };
    case 'open_terminal':
      // The terminal is a right-panel tab, not a canvas document; it has no
      // canvas contentType. There is no server-projected panel/tab field beyond
      // canvas today, so the deterministic effect is a no-op on this snapshot —
      // the client reveals and focuses the Terminal tab (best-effort, web-only).
      return state;
    case 'browser_navigate':
      // Opening a URL adds a `browser` canvas document and reveals the canvas.
      return { ...state, canvas: { open: true, contentType: 'browser' } };
    case 'close_canvas':
      return { ...state, canvas: { ...state.canvas, open: false } };
    case 'switch_agent':
      return { ...state, agent: { ...state.agent, cwd: command.cwd } };
    default:
      // show_toast, set_theme, scroll_to_message, open_command_palette — no
      // persistent UI-state effect to project.
      return state;
  }
}

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
 * to the session's event queue, optimistically projects the command's effect
 * onto `session.uiState`, and returns confirmation to the agent.
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

    // Optimistically fold the command's deterministic effect into the session's
    // UI-state snapshot so a same-turn `get_ui_state` reflects it. The client
    // only reports its state at turn start, so without this the "verify with
    // get_ui_state" advice would answer with pre-command state. Best-effort:
    // edit-protection deferral or a headless session can make the real client
    // diverge (see CONTROL_UI_DESCRIPTION notes).
    session.uiState = applyUiCommandToState(session.uiState ?? cloneDefaultUiState(), command);

    return jsonContent({ success: true, action: command.action });
  };
}

/**
 * Create the `get_ui_state` tool handler.
 * Returns the client-reported UI state stored on the session (merged with any
 * commands issued this turn), or defaults when the client has reported nothing.
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
 * When `session` is provided (per-query), tool handlers emit real SSE events,
 * project UI state, and read actual state. Without a session there is no UI to
 * control — both tools return an MCP error result rather than falsely reporting
 * success or a fabricated default state.
 *
 * @param _deps - Shared tool dependencies (unused by UI tools)
 * @param session - Per-query session for event emission and state access
 */
export function getUiTools(_deps: McpToolDeps, session?: UiToolSession) {
  const controlUiHandler = session
    ? createControlUiHandler(session)
    : async (input: Record<string, unknown>) =>
        jsonContent(
          { ...SESSIONLESS_UI_ERROR, action: (input as { action?: string }).action },
          true
        );

  const getUiStateHandler = session
    ? createGetUiStateHandler(session)
    : async () => jsonContent(SESSIONLESS_UI_ERROR, true);

  return [
    tool('control_ui', CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT, async (input) =>
      controlUiHandler(input)
    ),
    tool(
      'get_ui_state',
      'Get the current DorkOS UI state — which panels are open, sidebar tab, canvas state, and active agent. Reflects the last state the client reported (at the start of this turn) merged with the control_ui commands issued this turn; it is not a live read of the client. Use it after control_ui to confirm intent, or to make UI decisions.',
      {},
      async () => getUiStateHandler()
    ),
  ];
}
