/**
 * How the DorkOS MCP server and its tools are NAMED, on every runtime that
 * reaches them.
 *
 * A leaf module that imports only the shared package, and deliberately so. The
 * server's name itself lives in `@dorkos/shared/global-mcp-schemas`, beside the
 * reserved list the app's Name field reads too. These names are needed by
 * three places that must not depend on each other: the claude-code in-session
 * server that registers under the name, the codex/opencode injection that dials
 * it over HTTP, and the shared prompt block that has to spell a tool the way the
 * session's own runtime exposes it. Keeping them here means one definition
 * instead of a copy per consumer — the copy is how `dorkos` and `mcp__dorkos__`
 * drift apart, and a drifted prefix produces tool names that are silently
 * uncallable (DOR-1292).
 *
 * @module services/runtimes/shared/dorkos-tool-names
 */
import { DORKOS_TOOL_SERVER_NAME } from '@dorkos/shared/global-mcp-schemas';

/**
 * The name the DorkOS MCP server is registered under, on every runtime.
 *
 * Load-bearing three times over: it is what `createSdkMcpServer` is given
 * in-session, it is the key the codex/opencode injection writes, and it is the
 * middle of every tool name the model sees. It is on the one reserved list
 * (`RESERVED_MCP_SERVER_NAMES`), so no other server can occupy it (DOR-3600).
 */
export const DORKOS_MCP_SERVER_NAME = DORKOS_TOOL_SERVER_NAME;

/**
 * What Codex puts in front of a `dorkos` MCP tool name.
 *
 * Codex qualifies plugin-provided MCP tools as `mcp__server__tool` — stated in
 * its own system prompt, and already the convention the codex event mapper
 * reproduces when it maps an `mcp_tool_call` into a StreamEvent. Identical to
 * claude-code's prefix, which is a coincidence of convention rather than a
 * shared mechanism, so it is spelled separately.
 */
export const CODEX_DORKOS_TOOL_PREFIX = `mcp__${DORKOS_MCP_SERVER_NAME}__`;

/**
 * What OpenCode puts in front of a `dorkos` MCP tool name.
 *
 * OpenCode composes `sanitize(server) + "_" + sanitize(tool)` and hands that key
 * straight to the model as the callable function name — one underscore, and no
 * `mcp` marker at all. Neither `dorkos` nor any DorkOS tool name contains a
 * character its sanitizer rewrites, so the result is exactly this
 * concatenation.
 */
export const OPENCODE_DORKOS_TOOL_PREFIX = `${DORKOS_MCP_SERVER_NAME}_`;

/**
 * What Claude Code puts in front of a `dorkos` MCP tool name: `mcp__server__tool`.
 * The in-session server's `IN_SESSION_TOOL_PREFIX` is this value.
 */
export const CLAUDE_CODE_DORKOS_TOOL_PREFIX = `mcp__${DORKOS_MCP_SERVER_NAME}__` as const;

/**
 * Spell any MCP tool the way one runtime's model has to call it.
 *
 * A registered name may carry a character a model-facing tool name may not, and
 * every runtime rewrites it to `_` before the model sees it: the connection
 * tools register as `connectors.list_granted_connections` and are called
 * `…connectors_list_granted_connections` everywhere (DOR-4112). Claude Code and
 * OpenCode keep `-`; Codex's Responses API rewrites that too. No DorkOS server or
 * tool name carries a `-`, so the difference never shows, but it is kept exact.
 *
 * @param runtime - The runtime whose qualifying rule applies.
 * @param server - The MCP server the tool is registered on.
 * @param tool - The tool's registered name on that server.
 */
export function mcpToolNameFor(
  runtime: 'claude-code' | 'codex' | 'opencode',
  server: string,
  tool: string
): string {
  if (runtime === 'opencode') {
    const clean = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${clean(server)}_${clean(tool)}`;
  }
  const clean = (part: string) =>
    part.replace(runtime === 'codex' ? /[^a-zA-Z0-9_]/g : /[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`;
}

/**
 * Spell a `dorkos` server tool the way one runtime's model has to call it; a
 * bare name in prose is a name the model cannot call (DOR-1292).
 *
 * @param runtime - The runtime whose prefix applies.
 * @param tool - The tool's registered name on the `dorkos` server.
 */
export function dorkosToolNameFor(
  runtime: 'claude-code' | 'codex' | 'opencode' | 'doe' | 'computer-local',
  tool: string
): string {
  if (runtime === 'doe') return tool;
  const prefix =
    runtime === 'opencode' || runtime === 'computer-local'
      ? OPENCODE_DORKOS_TOOL_PREFIX
      : runtime === 'codex'
        ? CODEX_DORKOS_TOOL_PREFIX
        : CLAUDE_CODE_DORKOS_TOOL_PREFIX;
  return `${prefix}${tool}`;
}
