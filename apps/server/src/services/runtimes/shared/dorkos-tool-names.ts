/**
 * How the DorkOS MCP server and its tools are NAMED, on every runtime that
 * reaches them.
 *
 * A leaf module with no imports, and deliberately so. These names are needed by
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

/**
 * The name the DorkOS MCP server is registered under, on every runtime.
 *
 * Load-bearing three times over: it is what `createSdkMcpServer` is given
 * in-session, it is the key the codex/opencode injection writes, and it is the
 * middle of every tool name the model sees. Both injecting runtimes reserve it,
 * so a user's own server cannot occupy it.
 */
export const DORKOS_MCP_SERVER_NAME = 'dorkos';

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
