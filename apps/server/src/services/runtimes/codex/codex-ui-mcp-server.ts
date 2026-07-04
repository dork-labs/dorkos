/**
 * Scoped external MCP server that exposes ONLY the DorkOS `control_ui` tool to
 * Codex, giving Codex agents canvas parity with Claude Code.
 *
 * WHY THIS EXISTS: opening the canvas is a runtime-neutral pipeline — an agent
 * calls `control_ui`, which pushes a `ui_command` StreamEvent that the server
 * normalizes → SSE → the client's `executeUiCommand`. Claude Code reaches it
 * through the in-process DorkOS MCP tool server, but the Codex SDK accepts only
 * EXTERNAL MCP servers declared via `CodexOptions.config`. This server is that
 * external surface, mounted at a loopback endpoint the Codex runtime points at.
 *
 * The `control_ui` handler here is a deliberate STUB: it has no session in
 * scope, so it produces no UI effect and just echoes `{ success, action }`. The
 * REAL effect is produced downstream in the Codex event-mapper
 * ({@link ./event-mapper}), which intercepts the resulting `mcp_tool_call` item
 * (server `dorkos_ui`, tool `control_ui`) inside the turn loop — where the
 * session IS in scope — and translates it into a `ui_command` StreamEvent.
 *
 * `get_ui_state` is intentionally NOT exposed: a session-less stub would return
 * a misleading default UI state.
 *
 * @module services/runtimes/codex/codex-ui-mcp-server
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT } from '../shared/ui-tool-contract.js';

/**
 * Name of the scoped Codex UI MCP server. Shared by the event-mapper (to
 * recognize which `mcp_tool_call` items to translate) and the runtime's
 * `CodexOptions.config` (to declare the server to the Codex CLI).
 */
export const CODEX_UI_MCP_SERVER = 'dorkos_ui';

/**
 * Wrap a value as an MCP JSON content result. A tiny local copy of the
 * claude-code `jsonContent` helper, kept here so the Codex module graph imports
 * nothing from `claude-code/` and never transitively loads the Claude SDK. This
 * mirrors the existing local copies in `marketplace-mcp/`.
 */
function jsonContent(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Build the scoped MCP server exposing only `control_ui`.
 *
 * Reuses {@link CONTROL_UI_DESCRIPTION} and {@link CONTROL_UI_INPUT} so the tool
 * contract is byte-for-byte identical to Claude Code's `control_ui`. The
 * handler is a side-effect-free stub — see the module doc — because the actual
 * `ui_command` emission happens in the event-mapper where the session is bound.
 */
export function createCodexUiMcpServer(): McpServer {
  const server = new McpServer({ name: CODEX_UI_MCP_SERVER, version: '1.0.0' });

  server.tool('control_ui', CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT, async (input) =>
    jsonContent({ success: true, action: input.action })
  );

  return server;
}
